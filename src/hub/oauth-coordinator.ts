import {
  builtinModels,
} from "@earendil-works/pi-ai/providers/all";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import { FlockError, toError } from "../shared/errors.ts";
import { createId } from "../shared/ids.ts";
import {
  createFlockModels,
  fetchNousModels,
  MemoryCredentialStore,
  NOUS_PROVIDER_ID,
  NOUS_PROVIDER_NAME,
  refreshNousCredential,
  type NousProviderOptions,
} from "../shared/nous-provider.ts";
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
  "nous",
] as const satisfies readonly OAuthProviderId[];

const MODEL_CACHE_MS = 5 * 60_000;

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

type ProviderCatalogEntry = {
  id: OAuthProviderId;
  name: string;
  modelSource: "static" | "connection";
  models: Array<{ id: string; name: string }>;
};

export type OAuthCoordinatorOptions = {
  login?: (providerId: OAuthProviderId, interaction: AuthInteraction) => Promise<Credential>;
  nous?: NousProviderOptions;
};

export class OAuthCoordinator {
  private readonly database: ControlDatabase;
  private readonly login: (providerId: OAuthProviderId, interaction: AuthInteraction) => Promise<Credential>;
  private readonly nous: NousProviderOptions | undefined;
  private readonly flows = new Map<string, Flow>();
  private readonly activeProviders = new Map<string, string>();
  private readonly modelCache = new Map<string, {
    connectionVersion: number;
    expiresAt: number;
    models: Array<{ id: string; name: string }>;
  }>();

  constructor(
    database: ControlDatabase,
    input?:
      | OAuthCoordinatorOptions
      | ((providerId: OAuthProviderId, interaction: AuthInteraction) => Promise<Credential>),
  ) {
    this.database = database;
    const options = typeof input === "function" ? { login: input } : input ?? {};
    this.nous = options.nous;
    this.login = options.login ?? ((providerId, interaction) =>
      defaultLogin(providerId, interaction, this.nous));
  }

  get nousPortalEnabled(): boolean {
    return Boolean(this.nous?.clientId?.trim());
  }

  catalog(): ProviderCatalogEntry[] {
    const models = builtinModels();
    return OAUTH_PROVIDER_IDS.flatMap((id): ProviderCatalogEntry[] => {
      if (id === NOUS_PROVIDER_ID) {
        return this.nousPortalEnabled
          ? [{
              id,
              name: NOUS_PROVIDER_NAME,
              modelSource: "connection",
              models: [],
            }]
          : [];
      }
      const provider = models.getProvider(id);
      return [{
        id,
        name: provider?.name ?? id,
        modelSource: "static",
        models: models.getModels(id).map((model) => ({
          id: model.id,
          name: model.name,
        })),
      }];
    });
  }

  async modelsForConnection(
    connectionId: string,
    userSub: string,
  ): Promise<{ providerId: OAuthProviderId; models: Array<{ id: string; name: string }> }> {
    const connection = this.requireOwnedConnection(connectionId, userSub);
    if (connection.providerId !== NOUS_PROVIDER_ID) {
      const provider = this.catalog().find((candidate) => candidate.id === connection.providerId);
      return { providerId: connection.providerId, models: provider?.models ?? [] };
    }
    if (!this.nousPortalEnabled || !this.nous) {
      throw new FlockError("nous_not_configured", "Nous Portal is not configured on this hub", 503);
    }
    const cached = this.modelCache.get(connection.id);
    if (
      cached &&
      cached.connectionVersion === connection.version &&
      cached.expiresAt > Date.now()
    ) {
      return { providerId: connection.providerId, models: cached.models };
    }
    let current = this.database.readProviderCredential(connection.id);
    if (current.credential.type !== "oauth") {
      throw new FlockError("connection_unavailable", "Nous Portal requires an OAuth connection", 409);
    }
    let credential: OAuthCredential = current.credential;
    try {
      if (credential.expires <= Date.now()) {
        const refreshed = await refreshNousCredential(credential, this.nous);
        const updated = this.database.updateProviderCredential({
          id: connection.id,
          expectedVersion: current.connection.version,
          credential: refreshed,
        });
        current = { connection: updated, credential: refreshed };
        credential = refreshed;
      }
      const models = (await fetchNousModels(credential, this.nous))
        .map((model) => ({ id: model.id, name: model.name }))
        .sort((left, right) => left.name.localeCompare(right.name));
      if (models.length === 0) {
        throw new FlockError("model_catalog_empty", "Nous Portal returned no available models", 502);
      }
      this.modelCache.set(connection.id, {
        connectionVersion: current.connection.version,
        expiresAt: Date.now() + MODEL_CACHE_MS,
        models,
      });
      return { providerId: connection.providerId, models };
    } catch (error) {
      if (error instanceof FlockError) throw error;
      throw new FlockError(
        "nous_catalog_failed",
        `Could not load Nous models: ${toError(error).message}`,
        502,
      );
    }
  }

  async assertConnectionModel(
    connectionId: string,
    userSub: string,
    reference: string,
  ): Promise<void> {
    const separator = reference.indexOf("/");
    if (separator <= 0 || separator === reference.length - 1) {
      throw new FlockError("invalid_model", "model must use provider/model-id syntax");
    }
    const providerId = reference.slice(0, separator);
    const modelId = reference.slice(separator + 1);
    const catalog = await this.modelsForConnection(connectionId, userSub);
    if (catalog.providerId !== providerId) {
      throw new FlockError("provider_mismatch", "The model must belong to the selected connection", 400);
    }
    if (!catalog.models.some((model) => model.id === modelId)) {
      throw new FlockError("model_not_found", `Model ${reference} is not available`, 400);
    }
  }

  start(input: {
    userSub: string;
    label: string;
    providerId: string;
  }): OAuthFlowSnapshot {
    if (!isOAuthProviderId(input.providerId)) {
      throw new FlockError("unsupported_provider", "This provider does not support hosted-agent OAuth", 400);
    }
    if (input.providerId === NOUS_PROVIDER_ID && !this.nousPortalEnabled) {
      throw new FlockError("nous_not_configured", "Nous Portal is not configured on this hub", 503);
    }
    const activeKey = `${input.userSub}:${input.providerId}`;
    if (this.activeProviders.has(activeKey)) {
      throw new FlockError(
        "oauth_flow_busy",
        "A sign-in for this provider is already running",
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
    this.activeProviders.set(activeKey, id);
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
      this.modelCache.delete(flow.connection.id);
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
      this.activeProviders.delete(`${flow.userSub}:${flow.providerId}`);
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
    this.activeProviders.delete(`${flow.userSub}:${flow.providerId}`);
  }

  private requireOwnedConnection(id: string, userSub: string): ProviderConnectionRecord {
    const connection = this.database.getProviderConnection(id);
    if (!connection) throw new FlockError("connection_not_found", "Provider connection not found", 404);
    if (connection.userSub !== userSub) {
      throw new FlockError("forbidden", "This provider connection belongs to another user", 403);
    }
    if (connection.status !== "connected") {
      throw new FlockError("connection_unavailable", "Provider connection requires attention", 409);
    }
    return connection;
  }
}

async function defaultLogin(
  providerId: OAuthProviderId,
  interaction: AuthInteraction,
  nous?: NousProviderOptions,
): Promise<Credential> {
  const credentials = new MemoryCredentialStore();
  return createFlockModels({
    credentials,
    ...(nous ?? {}),
  }).login(providerId, "oauth", interaction);
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
