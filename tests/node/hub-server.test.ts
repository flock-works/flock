import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { TestAuthenticator } from "../../src/hub/auth.ts";
import type { HubConfig } from "../../src/hub/config.ts";
import { HubServer } from "../../src/hub/hub-server.ts";
import { LeaderLock } from "../../src/hub/leader-lock.ts";
import { PROTOCOL_VERSION, type HubAgentMessage } from "../../src/shared/protocol.ts";

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
      clientId: "flock-test",
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
    match: (message: HubAgentMessage) => boolean;
    resolve: (message: HubAgentMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as HubAgentMessage;
      const index = this.waiters.findIndex((waiter) => waiter.match(message));
      if (index < 0) {
        this.pending.push(message);
        return;
      }
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(message);
    });
    socket.once("close", () => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("WebSocket closed before the expected message arrived"));
      }
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
        match: (message) => message.type === type,
        resolve: (message) => resolve(message as Extract<HubAgentMessage, { type: Type }>),
        reject,
        timer,
      });
    });
  }
}

test("hub completes an authenticated agent job and selects its only branch", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "flock-hub-test-"));
  const hub = new HubServer({
    config: testConfig(dataRoot),
    authenticator: new TestAuthenticator(),
  });
  await hub.start();
  context.after(async () => hub.stop());
  const address = hub.address;
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const projectResponse = await jsonRequest<{
    project: { id: string };
  }>(baseUrl, "/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Demo", slug: "demo" }),
  });
  assert.equal(projectResponse.status, 201);
  const projectId = projectResponse.body.project.id;

  const enrollmentResponse = await jsonRequest<{
    enrollment: { secret: string };
  }>(baseUrl, `/api/v1/projects/${projectId}/enrollments`, {
    method: "POST",
    body: JSON.stringify({ name: "shark" }),
  });
  assert.equal(enrollmentResponse.status, 201);

  const onboardingResponse = await jsonRequest<{
    enrollment: { name: string; expiresAt: string };
    nous: {
      enabled: boolean;
      clientId: string;
      portalUrl: string;
      inferenceUrl: string;
    };
  }>(baseUrl, "/api/v1/agents/onboarding", {
    method: "POST",
    body: JSON.stringify({ enrollmentToken: enrollmentResponse.body.enrollment.secret }),
  });
  assert.equal(onboardingResponse.status, 200);
  assert.equal(onboardingResponse.body.enrollment.name, "shark");
  assert.deepEqual(onboardingResponse.body.nous, {
    enabled: true,
    clientId: "flock-test",
    portalUrl: "https://portal.nousresearch.com/",
    inferenceUrl: "https://inference-api.nousresearch.com/v1",
  });

  const agentResponse = await jsonRequest<{
    agent: { id: string };
    token: string;
  }>(baseUrl, "/api/v1/agents/enroll", {
    method: "POST",
    body: JSON.stringify({
      enrollmentToken: enrollmentResponse.body.enrollment.secret,
      capabilities,
    }),
  });
  assert.equal(agentResponse.status, 201);

  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/v1/agent/socket`,
    { headers: { Authorization: `Bearer ${agentResponse.body.token}` } },
  );
  context.after(() => socket.close());
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const messages = new MessageQueue(socket);
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      agentId: agentResponse.body.agent.id,
      projectId,
      resumeCursor: 0,
      capabilities,
    }),
  );
  const snapshot = await messages.next("session.snapshot");
  assert.equal(snapshot.cursor, 0);

  const dispatchResponse = await jsonRequest<{
    dispatch: { id: string };
    jobs: Array<{ id: string }>;
  }>(baseUrl, `/api/v1/projects/${projectId}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      text: "Say hello",
      targetAgentIds: [agentResponse.body.agent.id],
    }),
  });
  assert.equal(dispatchResponse.status, 201);
  const dispatchList = await jsonRequest<{
    dispatches: Array<{
      id: string;
      author: { sub: string; email: string; displayName: string; role: string } | null;
    }>;
  }>(baseUrl, `/api/v1/projects/${projectId}/dispatches`);
  assert.deepEqual(dispatchList.body.dispatches[0]?.author, {
    sub: "test-user",
    email: "test@example.com",
    displayName: "Test User",
    role: "admin",
  });
  const job = await messages.next("job.start");
  assert.equal(job.jobId, dispatchResponse.body.jobs[0]!.id);
  assert.equal(job.recovery, false);

  socket.send(
    JSON.stringify({
      type: "job.accept",
      protocolVersion: PROTOCOL_VERSION,
      jobId: job.jobId,
      leaseId: job.leaseId,
      leaseEpoch: job.leaseEpoch,
    }),
  );
  const entryId = "agent-output-1";
  socket.send(
    JSON.stringify({
      type: "entry.append",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "request-append-1",
      jobId: job.jobId,
      leaseId: job.leaseId,
      leaseEpoch: job.leaseEpoch,
      idempotencyKey: "idempotency-append-1",
      entry: {
        type: "custom",
        customType: "flock.test",
        data: { answer: "hello" },
        id: entryId,
        parentId: job.baseEntryId,
        timestamp: new Date().toISOString(),
      },
    }),
  );
  const acknowledgement = await messages.next("entry.ack");
  assert.equal(acknowledgement.entryId, entryId);
  assert.equal(acknowledgement.duplicate, false);

  socket.send(
    JSON.stringify({
      type: "job.finished",
      protocolVersion: PROTOCOL_VERSION,
      jobId: job.jobId,
      leaseId: job.leaseId,
      leaseEpoch: job.leaseEpoch,
      leafId: entryId,
      outcome: "completed",
    }),
  );

  const tree = await eventually(async () => {
    const response = await jsonRequest<{
      session: {
        entries: Array<{ seq: number; entry: { type: string; targetId?: string } }>;
        selectedLeafId: string | null;
      };
    }>(baseUrl, `/api/v1/projects/${projectId}/tree`);
    return response.body.session.entries.some(
      ({ entry }) => entry.type === "leaf" && entry.targetId === entryId,
    )
      ? response.body.session
      : undefined;
  });
  assert.equal(tree.selectedLeafId, entryId);
  assert.equal(tree.entries.length, 3);

  socket.send(
    JSON.stringify({
      type: "entry.append",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "request-stale-1",
      jobId: job.jobId,
      leaseId: job.leaseId,
      leaseEpoch: job.leaseEpoch,
      idempotencyKey: "idempotency-stale-1",
      entry: {
        type: "custom",
        customType: "flock.test",
        data: {},
        id: "too-late-entry",
        parentId: entryId,
        timestamp: new Date().toISOString(),
      },
    }),
  );
  const stale = await messages.next("error");
  assert.equal(stale.code, "stale_lease");
  assert.equal(stale.requestId, "request-stale-1");

  const reconnect = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/v1/agent/socket`,
    { headers: { Authorization: `Bearer ${agentResponse.body.token}` } },
  );
  context.after(() => reconnect.close());
  await new Promise<void>((resolve, reject) => {
    reconnect.once("open", resolve);
    reconnect.once("error", reject);
  });
  const reconnectMessages = new MessageQueue(reconnect);
  reconnect.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      agentId: agentResponse.body.agent.id,
      projectId,
      resumeCursor: 999,
      capabilities,
    }),
  );
  const repairedSnapshot = await reconnectMessages.next("session.snapshot");
  assert.equal(repairedSnapshot.cursor, 3);

  const revoked = await jsonRequest<{
    agent: { id: string; status: string; revokedAt: string | null };
  }>(baseUrl, `/api/v1/agents/${agentResponse.body.agent.id}`, {
    method: "DELETE",
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.agent.id, agentResponse.body.agent.id);
  assert.equal(revoked.body.agent.status, "revoked");
  assert.ok(revoked.body.agent.revokedAt);

  const rejectedReconnect = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/v1/agent/socket`,
    { headers: { Authorization: `Bearer ${agentResponse.body.token}` } },
  );
  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      rejectedReconnect.once("open", resolve);
      rejectedReconnect.once("error", reject);
    }),
    /Unexpected server response: 401/,
  );
});

