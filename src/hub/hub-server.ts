import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import type { Credential } from "@earendil-works/pi-ai";
import type { AgentCapabilities } from "../shared/protocol.ts";
import { FlockError, toError } from "../shared/errors.ts";
import { createId } from "../shared/ids.ts";
import type { NousProviderOptions } from "../shared/nous-provider.ts";
import { AgentGateway } from "./agent-gateway.ts";
import {
  OidcAuthenticator,
  assertSameOrigin,
  requestUrl,
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
import { HostedAgentManager, type ContainerRuntime } from "./hosted-agent-manager.ts";
import { OAuthCoordinator } from "./oauth-coordinator.ts";
import type { ControlDatabase } from "./control-db.ts";

export type HubServerOptions = {
  config: HubConfig;
  authenticator?: HumanAuthenticator;
  packageRoot?: string;
  hostedAgentRuntime?: ContainerRuntime;
  nousProviderOptions?: NousProviderOptions;
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
  private readonly hostedAgentRuntime: ContainerRuntime | undefined;
  private readonly nousProviderOptions: NousProviderOptions | undefined;
  private runtime: HubRuntime | undefined;
  private gateway: AgentGateway | undefined;
  private authenticator: HumanAuthenticator | undefined;
  private hostedAgents: HostedAgentManager | undefined;
  private oauth: OAuthCoordinator | undefined;
  private standbyTimer: NodeJS.Timeout | undefined;
  private leaseTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly rateLimits = new Map<string, { count: number; resetsAt: number }>();

  constructor(options: HubServerOptions) {
    this.config = options.config;
    this.leader = new LeaderLock(this.config.dataRoot, this.nodeId);
    this.web = new WebAppHandler(options.packageRoot ?? resolve(import.meta.dirname, "../.."));
    this.providedAuthenticator = options.authenticator;
    this.hostedAgentRuntime = options.hostedAgentRuntime;
    this.nousProviderOptions = options.nousProviderOptions;
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
    await this.hostedAgents?.stop();
    this.oauth?.close();
    this.gateway?.close();
    this.events.close();
    this.runtime?.close();
    this.gateway = undefined;
    this.runtime = undefined;
    this.hostedAgents = undefined;
    this.oauth = undefined;
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
      const runtime = await HubRuntime.open(
        this.config.dataRoot,
        this.config.hostedAgents.credentialKey,
      );
      this.runtime = runtime;
      this.authenticator = this.providedAuthenticator ?? new OidcAuthenticator(runtime.database, this.config);
      this.gateway = new AgentGateway(runtime, this.events, this.config.leaseMs);
      if (this.config.hostedAgents.enabled) {
        this.oauth = new OAuthCoordinator(runtime.database, {
          nous: {
            ...this.nousProviderOptions,
            clientId: this.config.nous.clientId,
            portalUrl: this.config.nous.portalUrl,
            inferenceUrl: this.config.nous.inferenceUrl,
          },
        });
        this.hostedAgents = new HostedAgentManager(
          runtime.database,
          this.config,
          this.hostedAgentRuntime,
        );
        await this.hostedAgents.start();
      }
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
    await this.hostedAgents?.stop();
    this.hostedAgents = undefined;
    this.oauth?.close();
    this.oauth = undefined;
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
      const url = requestUrl(request, this.config.publicUrl);
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
      const destination = await authenticator.beginLogin(
        url.searchParams.get("returnTo") ?? "/",
        url,
      );
      return sendRedirect(response, destination.href);
    }
    if (url.pathname === "/api/v1/auth/callback" && request.method === "GET") {
      const result = await authenticator.finishLogin(url);
      return sendRedirect(
        response,
        result.returnTo,
        authenticator.sessionCookie(
          result.sessionSecret,
          new Date(Date.now() + 12 * 60 * 60_000).toISOString(),
          url.protocol === "https:",
        ),
      );
    }
    if (url.pathname === "/api/v1/auth/logout" && request.method === "POST") {
      assertSameOrigin(request, url);
      authenticator.logout(request);
      return sendJson(
        response,
        200,
        { ok: true },
        { "Set-Cookie": authenticator.expiredSessionCookie(url.protocol === "https:") },
      );
    }
    if (url.pathname === "/api/v1/agents/onboarding" && request.method === "POST") {
      this.enforceRateLimit(request, "agent-onboarding", 20, 60_000);
      const body = await readJson(request);
      const enrollment = runtime.database.inspectEnrollment(
        requireString(body.enrollmentToken, "enrollmentToken"),
      );
      return sendJson(response, 200, {
        enrollment: {
          name: enrollment.nameHint,
          expiresAt: enrollment.expiresAt,
        },
        nous: {
          enabled: Boolean(this.config.nous.clientId),
          ...(this.config.nous.clientId ? { clientId: this.config.nous.clientId } : {}),
          portalUrl: this.config.nous.portalUrl.href,
          inferenceUrl: this.config.nous.inferenceUrl.href,
        },
      });
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
        projectId: enrolled.agent.projectId,
        agentId: enrolled.agent.id,
        status: enrolled.agent.status,
        lastSeenAt: new Date().toISOString(),
      });
      return sendJson(response, 201, { agent: enrolled.agent, token: enrolled.token });
    }
    if (url.pathname === "/api/v1/agent/provider-credential" && ["GET", "PUT"].includes(request.method ?? "")) {
      const agent = authenticateAgentRequest(request, runtime.database);
      if (!agent.hosting) throw new FlockError("forbidden", "Only hosted agents use the credential service", 403);
      this.enforceRateLimit(request, `agent-credential:${agent.id}`, 120, 60_000);
      if (request.method === "GET") {
        const value = runtime.database.readHostedAgentCredential(agent.id);
        return sendJson(response, 200, {
          providerId: value.connection.providerId,
          credential: value.credential,
          version: value.connection.version,
        });
      }
      const body = await readJson(request);
      const current = runtime.database.readHostedAgentCredential(agent.id);
      const credential = requireCredential(body.credential);
      const connection = runtime.database.updateProviderCredential({
        id: current.connection.id,
        expectedVersion: requireInteger(body.expectedVersion, "expectedVersion"),
        credential,
      });
      return sendJson(response, 200, {
        providerId: connection.providerId,
        version: connection.version,
      });
    }

    const identity = await this.requireIdentity(request);
    assertSameOrigin(request, url);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) {
      this.enforceRateLimit(request, `mutation:${identity.sub}`, 120, 60_000);
    }

    if (url.pathname === "/api/v1/me" && request.method === "GET") {
      return sendJson(response, 200, { user: identity });
    }
    if (url.pathname === "/api/v1/llm/providers" && request.method === "GET") {
      return sendJson(response, 200, {
        hostedAgentsEnabled: this.config.hostedAgents.enabled,
        nousPortalEnabled: this.oauth?.nousPortalEnabled ?? false,
        providers: this.oauth?.catalog() ?? [],
      });
    }
    if (url.pathname === "/api/v1/provider-connections" && request.method === "GET") {
      return sendJson(response, 200, {
        connections: runtime.database.listProviderConnections(identity.sub),
      });
    }
    const providerLoginMatch = url.pathname.match(/^\/api\/v1\/provider-connections\/([^/]+)\/login$/);
    if (providerLoginMatch && request.method === "POST") {
      const oauth = this.requireOAuth();
      const flow = oauth.start({
        userSub: identity.sub,
        label: identity.email,
        providerId: decodeURIComponent(providerLoginMatch[1]!),
      });
      return sendJson(response, 202, { flow });
    }
    const connectionModelsMatch = url.pathname.match(
      /^\/api\/v1\/provider-connections\/([^/]+)\/models$/,
    );
    if (connectionModelsMatch && request.method === "GET") {
      const catalog = await this.requireOAuth().modelsForConnection(
        decodeURIComponent(connectionModelsMatch[1]!),
        identity.sub,
      );
      return sendJson(response, 200, catalog);
    }
    const connectionMatch = url.pathname.match(/^\/api\/v1\/provider-connections\/([^/]+)$/);
    if (connectionMatch && request.method === "DELETE") {
      const connection = runtime.database.disconnectProviderConnection(
        decodeURIComponent(connectionMatch[1]!),
        identity.sub,
      );
      await this.hostedAgents?.reconcile();
      return sendJson(response, 200, { connection });
    }
    const oauthFlowMatch = url.pathname.match(/^\/api\/v1\/oauth-flows\/([^/]+)$/);
    if (oauthFlowMatch && request.method === "GET") {
      return sendJson(response, 200, {
        flow: this.requireOAuth().get(decodeURIComponent(oauthFlowMatch[1]!), identity.sub),
      });
    }
    if (oauthFlowMatch && request.method === "POST") {
      const body = await readJson(request);
      const flow = this.requireOAuth().respond(
        decodeURIComponent(oauthFlowMatch[1]!),
        identity.sub,
        requireString(body.promptId, "promptId"),
        requireString(body.value, "value"),
      );
      return sendJson(response, 200, { flow });
    }
    if (oauthFlowMatch && request.method === "DELETE") {
      const flow = this.requireOAuth().cancel(
        decodeURIComponent(oauthFlowMatch[1]!),
        identity.sub,
      );
      return sendJson(response, 200, { flow });
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
          author: runtime.database.getUser(dispatch.userSub) ?? null,
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
      if (action === "hosted-agents" && request.method === "POST") {
        this.requireHostedAgents();
        const body = await readJson(request);
        const thinkingLevel = requireThinkingLevel(body.thinkingLevel);
        const model = requireString(body.model, "model");
        const connectionId = requireString(body.connectionId, "connectionId");
        await this.requireOAuth().assertConnectionModel(
          connectionId,
          identity.sub,
          model,
        );
        const created = runtime.database.createHostedAgent({
          projectId,
          name: requireString(body.name, "name"),
          createdBy: identity.sub,
          connectionId,
          model,
          thinkingLevel,
          workspace: "/workspace",
        });
        await this.hostedAgents?.reconcileAgent(created.agent.id);
        return sendJson(response, 201, { agent: runtime.database.getAgent(created.agent.id) });
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

    const agentMatch = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)$/);
    if (agentMatch && request.method === "DELETE") {
      requireRole(identity, "admin");
      const agentId = decodeURIComponent(agentMatch[1]!);
      const agent = runtime.database.getAgent(agentId);
      if (!agent) throw new FlockError("agent_not_found", "Agent not found", 404);
      if (agent.hosting) {
        throw new FlockError(
          "hosted_agent_managed",
          "Hosted agents must be deleted through the hosted-agent endpoint",
          409,
        );
      }
      runtime.database.revokeAgent(agent.id, identity.sub);
      for (const job of runtime.database.abortActiveJobsForAgent(agent.id, identity.sub)) {
        this.gateway?.abortJob(job);
      }
      this.gateway?.disconnectAgent(agent.id);
      const revoked = runtime.database.getAgent(agent.id);
      this.events.publish({
        type: "presence",
        projectId: agent.projectId,
        agentId: agent.id,
        status: "revoked",
        lastSeenAt: new Date().toISOString(),
      });
      return sendJson(response, 200, { agent: revoked });
    }

    const hostedAgentMatch = url.pathname.match(/^\/api\/v1\/hosted-agents\/([^/]+)$/);
    if (hostedAgentMatch && request.method === "PATCH") {
      this.requireHostedAgents();
      const body = await readJson(request);
      const model = optionalString(body.model);
      const agentId = decodeURIComponent(hostedAgentMatch[1]!);
      const connectionId = optionalString(body.connectionId);
      if (model || connectionId) {
        const currentHosted = runtime.database.getHostedAgent(agentId);
        const currentAgent = runtime.database.getAgent(agentId);
        const effectiveConnectionId = connectionId ?? currentHosted?.connectionId;
        const effectiveModel = model ?? currentAgent?.model;
        if (!effectiveConnectionId || !effectiveModel) {
          throw new FlockError("hosted_agent_not_found", "Hosted agent not found", 404);
        }
        await this.requireOAuth().assertConnectionModel(
          effectiveConnectionId,
          identity.sub,
          effectiveModel,
        );
      }
      const desiredState = body.desiredState === undefined
        ? undefined
        : requireDesiredState(body.desiredState);
      const agent = runtime.database.updateHostedAgent({
        agentId,
        actor: identity.sub,
        connectionId,
        model,
        thinkingLevel: body.thinkingLevel === undefined
          ? undefined
          : requireThinkingLevel(body.thinkingLevel),
        desiredState,
      });
      for (const job of runtime.database.abortActiveJobsForAgent(agent.id, identity.sub)) {
        this.gateway?.abortJob(job);
      }
      await this.hostedAgents?.removeAgentContainer(agent.id);
      await this.hostedAgents?.reconcileAgent(agent.id);
      return sendJson(response, 200, { agent: runtime.database.getAgent(agent.id) });
    }
    if (hostedAgentMatch && request.method === "DELETE") {
      this.requireHostedAgents();
      const agentId = decodeURIComponent(hostedAgentMatch[1]!);
      const hosted = runtime.database.deleteHostedAgent({
        agentId,
        actor: identity.sub,
        actorRole: identity.role,
        retentionDays: this.config.hostedAgents.retentionDays,
      });
      for (const job of runtime.database.abortActiveJobsForAgent(agentId, identity.sub)) {
        this.gateway?.abortJob(job);
      }
      await this.hostedAgents?.removeAgentContainer(agentId);
      return sendJson(response, 200, { hosted });
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
      this.events.publish({
        type: "job",
        projectId: job.projectId,
        jobId: job.id,
        status: job.status,
        agentId: job.assignedAgentId,
        leafId: job.branchLeafId,
      });
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
      const url = requestUrl(request, this.config.publicUrl);
      if (url.pathname === "/api/v1/agent/socket") {
        const agent = this.gateway.authenticate(request);
        if (!agent) throw new FlockError("unauthorized", "Invalid agent bearer token", 401);
        this.gateway.websocketServer.handleUpgrade(request, socket, head, (websocket) => this.gateway?.attach(websocket, agent));
        return;
      }
      if (url.pathname === "/api/v1/events") {
        if (request.headers.origin !== url.origin) {
          throw new FlockError("invalid_origin", "WebSocket origin mismatch", 403);
        }
        const identity = await this.authenticator.authenticate(request);
        if (!identity) throw new FlockError("unauthorized", "Sign in is required", 401);
        const projectId = url.searchParams.get("projectId");
        if (!projectId || !this.runtime.database.getProject(projectId)) {
          throw new FlockError("project_not_found", "Project not found", 404);
        }
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

  private requireOAuth(): OAuthCoordinator {
    if (!this.oauth) throw new FlockError("hosted_agents_disabled", "Hosted agents are not enabled on this hub", 503);
    return this.oauth;
  }

  private requireHostedAgents(): HostedAgentManager {
    if (!this.hostedAgents) {
      throw new FlockError("hosted_agents_disabled", "Hosted agents are not enabled on this hub", 503);
    }
    return this.hostedAgents;
  }

  private async requireIdentity(request: IncomingMessage): Promise<HumanIdentity> {
    const identity = await this.requireAuthenticator().authenticate(request);
    if (!identity) throw new FlockError("unauthorized", "Sign in is required", 401);
    this.requireRuntime().database.upsertUser(identity);
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

function requireInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new FlockError("invalid_request", `${field} must be an integer`);
  return value as number;
}

function requireCredential(value: unknown): Credential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FlockError("invalid_request", "credential is required");
  }
  const type = (value as { type?: unknown }).type;
  if (type !== "oauth") {
    throw new FlockError("invalid_request", "Hosted provider connections require an OAuth credential");
  }
  const oauth = value as { access?: unknown; refresh?: unknown; expires?: unknown };
  if (
    typeof oauth.access !== "string"
    || !oauth.access
    || typeof oauth.refresh !== "string"
    || !oauth.refresh
    || typeof oauth.expires !== "number"
    || !Number.isFinite(oauth.expires)
  ) {
    throw new FlockError("invalid_request", "OAuth credential is invalid");
  }
  return value as Credential;
}

function requireThinkingLevel(value: unknown): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  if (!levels.includes(value as (typeof levels)[number])) {
    throw new FlockError("invalid_request", `thinkingLevel must be one of ${levels.join(", ")}`);
  }
  return value as (typeof levels)[number];
}

function requireDesiredState(value: unknown): "running" | "stopped" {
  if (value !== "running" && value !== "stopped") {
    throw new FlockError("invalid_request", "desiredState must be running or stopped");
  }
  return value;
}

function authenticateAgentRequest(request: IncomingMessage, database: ControlDatabase) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new FlockError("unauthorized", "Agent bearer token is required", 401);
  }
  const agent = database.authenticateAgent(authorization.slice("Bearer ".length));
  if (!agent) throw new FlockError("unauthorized", "Invalid agent bearer token", 401);
  return agent;
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
