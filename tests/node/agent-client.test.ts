import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import type { AgentConfig } from "../../src/agent/config.ts";
import { AgentClient, type ActiveLease, type JobResult } from "../../src/agent/client.ts";
import { SessionMirror } from "../../src/agent/session-mirror.ts";
import type { HubAgentMessage, JobStart } from "../../src/shared/protocol.ts";

function job(jobId: string, leaseEpoch: number): JobStart {
  return {
    type: "job.start",
    protocolVersion: 1,
    jobId,
    dispatchId: `dsp_${jobId}`,
    projectId: "prj_test",
    leaseId: `lea_${jobId}`,
    leaseEpoch,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    baseEntryId: "entry_base",
    prompt: "Perform the task",
    recovery: leaseEpoch > 1,
    originalAgentId: "agt_test",
  };
}

test("matched job abort clears the active lease before an immediate next job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flock-agent-client-test-"));
  const config: AgentConfig = {
    hubUrl: "http://127.0.0.1:4747",
    agentId: "agt_test",
    projectId: "prj_test",
    token: "agt_test.secret",
    name: "shark",
    workspace: directory,
    model: "faux/test",
    thinkingLevel: "low",
    dataRoot: directory,
  };
  const leases: ActiveLease[] = [];
  let resolveFirst: ((result: JobResult) => void) | undefined;
  const client = new AgentClient(
    config,
    new SessionMirror(join(directory, "session.jsonl")),
    (lease) => {
      leases.push(lease);
      if (leases.length === 1) {
        return new Promise<JobResult>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ outcome: "completed", leafId: lease.job.baseEntryId });
    },
  );
  const sent: Array<Record<string, unknown>> = [];
  const internals = client as unknown as {
    socket: WebSocket;
    handleMessage(message: HubAgentMessage): Promise<void>;
  };
  internals.socket = {
    readyState: WebSocket.OPEN,
    send(payload: string) {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
    },
  } as unknown as WebSocket;

  const first = job("job_first", 1);
  await internals.handleMessage(first);
  assert.equal(leases.length, 1);

  await internals.handleMessage({
    type: "job.abort",
    protocolVersion: 1,
    jobId: first.jobId,
    leaseEpoch: first.leaseEpoch,
    reason: "Lease expired",
  });
  assert.equal(leases[0]!.signal.aborted, true);

  const second = job("job_second", 2);
  await internals.handleMessage(second);
  assert.equal(leases.length, 2);
  assert.deepEqual(
    sent.filter((message) => message.type === "job.accept").map((message) => message.jobId),
    [first.jobId, second.jobId],
  );

  resolveFirst?.({ outcome: "aborted", leafId: first.baseEntryId });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    sent.some((message) => message.type === "job.finished" && message.jobId === first.jobId),
    false,
  );
  assert.equal(
    sent.some((message) => message.type === "job.finished" && message.jobId === second.jobId),
    true,
  );
});
