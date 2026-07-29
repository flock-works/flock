import type { IncomingMessage } from "node:http";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { SequencedEntry } from "../shared/pi-session.ts";
import { WebSocket, WebSocketServer } from "ws";
import { FlockError, toError } from "../shared/errors.ts";
import {
  PROTOCOL_VERSION,
  parseAgentClientMessage,
  type AgentClientMessage,
  type HubAgentMessage,
} from "../shared/protocol.ts";
import type { AgentRecord, JobRecord } from "./control-db.ts";
import { BrowserEventBus } from "./event-bus.ts";
import { HubRuntime } from "./hub-runtime.ts";

type SocketState = {
  socket: WebSocket;
  agent: AgentRecord;
  hello: boolean;
  activeJobId: string | null;
};

export class AgentGateway {
  readonly websocketServer = new WebSocketServer({ noServer: true });
  private readonly runtime: HubRuntime;
  private readonly events: BrowserEventBus;
  private readonly leaseMs: number;
  private readonly sockets = new Map<string, SocketState>();

  constructor(runtime: HubRuntime, events: BrowserEventBus, leaseMs: number) {
    this.runtime = runtime;
    this.events = events;
    this.leaseMs = leaseMs;
  }

  authenticate(request: IncomingMessage): AgentRecord | undefined {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return undefined;
    return this.runtime.database.authenticateAgent(authorization.slice("Bearer ".length));
  }

