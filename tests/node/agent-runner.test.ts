import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { AgentConfig } from "../../src/agent/config.ts";
import type { ActiveLease } from "../../src/agent/client.ts";
import { PiAgentRunner } from "../../src/agent/runner.ts";
import { SessionMirror } from "../../src/agent/session-mirror.ts";
import type { JobStart } from "../../src/shared/protocol.ts";

function config(workspace: string, dataRoot: string): AgentConfig {
  return {
    hubUrl: "http://127.0.0.1:4747",
    agentId: "agt_test",
    projectId: "prj_test",
    token: "agt_test.secret",
    name: "shark",
    workspace,
    model: "faux/faux-1",
    thinkingLevel: "low",
    dataRoot,
  };
}

function header() {
  return {
    type: "session" as const,
    version: 3 as const,
    id: "session-test",
    timestamp: new Date().toISOString(),
    cwd: "flock://project/test",
  };
}

function job(baseEntryId: string, recovery = false): JobStart {
  return {
    type: "job.start",
    protocolVersion: 1,
    jobId: "job_test",
    dispatchId: "dsp_test",
    projectId: "prj_test",
    leaseId: "lease_test",
    leaseEpoch: recovery ? 2 : 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    baseEntryId,
    prompt: "Inspect the input and respond",
    recovery,
    originalAgentId: "agt_test",
  };
}

function leaseFor(
  start: JobStart,
  initialLeaf: string,
  entries: SessionTreeEntry[],
): ActiveLease {
  let leaf = initialLeaf;
  return {
    job: start,
    signal: new AbortController().signal,
    async append(entry) {
      assert.equal(entry.parentId, leaf);
      entries.push(entry);
      leaf = entry.id;
    },
    publish() {},
  };
}

test("minimal Pi runner persists user, tool, result, and final messages through the lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flock-runner-test-"));
  await writeFile(join(directory, "input.txt"), "hello from the workspace\n");
  const dispatch: SessionTreeEntry = {
    type: "custom",
    id: "dispatch-entry",
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "flock.dispatch",
    data: {},
  };
  const mirror = new SessionMirror(join(directory, "session.jsonl"));
  await mirror.applySnapshot(header(), [{ seq: 1, entry: dispatch }], dispatch.id);

  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The workspace says hello."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const appended: SessionTreeEntry[] = [];
  const runner = new PiAgentRunner(config(directory, directory), mirror, models);
  const result = await runner.execute(leaseFor(job(dispatch.id), dispatch.id, appended));

  assert.equal(result.outcome, "completed");
  assert.equal(result.leafId, appended.at(-1)?.id);
  assert.deepEqual(
    appended.map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),
    ["custom", "user", "assistant", "toolResult", "assistant"],
  );
  const toolResult = appended.find(
    (entry) => entry.type === "message" && entry.message.role === "toolResult",
  );
  assert.ok(toolResult && toolResult.type === "message" && toolResult.message.role === "toolResult");
  assert.match(
    toolResult.message.content.map((content) => ("text" in content ? content.text : "")).join(""),
    /hello from the workspace/,
  );
});

test("recovery converts an unknown tool execution into an error instead of replaying it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flock-recovery-test-"));
  const dispatch: SessionTreeEntry = {
    type: "custom",
    id: "dispatch-entry",
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "flock.dispatch",
    data: {},
  };
  const user: SessionTreeEntry = {
    type: "message",
    id: "user-entry",
    parentId: dispatch.id,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "Create a marker", timestamp: Date.now() },
  };
  const assistant: SessionTreeEntry = {
    type: "message",
    id: "assistant-tool-entry",
    parentId: user.id,
    timestamp: new Date().toISOString(),
    message: fauxAssistantMessage(
      fauxToolCall("bash", { command: "touch replayed-by-mistake" }, { id: "unknown-call" }),
      { stopReason: "toolUse" },
    ),
  };
  const mirror = new SessionMirror(join(directory, "session.jsonl"));
  await mirror.applySnapshot(
    header(),
    [dispatch, user, assistant].map((entry, index) => ({ seq: index + 1, entry })),
    assistant.id,
  );

  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("Recovered without replaying the unknown command.")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const appended: SessionTreeEntry[] = [];
  const runner = new PiAgentRunner(config(directory, directory), mirror, models);
  const result = await runner.execute(
    leaseFor(job(assistant.id, true), assistant.id, appended),
  );

  assert.equal(result.outcome, "completed");
  const synthetic = appended.find(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolCallId === "unknown-call",
  );
  assert.ok(synthetic && synthetic.type === "message" && synthetic.message.role === "toolResult");
  assert.equal(synthetic.message.isError, true);
  await assert.rejects(access(join(directory, "replayed-by-mistake")));
});

