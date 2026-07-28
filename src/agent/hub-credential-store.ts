import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { FlockError } from "../shared/errors.ts";

type CredentialEnvelope = {
  providerId: string;
  credential: Credential;
  version: number;
};

export class HubCredentialStore implements CredentialStore {
  private readonly hubUrl: string;
  private readonly token: string;

  constructor(hubUrl: string, token: string) {
    this.hubUrl = hubUrl;
    this.token = token;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const envelope = await this.fetchCredential();
    return envelope.providerId === providerId ? envelope.credential : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const envelope = await this.fetchCredential();
    return [{ providerId: envelope.providerId, type: envelope.credential.type }];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.fetchCredential();
      if (current.providerId !== providerId) return undefined;
      const next = await fn(current.credential);
      if (!next) return current.credential;
      const response = await fetch(new URL("/api/v1/agent/provider-credential", this.hubUrl), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: current.version, credential: next }),
      });
      if (response.status === 409) continue;
      if (!response.ok) throw await responseError(response);
      return next;
    }
    throw new FlockError("credential_version_conflict", "Provider credential changed repeatedly during refresh", 409);
  }

  async delete(): Promise<void> {
    throw new FlockError("credential_delete_denied", "Hosted agents cannot disconnect provider accounts", 403);
  }

  private async fetchCredential(): Promise<CredentialEnvelope> {
    const response = await fetch(new URL("/api/v1/agent/provider-credential", this.hubUrl), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as CredentialEnvelope;
  }
}

async function responseError(response: Response): Promise<FlockError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  return new FlockError(
    body.error?.code ?? "credential_request_failed",
    body.error?.message ?? `Credential service returned HTTP ${response.status}`,
    response.status,
  );
}