  attach(socket: WebSocket, agent: AgentRecord): void {
    const existing = this.sockets.get(agent.id);
    if (existing) existing.socket.close(4001, "Agent connected elsewhere");
    const state: SocketState = { socket, agent, hello: false, activeJobId: null };
    this.sockets.set(agent.id, state);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.sendError(state, "binary_not_supported", "Binary protocol frames are not supported");
        return;
      }
      void this.handleMessage(state, data.toString());
    });
    socket.once("close", () => {
      if (this.sockets.get(agent.id)?.socket !== socket) return;
      this.sockets.delete(agent.id);
      this.runtime.database.updateAgentPresence(agent.id, "offline");
      this.events.publish({
        type: "presence",
        projectId: agent.projectId,
        agentId: agent.id,
        status: "offline",
        lastSeenAt: new Date().toISOString(),
      });
    });
  }

  async offerAvailableJobs(): Promise<void> {
    for (const state of this.sockets.values()) await this.tryOffer(state);
  }

  broadcastSessionEntries(projectId: string, entries: readonly SequencedEntry[]): void {
    if (entries.length === 0) return;
    const session = this.runtime.getSession(projectId);
    for (const state of this.sockets.values()) {
      if (!state.hello || state.agent.projectId !== projectId) continue;
      this.send(state, {
        type: "session.entries",
        protocolVersion: PROTOCOL_VERSION,
        projectId,
        entries: entries.map(({ seq, entry }) => ({ seq, entry })),
        cursor: session.cursor,
        selectedLeafId: session.leafId,
      });
    }
  }

  async expireLeases(): Promise<JobRecord[]> {
    const expired = this.runtime.database.expireLeases();
    for (const job of expired) {
      const previous = job.assignedAgentId ? this.sockets.get(job.assignedAgentId) : undefined;
      if (previous) {
        previous.activeJobId = null;
        this.send(previous, {
          type: "job.abort",
          protocolVersion: PROTOCOL_VERSION,
          jobId: job.id,
          leaseEpoch: job.leaseEpoch,
          reason: "Lease expired; another project agent may resume this branch",
        });
      }
      this.events.publish({
        type: "job",
        projectId: job.projectId,
        jobId: job.id,
        status: "queued",
        agentId: null,
        leafId: job.branchLeafId,
      });
    }
    if (expired.length > 0) await this.offerAvailableJobs();
    return expired;
  }

  abortJob(job: JobRecord): void {
    if (!job.assignedAgentId) return;
    const state = this.sockets.get(job.assignedAgentId);
    if (!state) return;
    this.send(state, {
      type: "job.abort",
      protocolVersion: PROTOCOL_VERSION,
      jobId: job.id,
      leaseEpoch: job.leaseEpoch,
      reason: job.error ?? "Cancelled",
    });
    state.activeJobId = null;
  }

  disconnectAgent(agentId: string, reason = "Agent access revoked"): void {
    const state = this.sockets.get(agentId);
    if (!state) return;
    this.sockets.delete(agentId);
    state.socket.close(4003, reason);
  }

  close(): void {
    for (const state of this.sockets.values()) state.socket.close(1012, "Hub shutting down");
    this.sockets.clear();
    this.websocketServer.close();
  }

  private async handleMessage(state: SocketState, raw: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.sendError(state, "invalid_json", "Protocol message was not valid JSON");
      return;
    }
    let message: AgentClientMessage;
    try {
      message = parseAgentClientMessage(value);
      if (!state.hello && message.type !== "hello") {
        throw new FlockError("hello_required", "The first agent message must be hello");
      }
      await this.dispatchMessage(state, message);
    } catch (error) {
      const cause = toError(error);
      this.sendError(
        state,
        error instanceof FlockError ? error.code : "protocol_error",
        cause.message,
        typeof value === "object" && value !== null && "requestId" in value && typeof value.requestId === "string"
          ? value.requestId
          : undefined,
      );
    }
  }

  private async dispatchMessage(state: SocketState, message: AgentClientMessage): Promise<void> {
    if (message.type === "hello") {
      if (message.agentId !== state.agent.id || message.projectId !== state.agent.projectId) {
        throw new FlockError("identity_mismatch", "Agent hello does not match the bearer token", 403);
      }
      state.hello = true;
      state.agent = this.runtime.database.updateAgentPresence(state.agent.id, "online", message.capabilities);
      const session = this.runtime.getSession(state.agent.projectId);
      const snapshotRequired = message.resumeCursor === 0 || message.resumeCursor > session.cursor;
      const entries = session.entriesAfter(
        snapshotRequired ? 0 : message.resumeCursor,
        Number.MAX_SAFE_INTEGER,
      );
      if (snapshotRequired) {
        this.send(state, {
          type: "session.snapshot",
          protocolVersion: PROTOCOL_VERSION,
          projectId: state.agent.projectId,
          sessionId: session.header.id,
          header: session.header,
          entries: entries.map(({ seq, entry }) => ({ seq, entry })),
          cursor: session.cursor,
          selectedLeafId: session.leafId,
        });
      } else {
        this.send(state, {
          type: "session.entries",
          protocolVersion: PROTOCOL_VERSION,
          projectId: state.agent.projectId,
          entries: entries.map(({ seq, entry }) => ({ seq, entry })),
          cursor: session.cursor,
          selectedLeafId: session.leafId,
        });
      }
      this.events.publish({
        type: "presence",
        projectId: state.agent.projectId,
        agentId: state.agent.id,
        status: "online",
        lastSeenAt: new Date().toISOString(),
      });
      await this.tryOffer(state);
      return;
    }

    if (message.type === "heartbeat") {
      if (message.agentId !== state.agent.id) throw new FlockError("identity_mismatch", "Heartbeat agent id mismatch", 403);
      state.agent = this.runtime.database.updateAgentPresence(state.agent.id, state.activeJobId ? "busy" : "online");
      if (state.activeJobId && message.leaseId && message.leaseEpoch) {
        this.runtime.database.renewLease({
          jobId: state.activeJobId,
          agentId: state.agent.id,
          leaseId: message.leaseId,
          leaseEpoch: message.leaseEpoch,
          leaseMs: this.leaseMs,
        });
      }
      return;
    }

    if (message.type === "job.accept") {
      const job = this.runtime.database.acceptJob({
        jobId: message.jobId,
        agentId: state.agent.id,
        leaseId: message.leaseId,
        leaseEpoch: message.leaseEpoch,
      });
      state.activeJobId = job.id;
      state.agent = this.runtime.database.updateAgentPresence(state.agent.id, "busy");
      this.events.publish({
        type: "job",
        projectId: job.projectId,
        jobId: job.id,
        status: "running",
        agentId: state.agent.id,
        leafId: job.branchLeafId,
      });
      return;
    }

    if (message.type === "entry.append") {
      const job = this.runtime.database.assertLease({
        jobId: message.jobId,
        agentId: state.agent.id,
        leaseId: message.leaseId,
        leaseEpoch: message.leaseEpoch,
      });
      const result = await this.runtime.appendJobEntry({
        job,
        agentId: state.agent.id,
        entry: message.entry as SessionTreeEntry,
      });
      this.send(state, {
        type: "entry.ack",
        protocolVersion: PROTOCOL_VERSION,
        requestId: message.requestId,
        jobId: job.id,
        entryId: result.entry.id,
        seq: result.seq,
        duplicate: result.duplicate,
      });
      this.events.publish({
        type: "entry",
        projectId: job.projectId,
        seq: result.seq,
        entry: result.entry,
      });
      this.broadcastSessionEntries(job.projectId, [result]);
      return;
    }

    if (message.type === "run.event") {
      const job = this.runtime.database.assertLease({
        jobId: message.jobId,
        agentId: state.agent.id,
        leaseId: message.leaseId,
        leaseEpoch: message.leaseEpoch,
      });
      this.events.publish({
        type: "run.event",
        projectId: job.projectId,
        jobId: job.id,
        eventSeq: message.eventSeq,
        event: message.event,
      });
      return;
    }

    if (message.type === "job.finished") {
      const job = this.runtime.database.finishJob({
        jobId: message.jobId,
        agentId: state.agent.id,
        leaseId: message.leaseId,
        leaseEpoch: message.leaseEpoch,
        status: message.outcome,
        leafId: message.leafId,
        error: message.error,
      });
      state.activeJobId = null;
      state.agent = this.runtime.database.updateAgentPresence(state.agent.id, "online");
      this.events.publish({
        type: "job",
        projectId: job.projectId,
        jobId: job.id,
        status: job.status,
        agentId: state.agent.id,
        leafId: job.branchLeafId,
      });
      const leafEntry = await this.runtime.autoSelectSingleJob(job);
      if (leafEntry) {
        this.events.publish({
          type: "entry",
          projectId: job.projectId,
          seq: leafEntry.seq,
          entry: leafEntry.entry,
        });
        this.broadcastSessionEntries(job.projectId, [leafEntry]);
      }
      await this.tryOffer(state);
    }
  }

  private async tryOffer(state: SocketState): Promise<void> {
    if (!state.hello || state.activeJobId || state.socket.readyState !== WebSocket.OPEN) return;
    const offered = this.runtime.database.nextJobForAgent(state.agent.id, this.leaseMs);
    if (!offered?.leaseId || !offered.leaseExpiresAt) return;
    state.activeJobId = offered.id;
    this.send(state, {
      type: "job.start",
      protocolVersion: PROTOCOL_VERSION,
      jobId: offered.id,
      dispatchId: offered.dispatchId,
      projectId: offered.projectId,
      leaseId: offered.leaseId,
      leaseEpoch: offered.leaseEpoch,
      leaseExpiresAt: offered.leaseExpiresAt,
      baseEntryId: offered.branchLeafId ?? offered.baseEntryId,
      prompt: offered.prompt,
      recovery: offered.recoveryCount > 0,
      originalAgentId: offered.targetAgentId,
    });
    this.events.publish({
      type: "job",
      projectId: offered.projectId,
      jobId: offered.id,
      status: "offered",
      agentId: state.agent.id,
      leafId: offered.branchLeafId,
    });
  }

  private send(state: SocketState, message: HubAgentMessage): void {
    if (state.socket.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
  }

  private sendError(state: SocketState, code: string, message: string, requestId?: string): void {
    this.send(state, { type: "error", protocolVersion: PROTOCOL_VERSION, code, message, requestId });
  }
}
