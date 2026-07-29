import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { TestAuthenticator } from "../../src/hub/auth.ts";
import type { HubConfig } from "../../src/hub/config.ts";
import { HubServer } from "../../src/hub/hub-server.ts";
import { PROTOCOL_VERSION, type HubAgentMessage, type JobStart } from "../../src/shared/protocol.ts";

const capabilities = {
  tools: ["read", "write", "edit", "bash"],
  platform: "test",
  workspace: "/workspace",
  model: "faux/test",
  thinkingLevel: "low",
};

function testConfig(dataRoot: string): HubConfig {
  return {
    dataRoot,
    host: "127.0.0.1",
    port: 0,
    publicUrl: new URL("http://127.0.0.1"),
    trustProxy: false,
    cookieSecret: "test-cookie-secret",
    oidc: {
      issuer: new URL("https://identity.example.test"),
      clientId: "test",
      clientSecret: "test",
      access: {
        mode: "groups",
        allowedGroup: "members",
        adminGroup: "admins",
        groupsClaim: "groups",
      },
    },
    leaseMs: 10_000,
    leaderLock: false,
    nous: {
      clientId: undefined,
      portalUrl: new URL("https://portal.nousresearch.com"),
      inferenceUrl: new URL("https://inference-api.nousresearch.com/v1"),
    },
    hostedAgents: {
      enabled: false,
      image: "flock-agent:test",
      internalHubUrl: new URL("http://127.0.0.1"),
      cpuLimit: 1,
      memoryMb: 512,
      pidsLimit: 128,
      retentionDays: 7,
    },
  };
}

async function jsonRequest<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1",
      ...init.headers,
    },
  });
  return { status: response.status, body: (await response.json()) as T };
}

class MessageQueue {
  private readonly pending: HubAgentMessage[] = [];
  private readonly waiters: Array<{
    type: HubAgentMessage["type"];
    resolve: (message: HubAgentMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as HubAgentMessage;
      const index = this.waiters.findIndex((waiter) => waiter.type === message.type);
      if (index < 0) {
        this.pending.push(message);
        return;
      }
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(message);
    });
  }

  next<Type extends HubAgentMessage["type"]>(
    type: Type,
  ): Promise<Extract<HubAgentMessage, { type: Type }>> {
    const existing = this.pending.findIndex((message) => message.type === type);
    if (existing >= 0) {
      return Promise.resolve(
        this.pending.splice(existing, 1)[0] as Extract<HubAgentMessage, { type: Type }>,
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 3_000);
      this.waiters.push({
        type,
        resolve: (message) => resolve(message as Extract<HubAgentMessage, { type: Type }>),
        reject,
        timer,
      });
    });
  }
}

