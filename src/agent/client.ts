import { hostname, platform } from "node:os";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { WebSocket } from "ws";
import { FlockError, toError } from "../shared/errors.ts";
import { createId } from "../shared/ids.ts";
import {
  PROTOCOL_VERSION,
  parseHubAgentMessage,
  type AgentCapabilities,
  type HubAgentMessage,
  type JobStart,
} from "../shared/protocol.ts";
import type { AgentConfig } from "./config.ts";
import { SessionMirror } from "./session-mirror.ts";

export type ActiveLease = {
  job: JobStart;
  signal: AbortSignal;
  append(entry: SessionTreeEntry): Promise<void>;
  publish(event: unknown): void;
};

export type JobResult = {
  outcome: "completed" | "failed" | "aborted";
  leafId: string;
  error?: string;
};

export type JobExecutor = (lease: ActiveLease) => Promise<JobResult>;

type PendingAppend = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export class AgentClient {
  readonly config: AgentConfig;
  readonly mirror: SessionMirror;
  private readonly executeJob: JobExecutor;
  private socket: WebSocket | undefined;
  private current:
    | {
        job: JobStart;
        abort: AbortController;
        eventSeq: number;
      }
    | undefined;
  private readonly pending = new Map<string, PendingAppend>();
  private heartbeat: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(config: AgentConfig, mirror: SessionMirror, executeJob: JobExecutor) {
    this.config = config;
    this.mirror = mirror;
    this.executeJob = executeJob;
  }

  get capabilities(): AgentCapabilities {
    return {
      tools: ["read", "write", "edit", "bash"],
      platform: `${platform()}-${process.arch}`,
      workspace: this.config.workspace,
      model: this.config.model,
      thinkingLevel: this.config.thinkingLevel,
    };
  }

  async run(signal?: AbortSignal): Promise<void> {
    this.stopping = false;
    let delayMs = 500;
    while (!this.stopping && !signal?.aborted) {
      try {
        await this.connectOnce(signal);
        delayMs = 500;
      } catch (error) {
        if (this.stopping || signal?.aborted) break;
        process.stderr.write(`[flock] connection lost: ${toError(error).message}; retrying\n`);
      }
      await abortableDelay(delayMs, signal);
      delayMs = Math.min(delayMs * 2, 15_000);
    }
  }

  stop(): void {
    this.stopping = true;
    this.current?.abort.abort();
    this.socket?.close(1000, "Agent stopped");
    this.clearConnection(new Error("Agent stopped"));
  }

  private async connectOnce(signal?: AbortSignal): Promise<void> {
    const socketUrl = new URL("/api/v1/agent/socket", this.config.hubUrl);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(socketUrl, {
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "User-Agent": `flock-agent/${hostname()}`,
      },
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        socket.close();
        reject(new Error("Agent connection aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("open", () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      socket.once("error", reject);
    });

    let processing = Promise.resolve();
    socket.on("message", (data, isBinary) => {
      processing = processing
        .then(async () => {
          if (isBinary) throw new FlockError("invalid_protocol_message", "Hub sent a binary frame");
          await this.handleMessage(parseHubAgentMessage(JSON.parse(data.toString())));
        })
        .catch((error) => {
          process.stderr.write(`[flock] protocol error: ${toError(error).message}\n`);
          socket.close(1002, "Protocol error");
        });
    });
    this.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      agentId: this.config.agentId,
      projectId: this.config.projectId,
      resumeCursor: this.mirror.cursor,
      capabilities: this.capabilities,
    });
    this.heartbeat = setInterval(() => this.sendHeartbeat(), 1_000);
    this.heartbeat.unref();

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => socket.close(1000, "Agent aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("close", (code, reason) => {
        signal?.removeEventListener("abort", onAbort);
        if (code === 1000 || this.stopping || signal?.aborted) resolve();
        else reject(new Error(`Hub socket closed (${code}): ${reason.toString()}`));
      });
      socket.once("error", reject);
    }).finally(() => this.clearConnection(new Error("Hub connection closed")));
  }

  private async handleMessage(message: HubAgentMessage): Promise<void> {
    if (message.type === "session.snapshot") {
      await this.mirror.applySnapshot(
        message.header,
        message.entries as Array<{ seq: number; entry: SessionTreeEntry }>,
        message.selectedLeafId,
      );
      return;
    }
    if (message.type === "session.entries") {
      await this.mirror.applyEntries(
        message.entries as Array<{ seq: number; entry: SessionTreeEntry }>,
        message.selectedLeafId,
      );
      return;
    }
    if (message.type === "entry.ack") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      pending.resolve();
      return;
    }
    if (message.type === "error") {
      if (message.requestId) {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          this.pending.delete(message.requestId);
          pending.reject(new FlockError(message.code, message.message, 409));
          return;
        }
      }
      process.stderr.write(`[flock] hub error ${message.code}: ${message.message}\n`);
      return;
    }
    if (message.type === "job.abort") {
      if (this.current?.job.jobId === message.jobId && this.current.job.leaseEpoch === message.leaseEpoch) {
        this.current.abort.abort(new Error(message.reason));
      }
      return;
    }
    if (message.type === "job.start") await this.startJob(message);
  }

  private async startJob(job: JobStart): Promise<void> {
    if (this.current) throw new FlockError("job_overlap", "Hub offered a job while this agent was busy", 409);
    const abort = new AbortController();
    this.current = { job, abort, eventSeq: 0 };
    this.send({
      type: "job.accept",
      protocolVersion: PROTOCOL_VERSION,
      jobId: job.jobId,
      leaseId: job.leaseId,
      leaseEpoch: job.leaseEpoch,
    });
    void this.executeJob({
      job,
      signal: abort.signal,
      append: (entry) => this.append(job, entry),
      publish: (event) => {
        const current = this.current;
        if (!current || current.job.jobId !== job.jobId) return;
        current.eventSeq += 1;
        this.send({
          type: "run.event",
          protocolVersion: PROTOCOL_VERSION,
          jobId: job.jobId,
          leaseId: job.leaseId,
          leaseEpoch: job.leaseEpoch,
          eventSeq: current.eventSeq,
          event: jsonSafe(event),
        });
      },
    })
      .then((result) => {
        if (this.current?.job.jobId !== job.jobId || abort.signal.aborted) return;
        this.send({
          type: "job.finished",
          protocolVersion: PROTOCOL_VERSION,
          jobId: job.jobId,
          leaseId: job.leaseId,
          leaseEpoch: job.leaseEpoch,
          leafId: result.leafId,
          outcome: result.outcome,
          error: result.error,
        });
        this.current = undefined;
      })
      .catch((error) => {
        if (this.current?.job.jobId !== job.jobId || abort.signal.aborted) return;
        const leafId = this.mirror.selectedLeafId ?? job.baseEntryId;
        this.send({
          type: "job.finished",
          protocolVersion: PROTOCOL_VERSION,
          jobId: job.jobId,
          leaseId: job.leaseId,
          leaseEpoch: job.leaseEpoch,
          leafId,
          outcome: "failed",
          error: toError(error).message,
        });
        this.current = undefined;
      });
  }

  private append(job: JobStart, entry: SessionTreeEntry): Promise<void> {
    if (this.current?.job.jobId !== job.jobId || this.current.abort.signal.aborted) {
      return Promise.reject(new FlockError("stale_lease", "This job lease is no longer active", 409));
    }
    const requestId = createId("req");
    return new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.send({
        type: "entry.append",
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        jobId: job.jobId,
        leaseId: job.leaseId,
        leaseEpoch: job.leaseEpoch,
        idempotencyKey: `${job.jobId}:${entry.id}`,
        entry,
      });
    });
  }

  private sendHeartbeat(): void {
    const job = this.current?.job;
    this.send({
      type: "heartbeat",
      protocolVersion: PROTOCOL_VERSION,
      agentId: this.config.agentId,
      leaseId: job?.leaseId,
      leaseEpoch: job?.leaseEpoch,
      sentAt: new Date().toISOString(),
    });
  }

  private send(message: object): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private clearConnection(error: Error): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.current?.abort.abort(error);
    this.current = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.socket = undefined;
  }
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof Error) return { name: item.name, message: item.message };
      if (typeof item === "bigint") return item.toString();
      return item;
    }),
  );
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
