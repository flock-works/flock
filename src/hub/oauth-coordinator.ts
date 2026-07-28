import {
  builtinModels,
} from "@earendil-works/pi-ai/providers/all";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { FlockError, toError } from "../shared/errors.ts";
import { createId } from "../shared/ids.ts";
import {
  type OAuthProviderId,
  type ProviderConnectionRecord,
  ControlDatabase,
} from "./control-db.ts";

export const OAUTH_PROVIDER_IDS = [
  "anthropic",
  "openai-codex",
  "github-copilot",
  "openrouter",
] as const satisfies readonly OAuthProviderId[];

export type OAuthFlowSnapshot = {
  id: string;
  providerId: OAuthProviderId;
  status: "running" | "completed" | "failed" | "cancelled";
  expiresAt: string;
  events: AuthEvent[];
  prompt:
    | {
        id: string;
        type: AuthPrompt["type"];
        message: string;
        placeholder?: string;
        options?: ReadonlyArray<{ id: string; label: string; description?: string }>;
      }
    | null;
  connection: ProviderConnectionRecord | null;
  error: string | null;
};

type PendingPrompt = {
  id: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

type Flow = OAuthFlowSnapshot & {
  userSub: string;
  label: string;
  controller: AbortController;
  pendingPrompt?: PendingPrompt;
  timer: NodeJS.Timeout;
};

class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, Credential>();

  async read(providerId: string): Promise<Credential | undefined> {
    return this.values.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.values].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const next = await fn(this.values.get(providerId));
    if (next) this.values.set(providerId, next);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    this.values.delete(providerId);
  }
}

export class OAuthCoordinator {
  private readonly database: ControlDatabase;
  private readonly login: (providerId: OAuthProviderId, interaction: AuthInteraction) => Promise<Credential>;
  private readonly flows = new Map<string, Flow>();
  private readonly activeProviders = new Map<OAuthProviderId, string>();

  constructor(
    database: ControlDatabase,
    login?: (providerId: OAuthProviderId, interaction: AuthInteraction) => Promise<Credential>,
  ) {
    this.database = database;
    this.login = login ?? defaultLogin;
  }

  catalog(): Array<{
    id: OAuthProviderId;
    name: string;
    models: Array<{ id: string; name: string }>;
  }> {
    const models = builtinModels();
    return OAUTH_PROVIDER_IDS.map((id) => {
      const provider = models.getProvider(id);
      return {
        id,
        name: provider?.name ?? id,
        models: models.getModels(id).map((model) => ({
          id: model.id,
          name: model.name,
        })),
      };
    });
  }

  start(input: {
    userSub: string;
    label: string;
    providerId: string;
  }): OAuthFlowSnapshot {
    if (!isOAuthProviderId(input.providerId)) {
      throw new FlockError("unsupported_provider", "This provider does not support hosted-agent OAuth", 400);
    }
    if (this.activeProviders.has(input.providerId)) {
      throw new FlockError(
        "oauth_flow_busy",
        "Another sign-in for this provider is already running; retry shortly",
        409,
      );
    }
    const id = createId("oauth");
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const controller = new AbortController();
    const flow: Flow = {
      id,
      userSub: input.userSub,
      label: input.label,
      providerId: input.providerId,
      status: "running",
      expiresAt,
      events: [],
      prompt: null,
      connection: null,
      error: null,
      controller,
      timer: setTimeout(() => this.cancelInternal(id, "OAuth flow expired"), 15 * 60_000),
    };
    flow.timer.unref();
    this.flows.set(id, flow);
    this.activeProviders.set(input.providerId, id);
    void this.run(flow);
    return snapshot(flow);
  }

  get(id: string, userSub: string): OAuthFlowSnapshot {
    return snapshot(this.requireOwnedFlow(id, userSub));
  }

  respond(id: string, userSub: string, promptId: string, value: string): OAuthFlowSnapshot {
    const flow = this.requireOwnedFlow(id, userSub);
    const pending = flow.pendingPrompt;
    if (!pending || pending.id !== promptId || !flow.prompt) {
      throw new FlockError("oauth_prompt_stale", "This OAuth prompt is no longer active", 409);
    }
    flow.pendingPrompt = undefined;
    flow.prompt = null;
    pending.resolve(value);
    return snapshot(flow);
  }

