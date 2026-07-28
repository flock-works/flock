import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import type { AgentCapabilities } from "../shared/protocol.ts";
import { FlockError, toError } from "../shared/errors.ts";
import { createId } from "../shared/ids.ts";
import { AgentGateway } from "./agent-gateway.ts";
import {
  OidcAuthenticator,
  assertSameOrigin,
  requireRole,
  sendRedirect,
  type HumanAuthenticator,
  type HumanIdentity,
} from "./auth.ts";
import type { HubConfig } from "./config.ts";
import { BrowserEventBus } from "./event-bus.ts";
import { HubRuntime } from "./hub-runtime.ts";
import { LeaderLock } from "./leader-lock.ts";
import { WebAppHandler } from "./web-handler.ts";

export type HubServerOptions = {
  config: HubConfig;
  authenticator?: HumanAuthenticator;
  packageRoot?: string;
};

export class HubServer {
  readonly config: HubConfig;
  readonly nodeId = createId("node");
  private readonly server: Server;
  private readonly browserSockets = new WebSocketServer({ noServer: true });
  private readonly events = new BrowserEventBus();
  private readonly web: WebAppHandler;
  private readonly leader: LeaderLock;
  private readonly providedAuthenticator: HumanAuthenticator | undefined;
  private runtime: HubRuntime | undefined;
  private gateway: AgentGateway | undefined;
  private authenticator: HumanAuthenticator | undefined;
  private standbyTimer: NodeJS.Timeout | undefined;
  private leaseTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly rateLimits = new Map<string, { count: number; resetsAt: number }>();

  constructor(options: HubServerOptions) {
    this.config = options.config;
    this.leader = new LeaderLock(this.config.dataRoot, this.nodeId);
    this.web = new WebAppHandler(options.packageRoot ?? resolve(import.meta.dirname, "../.."));
    this.providedAuthenticator = options.authenticator;
    this.authenticator = options.authenticator;
    this.server = createServer((request, response) => void this.handleRequest(request, response));
    this.server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
  }

  get isReady(): boolean {
    return Boolean(this.runtime && this.gateway);
  }

  get address(): { host: string; port: number } | undefined {
    const address = this.server.address();
    return address && typeof address === "object" ? { host: address.address, port: address.port } : undefined;
  }