test("members cannot revoke local agents", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "flock-member-revoke-test-"));
  const hub = new HubServer({
    config: testConfig(dataRoot),
    authenticator: new TestAuthenticator({
      sub: "member-user",
      email: "member@example.com",
      displayName: "Member User",
      role: "member",
    }),
  });
  await hub.start();
  context.after(async () => hub.stop());
  const address = hub.address;
  const runtime = hub.activeRuntime;
  assert.ok(address);
  assert.ok(runtime);
  const project = await runtime.createProject({ name: "Demo", slug: "demo" });
  const enrollment = runtime.database.createEnrollment({
    projectId: project.id,
    nameHint: "shark",
    createdBy: "owner",
  });
  const enrolled = runtime.database.enrollAgent({
    enrollmentSecret: enrollment.secret,
    capabilities,
  });

  const response = await jsonRequest<{ error: { code: string } }>(
    `http://127.0.0.1:${address.port}`,
    `/api/v1/agents/${enrolled.agent.id}`,
    { method: "DELETE" },
  );
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "forbidden");
  assert.equal(runtime.database.getAgent(enrolled.agent.id)?.revokedAt, null);
});

test("only one leader lock may own a shared hub directory", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "flock-leader-test-"));
  const first = new LeaderLock(dataRoot, "node-first");
  const second = new LeaderLock(dataRoot, "node-second");
  context.after(async () => {
    await second.release();
    await first.release();
  });

  const state = await first.acquire();
  assert.equal(state.nodeId, "node-first");
  await assert.rejects(() => second.acquire(), /Another hub node/);
  await first.release();
  assert.equal((await second.acquire()).nodeId, "node-second");
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
