import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { FlockError } from "../shared/errors.ts";

type CredentialFile = Record<string, Credential>;

export function defaultPiCredentialPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

export class PiCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(path = defaultPiCredentialPath()) {
    this.path = path;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.readFile())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.readFile()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.withLock(async () => {
      const credentials = await this.readFile();
      const current = credentials[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      credentials[providerId] = next;
      await this.writeFile(credentials);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.withLock(async () => {
      const credentials = await this.readFile();
      if (!(providerId in credentials)) return;
      delete credentials[providerId];
      await this.writeFile(credentials);
    });
  }

  private async readFile(): Promise<CredentialFile> {
    try {
      const info = await stat(this.path);
      if (platform() !== "win32" && (info.mode & 0o077) !== 0) {
        throw new FlockError(
          "pi_auth_permissions",
          `Pi credential file ${this.path} must not be readable by group or other users`,
        );
      }
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isCredentialFile(parsed)) {
        throw new FlockError("pi_auth_invalid", `Pi credential file ${this.path} is invalid`);
      }
      return parsed;
    } catch (error) {
      if (isMissingFileError(error)) return {};
      throw error;
    }
  }

  private async writeFile(credentials: CredentialFile): Promise<void> {
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.path);
    if (platform() !== "win32") await chmod(this.path, 0o600);
  }

  private async withLock<Value>(operation: () => Promise<Value>): Promise<Value> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.path, "a", 0o600);
    await handle.close();
    if (platform() !== "win32") await chmod(this.path, 0o600);
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 15_000,
      retries: { retries: 5, minTimeout: 25, maxTimeout: 200 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

function isCredentialFile(value: unknown): value is CredentialFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((credential) => {
    if (typeof credential !== "object" || credential === null || Array.isArray(credential)) return false;
    const type = (credential as { type?: unknown }).type;
    return type === "api_key" || type === "oauth";
  });
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