  get activeRuntime(): HubRuntime | undefined {
    return this.runtime;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", reject);
        resolvePromise();
      });
    });
    try {
      await this.tryBecomeLeader();
    } catch (error) {
      await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
      await this.leader.release();
      throw error;
    }
    if (!this.isReady && !this.standbyTimer) {
      this.standbyTimer = setInterval(() => void this.tryBecomeLeader(), 5_000);
      this.standbyTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.standbyTimer) clearInterval(this.standbyTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.gateway?.close();
    this.events.close();
    this.runtime?.close();
    this.gateway = undefined;
    this.runtime = undefined;
    await this.leader.release();
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
  }

  private async tryBecomeLeader(): Promise<void> {
    if (this.stopped || this.isReady) return;
    let acquired = false;
    try {
      if (this.config.leaderLock) {
        await this.leader.acquire();
        acquired = true;
      }
      const runtime = await HubRuntime.open(this.config.dataRoot);
      this.runtime = runtime;
      this.authenticator = this.providedAuthenticator ?? new OidcAuthenticator(runtime.database, this.config);
      this.gateway = new AgentGateway(runtime, this.events, this.config.leaseMs);
      this.leaseTimer = setInterval(() => {
        try {
          if (this.config.leaderLock) this.leader.assertLeader();
          void this.gateway?.expireLeases();
        } catch {
          void this.demote();
        }
      }, Math.max(1_000, Math.floor(this.config.leaseMs / 3)));
      this.leaseTimer.unref();
      if (this.standbyTimer) {
        clearInterval(this.standbyTimer);
        this.standbyTimer = undefined;
      }
    } catch (error) {
      if (acquired) await this.leader.release();
      if (!(error instanceof FlockError) || error.code !== "not_leader") throw error;
    }
  }

  private async demote(): Promise<void> {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    this.gateway?.close();
    this.gateway = undefined;
    this.events.close();
    this.runtime?.close();
    this.runtime = undefined;
    this.authenticator = this.providedAuthenticator;
    await this.leader.release();
    if (!this.stopped && !this.standbyTimer) {
      this.standbyTimer = setInterval(() => void this.tryBecomeLeader(), 5_000);
      this.standbyTimer.unref();
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.config.publicUrl);
      if (url.pathname === "/healthz") return sendJson(response, 200, { status: "ok", nodeId: this.nodeId });
      if (url.pathname === "/readyz") {
        return sendJson(response, this.isReady ? 200 : 503, {
          status: this.isReady ? "ready" : "standby",
          nodeId: this.nodeId,
          leader: await this.leader.currentState(),
        });
      }
      if (!url.pathname.startsWith("/api/")) {
        await this.web.respond(request, response, this.config.publicUrl);
        return;
      }
      if (!this.runtime || !this.authenticator || !this.gateway) {
        throw new FlockError("standby", "This hub node is waiting to become leader", 503);
      }
      if (this.config.leaderLock) this.leader.assertLeader();
      await this.handleApi(request, response, url);
    } catch (error) {
      const cause = toError(error);
      const status = error instanceof FlockError ? error.status : 500;
      sendJson(response, status, {
        error: {
          code: error instanceof FlockError ? error.code : "internal_error",
          message: status >= 500 ? "The hub could not complete this request" : cause.message,
        },
      });
    }
  }

  private async handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const runtime = this.requireRuntime();
    const authenticator = this.requireAuthenticator();

    if (url.pathname === "/api/v1/auth/login" && request.method === "GET") {
      this.enforceRateLimit(request, "login", 20, 60_000);
      const destination = await authenticator.beginLogin(url.searchParams.get("returnTo") ?? "/");
      return sendRedirect(response, destination.href);
    }
    if (url.pathname === "/api/v1/auth/callback" && request.method === "GET") {
      const result = await authenticator.finishLogin(url);
      return sendRedirect(
        response,
        result.returnTo,
        authenticator.sessionCookie(result.sessionSecret, new Date(Date.now() + 12 * 60 * 60_000).toISOString()),
      );
    }
    if (url.pathname === "/api/v1/auth/logout" && request.method === "POST") {
      assertSameOrigin(request, this.config.publicUrl);
      authenticator.logout(request);
      return sendJson(response, 200, { ok: true }, { "Set-Cookie": authenticator.expiredSessionCookie() });
    }
    if (url.pathname === "/api/v1/agents/enroll" && request.method === "POST") {
      this.enforceRateLimit(request, "enroll", 10, 60_000);
      const body = await readJson(request);
      const capabilities = requireCapabilities(body.capabilities);
      const enrolled = runtime.database.enrollAgent({
        enrollmentSecret: requireString(body.enrollmentToken, "enrollmentToken"),
        name: optionalString(body.name),
        capabilities,
      });
      this.events.publish({
        type: "presence",
        agentId: enrolled.agent.id,
        status: enrolled.agent.status,
        lastSeenAt: new Date().toISOString(),
      });
      return sendJson(response, 201, { agent: enrolled.agent, token: enrolled.token });
    }

    const identity = await this.requireIdentity(request);
    assertSameOrigin(request, this.config.publicUrl);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) {
      this.enforceRateLimit(request, `mutation:${identity.sub}`, 120, 60_000);
    }

    if (url.pathname === "/api/v1/me" && request.method === "GET") {
      return sendJson(response, 200, { user: identity });
    }
    if (url.pathname === "/api/v1/projects" && request.method === "GET") {
      return sendJson(response, 200, { projects: runtime.database.listProjects() });
    }
    if (url.pathname === "/api/v1/projects" && request.method === "POST") {
      requireRole(identity, "admin");
      const body = await readJson(request);
      const project = await runtime.createProject({
        name: requireString(body.name, "name"),
        slug: requireString(body.slug, "slug"),
      });
      return sendJson(response, 201, { project });
    }

    const projectMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)(?:\/(.*))?$/);
    if (projectMatch) {
      const projectId = decodeURIComponent(projectMatch[1]!);
      const action = projectMatch[2] ?? "";
      const project = runtime.database.getProject(projectId);
      if (!project) throw new FlockError("project_not_found", "Project not found", 404);
      if (action === "tree" && request.method === "GET") {
        const session = runtime.getSession(projectId);
        const after = Number(url.searchParams.get("after") ?? 0);
        return sendJson(response, 200, {
          project,
          session: {
            header: session.header,
            entries: session.entriesAfter(after).map(({ seq, entry }) => ({ seq, entry })),
            cursor: session.cursor,
            selectedLeafId: session.leafId,
          },
        });
      }
      if (action === "agents" && request.method === "GET") {
        return sendJson(response, 200, { agents: runtime.database.listAgents(projectId) });
      }
      if (action === "dispatches" && request.method === "GET") {
        const dispatches = runtime.database.listDispatches(projectId).map((dispatch) => ({
          ...dispatch,
          jobs: runtime.database.listJobsForDispatch(dispatch.id),
        }));
        return sendJson(response, 200, { dispatches });
      }
      if (action === "enrollments" && request.method === "POST") {
        requireRole(identity, "admin");
        const body = await readJson(request);
        const enrollment = runtime.database.createEnrollment({
          projectId,
          nameHint: requireString(body.name, "name"),
          createdBy: identity.sub,
        });
        return sendJson(response, 201, { enrollment });
      }
      if (action === "dispatches" && request.method === "POST") {
        const body = await readJson(request);
        const targetAgentIds = requireStringArray(body.targetAgentIds, "targetAgentIds");
        const created = await runtime.createDispatch({
          projectId,
          text: requireString(body.text, "text"),
          targetAgentIds,
          userSub: identity.sub,
          baseEntryId: optionalString(body.baseEntryId),
        });
        this.events.publish({
          type: "entry",
          projectId,
          seq: created.entry.seq,
          entry: created.entry.entry,
        });
        this.gateway?.broadcastSessionEntries(projectId, [created.entry]);
        await this.gateway?.offerAvailableJobs();
        return sendJson(response, 201, { dispatch: created.dispatch, jobs: created.jobs });
      }
    }

    const selectMatch = url.pathname.match(/^\/api\/v1\/dispatches\/([^/]+)\/select$/);
    if (selectMatch && request.method === "POST") {
      const body = await readJson(request);
      const result = await runtime.selectDispatchBranch({
        dispatchId: decodeURIComponent(selectMatch[1]!),
        leafId: requireString(body.leafId, "leafId"),
        actor: identity.sub,
      });
      this.events.publish({
        type: "entry",
        projectId: result.dispatch.projectId,
        seq: result.entry.seq,
        entry: result.entry.entry,
      });
      this.gateway?.broadcastSessionEntries(result.dispatch.projectId, [result.entry]);
      return sendJson(response, 200, { dispatch: result.dispatch });
    }

    const cancelMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && request.method === "POST") {
      const job = runtime.database.abortJob(decodeURIComponent(cancelMatch[1]!), identity.sub);
      this.gateway?.abortJob(job);
      this.events.publish({ type: "job", jobId: job.id, status: job.status, agentId: job.assignedAgentId, leafId: job.branchLeafId });
      return sendJson(response, 200, { job });
    }

    throw new FlockError("not_found", "API route not found", 404);
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      if (!this.runtime || !this.gateway || !this.authenticator) throw new FlockError("standby", "Hub is standby", 503);
      const url = new URL(request.url ?? "/", this.config.publicUrl);
      if (url.pathname === "/api/v1/agent/socket") {
        const agent = this.gateway.authenticate(request);
        if (!agent) throw new FlockError("unauthorized", "Invalid agent bearer token", 401);
        this.gateway.websocketServer.handleUpgrade(request, socket, head, (websocket) => this.gateway?.attach(websocket, agent));
        return;
      }
      if (url.pathname === "/api/v1/events") {
        if (request.headers.origin !== this.config.publicUrl.origin) {
          throw new FlockError("invalid_origin", "WebSocket origin mismatch", 403);
        }
        const identity = await this.authenticator.authenticate(request);
        if (!identity) throw new FlockError("unauthorized", "Sign in is required", 401);
        const projectId = url.searchParams.get("projectId");
        const after = Number(url.searchParams.get("after") ?? 0);
        this.browserSockets.handleUpgrade(request, socket, head, (websocket) => {
          this.events.add(websocket, projectId, Number.isInteger(after) ? after : 0);
        });
        return;
      }
      throw new FlockError("not_found", "WebSocket route not found", 404);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  }

  private requireRuntime(): HubRuntime {
    if (!this.runtime) throw new FlockError("standby", "Hub is standby", 503);
    return this.runtime;
  }

  private requireAuthenticator(): HumanAuthenticator {
    if (!this.authenticator) throw new FlockError("standby", "Hub is standby", 503);
    return this.authenticator;
  }

  private async requireIdentity(request: IncomingMessage): Promise<HumanIdentity> {
    const identity = await this.requireAuthenticator().authenticate(request);
    if (!identity) throw new FlockError("unauthorized", "Sign in is required", 401);
    return identity;
  }

  private enforceRateLimit(
    request: IncomingMessage,
    bucket: string,
    limit: number,
    windowMs: number,
  ): void {
    const forwarded = this.config.trustProxy ? request.headers["x-forwarded-for"] : undefined;
    const address =
      typeof forwarded === "string"
        ? forwarded.split(",", 1)[0]!.trim()
        : request.socket.remoteAddress ?? "unknown";
    const key = `${bucket}:${address}`;
    const now = Date.now();
    const existing = this.rateLimits.get(key);
    const state =
      !existing || existing.resetsAt <= now
        ? { count: 0, resetsAt: now + windowMs }
        : existing;
    state.count += 1;
    this.rateLimits.set(key, state);
    if (state.count > limit) {
      throw new FlockError("rate_limited", "Too many requests; retry after the rate-limit window", 429);
    }
    if (this.rateLimits.size > 10_000) {
      for (const [candidate, value] of this.rateLimits) {
        if (value.resetsAt <= now) this.rateLimits.delete(candidate);
      }
    }
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new FlockError("body_too_large", "Request body is too large", 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new FlockError("invalid_json", "JSON body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof FlockError) throw error;
    throw new FlockError("invalid_json", "Request body is not valid JSON");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new FlockError("invalid_request", `${field} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new FlockError("invalid_request", `${field} must be a string array`);
  }
  return value;
}

function requireCapabilities(value: unknown): AgentCapabilities {
  if (typeof value !== "object" || value === null) throw new FlockError("invalid_request", "capabilities are required");
  const record = value as Record<string, unknown>;
  return {
    tools: requireStringArray(record.tools, "capabilities.tools"),
    platform: requireString(record.platform, "capabilities.platform"),
    workspace: requireString(record.workspace, "capabilities.workspace"),
    model: requireString(record.model, "capabilities.model"),
    thinkingLevel: requireString(record.thinkingLevel, "capabilities.thinkingLevel"),
  };
}