  cancel(id: string, userSub: string): OAuthFlowSnapshot {
    const flow = this.requireOwnedFlow(id, userSub);
    this.cancelInternal(id, "OAuth flow cancelled");
    return snapshot(flow);
  }

  close(): void {
    for (const id of this.flows.keys()) this.cancelInternal(id, "Hub is shutting down");
    this.flows.clear();
    this.activeProviders.clear();
  }

  private async run(flow: Flow): Promise<void> {
    try {
      const credential = await this.login(flow.providerId, {
        signal: flow.controller.signal,
        notify: (event) => {
          flow.events.push(event);
          if (flow.events.length > 50) flow.events.shift();
        },
        prompt: async (prompt) => {
          const device = prompt.type === "select"
            ? prompt.options.find((option) => option.id.toLowerCase().includes("device"))
            : undefined;
          if (device) return device.id;
          const promptId = createId("prompt");
          flow.prompt = {
            id: promptId,
            type: prompt.type,
            message: prompt.message,
            ...("placeholder" in prompt && prompt.placeholder
              ? { placeholder: prompt.placeholder }
              : {}),
            ...(prompt.type === "select" ? { options: prompt.options } : {}),
          };
          return new Promise<string>((resolve, reject) => {
            const abort = () => reject(new Error("OAuth prompt cancelled"));
            prompt.signal?.addEventListener("abort", abort, { once: true });
            flow.pendingPrompt = {
              id: promptId,
              resolve: (value) => {
                prompt.signal?.removeEventListener("abort", abort);
                resolve(value);
              },
              reject,
            };
          });
        },
      });
      if (flow.controller.signal.aborted) return;
      flow.connection = this.database.upsertProviderConnection({
        userSub: flow.userSub,
        providerId: flow.providerId,
        label: flow.label,
        credential,
      });
      flow.status = "completed";
    } catch (error) {
      if (flow.controller.signal.aborted) {
        flow.status = "cancelled";
      } else {
        flow.status = "failed";
        flow.error = toError(error).message;
      }
    } finally {
      clearTimeout(flow.timer);
      flow.prompt = null;
      flow.pendingPrompt = undefined;
      this.activeProviders.delete(flow.providerId);
    }
  }

  private requireOwnedFlow(id: string, userSub: string): Flow {
    const flow = this.flows.get(id);
    if (!flow) throw new FlockError("oauth_flow_not_found", "OAuth flow not found", 404);
    if (flow.userSub !== userSub) throw new FlockError("forbidden", "This OAuth flow belongs to another user", 403);
    return flow;
  }

  private cancelInternal(id: string, message: string): void {
    const flow = this.flows.get(id);
    if (!flow || flow.status !== "running") return;
    flow.error = message;
    flow.status = "cancelled";
    flow.controller.abort();
    flow.pendingPrompt?.reject(new Error(message));
    flow.pendingPrompt = undefined;
    flow.prompt = null;
    clearTimeout(flow.timer);
    this.activeProviders.delete(flow.providerId);
  }
}

async function defaultLogin(
  providerId: OAuthProviderId,
  interaction: AuthInteraction,
): Promise<Credential> {
  const credentials = new MemoryCredentialStore();
  return builtinModels({ credentials }).login(providerId, "oauth", interaction);
}

function snapshot(flow: Flow): OAuthFlowSnapshot {
  return {
    id: flow.id,
    providerId: flow.providerId,
    status: flow.status,
    expiresAt: flow.expiresAt,
    events: [...flow.events],
    prompt: flow.prompt
      ? {
          ...flow.prompt,
          ...(flow.prompt.options ? { options: [...flow.prompt.options] } : {}),
        }
      : null,
    connection: flow.connection,
    error: flow.error,
  };
}

function isOAuthProviderId(value: string): value is OAuthProviderId {
  return OAUTH_PROVIDER_IDS.includes(value as OAuthProviderId);
}