async function connectAgent(input: {
  port: number;
  token: string;
  agentId: string;
  projectId: string;
}): Promise<{ socket: WebSocket; messages: MessageQueue }> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${input.port}/api/v1/agent/socket`,
    { headers: { Authorization: `Bearer ${input.token}` } },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const messages = new MessageQueue(socket);
  socket.send(JSON.stringify({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    agentId: input.agentId,
    projectId: input.projectId,
    resumeCursor: 0,
    capabilities,
  }));
  await messages.next("session.snapshot");
  return { socket, messages };
}

async function finishBranch(input: {
  socket: WebSocket;
  messages: MessageQueue;
  job: JobStart;
  entryId: string;
  outcome: "completed" | "failed";
}): Promise<void> {
  input.socket.send(JSON.stringify({
    type: "job.accept",
    protocolVersion: PROTOCOL_VERSION,
    jobId: input.job.jobId,
    leaseId: input.job.leaseId,
    leaseEpoch: input.job.leaseEpoch,
  }));
  input.socket.send(JSON.stringify({
    type: "entry.append",
    protocolVersion: PROTOCOL_VERSION,
    requestId: `req_${input.entryId}`,
    jobId: input.job.jobId,
    leaseId: input.job.leaseId,
    leaseEpoch: input.job.leaseEpoch,
    idempotencyKey: `${input.job.jobId}:${input.entryId}`,
    entry: {
      type: "custom",
      customType: "flock.test.response",
      data: { entryId: input.entryId },
      id: input.entryId,
      parentId: input.job.baseEntryId,
      timestamp: new Date().toISOString(),
    },
  }));
  await input.messages.next("entry.ack");
  input.socket.send(JSON.stringify({
    type: "job.finished",
    protocolVersion: PROTOCOL_VERSION,
    jobId: input.job.jobId,
    leaseId: input.job.leaseId,
    leaseEpoch: input.job.leaseEpoch,
    leafId: input.entryId,
    outcome: input.outcome,
    ...(input.outcome === "failed" ? { error: "Synthetic provider failure" } : {}),
  }));
}

test("two agents branch independently and the next turn follows the selected response", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "flock-multi-agent-server-test-"));
  const hub = new HubServer({
    config: testConfig(dataRoot),
    authenticator: new TestAuthenticator(),
  });
  await hub.start();
  context.after(async () => hub.stop());
  const address = hub.address;
  const runtime = hub.activeRuntime;
  assert.ok(address);
  assert.ok(runtime);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const project = await runtime.createProject({ name: "Demo", slug: "demo" });

  const enrolled = ["shark", "Cindy"].map((name) =>
    runtime.database.enrollAgent({
      enrollmentSecret: runtime.database.createEnrollment({
        projectId: project.id,
        nameHint: name,
        createdBy: "test-user",
      }).secret,
      capabilities,
    }),
  );
  const connections = await Promise.all(enrolled.map(({ agent, token }) =>
    connectAgent({
      port: address.port,
      token,
      agentId: agent.id,
      projectId: project.id,
    })));
  context.after(() => connections.forEach(({ socket }) => socket.close()));

  const dispatched = await jsonRequest<{
    dispatch: { id: string };
    jobs: Array<{ id: string }>;
  }>(baseUrl, `/api/v1/projects/${project.id}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      text: "Compare two approaches",
      targetAgentIds: enrolled.map(({ agent }) => agent.id),
    }),
  });
  assert.equal(dispatched.status, 201);
  assert.equal(dispatched.body.jobs.length, 2);

  const [firstJob, secondJob] = await Promise.all(
    connections.map(({ messages }) => messages.next("job.start")),
  );
  assert.equal(firstJob.baseEntryId, secondJob.baseEntryId);
  await Promise.all([
    finishBranch({
      ...connections[0]!,
      job: firstJob,
      entryId: "response-one",
      outcome: "completed",
    }),
    finishBranch({
      ...connections[1]!,
      job: secondJob,
      entryId: "response-two",
      outcome: "failed",
    }),
  ]);

  const unresolved = await eventually(async () => {
    const response = await jsonRequest<{
      dispatches: Array<{
        id: string;
        status: string;
        selectedLeafId: string | null;
      }>;
    }>(baseUrl, `/api/v1/projects/${project.id}/dispatches`);
    const dispatch = response.body.dispatches.find(({ id }) => id === dispatched.body.dispatch.id);
    return dispatch?.status === "awaiting_selection" ? dispatch : undefined;
  });
  assert.equal(unresolved.selectedLeafId, null);

  const selected = await jsonRequest<{
    dispatch: { status: string; selectedLeafId: string | null };
  }>(baseUrl, `/api/v1/dispatches/${dispatched.body.dispatch.id}/select`, {
    method: "POST",
    body: JSON.stringify({ leafId: "response-one" }),
  });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.dispatch.status, "completed");
  assert.equal(selected.body.dispatch.selectedLeafId, "response-one");

  const followup = await jsonRequest<{
    jobs: Array<{ id: string }>;
  }>(baseUrl, `/api/v1/projects/${project.id}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      text: "Continue the selected approach",
      targetAgentIds: [enrolled[0]!.agent.id],
    }),
  });
  assert.equal(followup.status, 201);
  const followupJob = await connections[0]!.messages.next("job.start");
  assert.equal(followupJob.jobId, followup.body.jobs[0]!.id);
  const tree = await jsonRequest<{
    session: {
      entries: Array<{
        entry: {
          id: string;
          parentId: string | null;
          type: string;
          customType?: string;
          data?: Record<string, unknown>;
        };
      }>;
    };
  }>(baseUrl, `/api/v1/projects/${project.id}/tree`);
  const followupEntry = tree.body.session.entries.find(({ entry }) =>
    entry.type === "custom"
    && entry.customType === "flock.dispatch"
    && entry.data?.text === "Continue the selected approach");
  assert.ok(followupEntry);
  assert.equal(followupEntry.entry.parentId, "response-one");
  assert.equal(followupJob.baseEntryId, followupEntry.entry.id);
});

async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition did not become true before timeout");
}
