import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HubRuntime } from "../../src/hub/hub-runtime.ts";

const capabilities = {
  tools: ["read", "write", "edit", "bash"],
  platform: "test",
  workspace: "/workspace",
  model: "faux/test",
  thinkingLevel: "low",
};

test("runtime validates targets before JSONL append and serializes unresolved dispatches", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "flock-runtime-test-"));
  const runtime = await HubRuntime.open(dataRoot);
  context.after(() => runtime.close());
  const project = await runtime.createProject({ name: "Demo", slug: "demo" });
  const enrollment = runtime.database.createEnrollment({
    projectId: project.id,
    nameHint: "shark",
    createdBy: "owner",
  });
  const agent = runtime.database.enrollAgent({
    enrollmentSecret: enrollment.secret,
    capabilities,
  }).agent;

  await assert.rejects(
    () =>
      runtime.createDispatch({
        projectId: project.id,
        text: "This target is invalid",
        targetAgentIds: ["agt_missing"],
        userSub: "owner",
      }),
    /cannot receive this dispatch/,
  );
  assert.equal(runtime.getSession(project.id).cursor, 0);

  await runtime.createDispatch({
    projectId: project.id,
    text: "First task",
    targetAgentIds: [agent.id],
    userSub: "owner",
  });
  await assert.rejects(
    () =>
      runtime.createDispatch({
        projectId: project.id,
        text: "Overlapping task",
        targetAgentIds: [agent.id],
        userSub: "owner",
      }),
    /active dispatch/,
  );
});

test("hub startup rebuilds the SQLite entry index from canonical JSONL", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "flock-reconcile-test-"));
  const first = await HubRuntime.open(dataRoot);
  const project = await first.createProject({ name: "Demo", slug: "demo" });
  await first.getSession(project.id).appendGenerated(
    { type: "custom", customType: "flock.test", data: { durable: true } },
    null,
  );
  assert.equal(first.database.entryIndexCount(project.id), 0);
  first.close();

  const reopened = await HubRuntime.open(dataRoot);
  assert.equal(reopened.database.entryIndexCount(project.id), 1);
  assert.equal(reopened.getSession(project.id).cursor, 1);
  reopened.close();
});
