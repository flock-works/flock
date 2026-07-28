import {
  createProvider,
  type AuthInteraction,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type ModelsStore,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

export const NOUS_PROVIDER_ID = "nous";
export const NOUS_PROVIDER_NAME = "Nous Portal";
export const DEFAULT_NOUS_PORTAL_URL = "https://portal.nousresearch.com";
export const DEFAULT_NOUS_INFERENCE_URL = "https://inference-api.nousresearch.com/v1";
export const NOUS_OAUTH_SCOPE = "inference:invoke";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const ACCESS_EXPIRY_SKEW_MS = 120_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type SleepLike = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export type NousProviderOptions = {
  clientId?: string;
  portalUrl?: string | URL;
  inferenceUrl?: string | URL;
  fetchFn?: FetchLike;
  sleepFn?: SleepLike;
  now?: () => number;
  requestTimeoutMs?: number;
  seedModelIds?: string[];
};

export type FlockModelsOptions = NousProviderOptions & {
  credentials?: CredentialStore;
  modelsStore?: ModelsStore;
};

type NousCredential = OAuthCredential & {
  clientId?: string;
  portalBaseUrl?: string;
  inferenceBaseUrl?: string;
  scope?: string;
};

type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

type TokenResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
};

export function createFlockModels(options: FlockModelsOptions = {}) {
  const models = builtinModels({
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.modelsStore ? { modelsStore: options.modelsStore } : {}),
  });
  models.setProvider(createNousProvider(options));
  return models;
}

export function createNousProvider(options: NousProviderOptions = {}) {
  const fallbackModels = buildNousModels(
    [...new Set((options.seedModelIds ?? []).map(normalizeSeedModelId).filter(Boolean))],
    inferenceUrl(options),
  );
  return createProvider({
    id: NOUS_PROVIDER_ID,
    name: NOUS_PROVIDER_NAME,
    baseUrl: inferenceUrl(options),
    auth: {
      oauth: {
        name: "Nous Portal",
        loginLabel: "Continue with Nous Portal",
        login: (interaction) => loginNousPortal(interaction, options),
        refresh: (credential, signal) => refreshNousCredential(credential, options, signal),
        toAuth: async (credential) => ({
          apiKey: credential.access,
          baseUrl: credentialUrl(credential, "inferenceBaseUrl", inferenceUrl(options)),
        }),
      },
    },
    models: fallbackModels,
    fetchModels: async ({ credential, signal }) => {
      if (credential?.type !== "oauth") return [];
      return fetchNousModels(credential, options, signal);
    },
    api: openAICompletionsApi(),
  });
}

export async function loginNousPortal(
  interaction: AuthInteraction,
  options: NousProviderOptions = {},
): Promise<NousCredential> {
  const clientId = options.clientId?.trim();
  if (!clientId) throw new Error("FLOCK_NOUS_CLIENT_ID is required for Nous Portal login");
  const portalBaseUrl = portalUrl(options);
  const configuredInferenceUrl = inferenceUrl(options);
  const device = await requestDeviceCode(clientId, portalBaseUrl, options, interaction.signal);
  interaction.notify({
    type: "device_code",
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expiresIn,
  });
  const token = await pollForToken(
    clientId,
    portalBaseUrl,
    device,
    options,
    interaction.signal,
  );
  if (!token.refreshToken) throw new Error("Nous Portal token response did not include a refresh token");
  requireInferenceScope(token);
  return credentialFromToken(token, {
    clientId,
    portalBaseUrl,
    inferenceBaseUrl: configuredInferenceUrl,
    refreshToken: token.refreshToken,
    now: now(options),
  });
}

export async function refreshNousCredential(
  credential: OAuthCredential,
  options: NousProviderOptions = {},
  signal?: AbortSignal,
): Promise<NousCredential> {
  const current = credential as NousCredential;
  const clientId = current.clientId?.trim() || options.clientId?.trim();
  if (!clientId) throw new Error("Nous Portal OAuth client ID is unavailable");
  if (!current.refresh) throw new Error("Nous Portal refresh token is unavailable");
  const portalBaseUrl = credentialUrl(current, "portalBaseUrl", portalUrl(options));
  const configuredInferenceUrl = credentialUrl(
    current,
    "inferenceBaseUrl",
    inferenceUrl(options),
  );
  const response = await postForm(
    new URL("/api/oauth/token", withTrailingSlash(portalBaseUrl)),
    {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: current.refresh,
    },
    options,
    signal,
  );
  const token = await requireTokenResponse(response, "Nous Portal token refresh failed");
  requireInferenceScope(token);
  return credentialFromToken(token, {
    clientId,
    portalBaseUrl,
    inferenceBaseUrl: configuredInferenceUrl,
    refreshToken: token.refreshToken || current.refresh,
    now: now(options),
  });
}

export async function fetchNousModels(
  credential: OAuthCredential,
  options: NousProviderOptions = {},
  signal?: AbortSignal,
): Promise<Model<"openai-completions">[]> {
  const baseUrl = credentialUrl(
    credential as NousCredential,
    "inferenceBaseUrl",
    inferenceUrl(options),
  );
  const response = await request(
    new URL("models", withTrailingSlash(baseUrl)),
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential.access}`,
      },
    },
    options,
    signal,
  );
  if (!response.ok) throw await responseError(response, "Nous model catalog request failed");
  const payload = asRecord(await response.json());
  if (!Array.isArray(payload.data)) throw new Error("Nous model catalog response is invalid");
  const modelIds = payload.data.flatMap((item) => {
    const id = asString(asRecord(item).id);
    return id ? [id] : [];
  });
  return buildNousModels([...new Set(modelIds)], baseUrl);
}

export class MemoryCredentialStore implements CredentialStore {
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
    return next ?? this.values.get(providerId);
  }

  async delete(providerId: string): Promise<void> {
    this.values.delete(providerId);
  }
}

function buildNousModels(
  modelIds: string[],
  baseUrl: string,
): Model<"openai-completions">[] {
  const openrouter = new Map(openrouterProvider().getModels().map((model) => [model.id, model]));
  return modelIds.map((id) => {
    const source = openrouter.get(id);
    if (source) {
      return {
        id,
        name: source.name,
        api: "openai-completions",
        provider: NOUS_PROVIDER_ID,
        baseUrl,
        reasoning: source.reasoning,
        ...(source.thinkingLevelMap ? { thinkingLevelMap: source.thinkingLevelMap } : {}),
        input: [...source.input],
        cost: { ...source.cost },
        contextWindow: source.contextWindow,
        maxTokens: source.maxTokens,
      };
    }
    return {
      id,
      name: readableModelName(id),
      api: "openai-completions",
      provider: NOUS_PROVIDER_ID,
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131_072,
      maxTokens: 16_384,
    };
  });
}

async function requestDeviceCode(
  clientId: string,
  portalBaseUrl: string,
  options: NousProviderOptions,
  signal?: AbortSignal,
): Promise<DeviceCodeResponse> {
  const response = await postForm(
    new URL("/api/oauth/device/code", withTrailingSlash(portalBaseUrl)),
    { client_id: clientId, scope: NOUS_OAUTH_SCOPE },
    options,
    signal,
  );
  if (!response.ok) throw await responseError(response, "Nous device authorization failed");
  const payload = asRecord(await response.json());
  const deviceCode = asString(payload.device_code);
  const userCode = asString(payload.user_code);
  const verification = asString(payload.verification_uri_complete)
    ?? asString(payload.verification_uri);
  const expiresIn = asPositiveNumber(payload.expires_in);
  const interval = asPositiveNumber(payload.interval);
  if (!deviceCode || !userCode || !verification || !expiresIn || !interval) {
    throw new Error("Nous device authorization response is invalid");
  }
  const verificationUrl = validateUrl(verification, portalBaseUrl, "Nous verification URL");
  return {
    deviceCode,
    userCode,
    verificationUri: verificationUrl,
    expiresIn,
    interval,
  };
}

async function pollForToken(
  clientId: string,
  portalBaseUrl: string,
  device: DeviceCodeResponse,
  options: NousProviderOptions,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const deadline = now(options) + device.expiresIn * 1000;
  let interval = Math.max(1, device.interval);
  while (now(options) < deadline) {
    if (signal?.aborted) throw abortError(signal);
    const response = await postForm(
      new URL("/api/oauth/token", withTrailingSlash(portalBaseUrl)),
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: device.deviceCode,
      },
      options,
      signal,
    );
    if (response.ok) return requireTokenResponse(response, "Nous token exchange failed");
    const error = await responseError(response, "Nous token exchange failed");
    if (error.code === "authorization_pending") {
      await sleep(options)(interval * 1000, signal);
      continue;
    }
    if (error.code === "slow_down") {
      interval = Math.min(interval + 5, 30);
      await sleep(options)(interval * 1000, signal);
      continue;
    }
    if (["access_denied", "authorization_denied"].includes(error.code ?? "")) {
      throw new Error("Nous Portal login was denied");
    }
    if (error.code === "expired_token") throw new Error("Nous Portal login expired");
    throw error;
  }
  throw new Error("Nous Portal login expired");
}

async function requireTokenResponse(
  response: Response,
  fallback: string,
): Promise<TokenResponse> {
  if (!response.ok) throw await responseError(response, fallback);
  const payload = asRecord(await response.json());
  const accessToken = asString(payload.access_token);
  const expiresIn = asPositiveNumber(payload.expires_in);
  if (!accessToken || !expiresIn) throw new Error("Nous token response is invalid");
  return {
    accessToken,
    refreshToken: asString(payload.refresh_token),
    expiresIn,
    scope: asString(payload.scope),
  };
}

function credentialFromToken(
  token: TokenResponse,
  input: {
    clientId: string;
    portalBaseUrl: string;
    inferenceBaseUrl: string;
    refreshToken: string;
    now: number;
  },
): NousCredential {
  const expires = Math.max(
    input.now + 1_000,
    input.now + token.expiresIn * 1000 - ACCESS_EXPIRY_SKEW_MS,
  );
  return {
    type: "oauth",
    access: token.accessToken,
    refresh: input.refreshToken,
    expires,
    clientId: input.clientId,
    portalBaseUrl: input.portalBaseUrl,
    inferenceBaseUrl: input.inferenceBaseUrl,
    scope: token.scope ?? NOUS_OAUTH_SCOPE,
  };
}

function requireInferenceScope(token: TokenResponse): void {
  if (
    token.scope
    && !token.scope.split(/\s+/u).includes(NOUS_OAUTH_SCOPE)
  ) {
    throw new Error(`Nous Portal credential is missing the ${NOUS_OAUTH_SCOPE} scope`);
  }
}

async function postForm(
  url: URL,
  body: Record<string, string>,
  options: NousProviderOptions,
  signal?: AbortSignal,
): Promise<Response> {
  return request(
    url,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    },
    options,
    signal,
  );
}

async function request(
  url: URL,
  init: RequestInit,
  options: NousProviderOptions,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await (options.fetchFn ?? fetch)(url, { ...init, signal: combined });
  } catch (error) {
    if (combined.aborted) throw abortError(combined);
    throw error;
  }
}

class NousHttpError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "NousHttpError";
    this.status = status;
    this.code = code;
  }
}

async function responseError(response: Response, fallback: string): Promise<NousHttpError> {
  const payload = asRecord(await response.json().catch(() => ({})));
  const code = asString(payload.error);
  const message = asString(payload.error_description) ?? asString(payload.message) ?? fallback;
  return new NousHttpError(`${code ? `${code}: ` : ""}${message}`, response.status, code);
}

function portalUrl(options: NousProviderOptions): string {
  return configuredUrl(options.portalUrl, DEFAULT_NOUS_PORTAL_URL, "Nous Portal URL");
}

function inferenceUrl(options: NousProviderOptions): string {
  return configuredUrl(
    options.inferenceUrl,
    DEFAULT_NOUS_INFERENCE_URL,
    "Nous inference URL",
  );
}

function credentialUrl(
  credential: NousCredential,
  key: "portalBaseUrl" | "inferenceBaseUrl",
  fallback: string,
): string {
  return configuredUrl(credential[key], fallback, `Nous ${key}`);
}

export function configuredUrl(
  input: string | URL | undefined,
  fallback: string,
  label: string,
): string {
  const url = new URL(input?.toString() || fallback);
  if (url.username || url.password) throw new Error(`${label} must not include credentials`);
  if (url.search || url.hash) throw new Error(`${label} must not include a query or fragment`);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (!loopback && url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  if (loopback && !["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return url.href.replace(/\/$/, "");
}

function validateUrl(input: string, expectedBase: string, label: string): string {
  const url = new URL(input);
  const expected = new URL(expectedBase);
  if (url.username || url.password) throw new Error(`${label} must not include credentials`);
  if (url.origin !== expected.origin) throw new Error(`${label} returned an unexpected origin`);
  return url.href;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeSeedModelId(value: string): string {
  return value.startsWith(`${NOUS_PROVIDER_ID}/`)
    ? value.slice(NOUS_PROVIDER_ID.length + 1)
    : value;
}

function readableModelName(id: string): string {
  const leaf = id.split("/").at(-1) ?? id;
  return leaf
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function now(options: NousProviderOptions): number {
  return (options.now ?? Date.now)();
}

function sleep(options: NousProviderOptions): SleepLike {
  return options.sleepFn ?? ((milliseconds, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
  }));
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}
