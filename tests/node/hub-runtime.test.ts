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

test("runtime serializes concurrent dispatch creation per project", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "flock-runtime-concurrency-test-"));
  const runtime = await HubRuntime.open(dataRoot);
  context.after(() => runtime.close());
  const project = await runtime.createProject({ name: "Demo", slug: "demo" });
  const agent = runtime.database.enrollAgent({
    enrollmentSecret: runtime.database.createEnrollment({
      projectId: project.id,
      nameHint: "shark",
      createdBy: "owner",
    }).secret,
    capabilities,
  }).agent;

  const results = await Promise.allSettled([
    runtime.createDispatch({
      projectId: project.id,
      text: "First concurrent task",
      targetAgentIds: [agent.id],
      userSub: "owner",
    }),
    runtime.createDispatch({
      projectId: project.id,
      text: "Second concurrent task",
      targetAgentIds: [agent.id],
      userSub: "owner",
    }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.match(String(rejected.reason), /active dispatch/);
  assert.equal(runtime.database.listDispatches(project.id).length, 1);
  assert.equal(runtime.getSession(project.id).cursor, 1);
});

test("single completed dispatch stays unresolved until runtime auto-selection", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "flock-runtime-selection-test-"));
  const runtime = await HubRuntime.open(dataRoot);
  context.after(() => runtime.close());
  const project = await runtime.createProject({ name: "Demo", slug: "demo" });
  const agent = runtime.database.enrollAgent({
    enrollmentSecret: runtime.database.createEnrollment({
      projectId: project.id,
      nameHint: "shark",
      createdBy: "owner",
    }).secret,
    capabilities,
  }).agent;
  const created = await runtime.createDispatch({
    projectId: project.id,
    text: "Complete one task",
    targetAgentIds: [agent.id],
    userSub: "owner",
  });
  const offered = runtime.database.nextJobForAgent(agent.id, 10_000);
  assert.ok(offered?.leaseId);
  const running = runtime.database.acceptJob({
    jobId: offered.id,
    agentId: agent.id,
    leaseId: offered.leaseId,
    leaseEpoch: offered.leaseEpoch,
  });
  const outputId = "single-output";
  await runtime.appendJobEntry({
    job: running,
    agentId: agent.id,
    entry: {
      type: "custom",
      customType: "flock.test",
      data: { complete: true },
      id: outputId,
      parentId: created.entry.entry.id,
      timestamp: new Date().toISOString(),
    },
  });
  const finished = runtime.database.finishJob({
    jobId: running.id,
    agentId: agent.id,
    leaseId: running.leaseId!,
    leaseEpoch: running.leaseEpoch,
    status: "completed",
    leafId: outputId,
  });

  assert.equal(runtime.database.getDispatch(created.dispatch.id)?.status, "awaiting_selection");
  assert.equal(runtime.database.hasUnresolvedDispatch(project.id), true);
  await assert.rejects(
    () =>
      runtime.createDispatch({
        projectId: project.id,
        text: "Must wait for selection",
        targetAgentIds: [agent.id],
        userSub: "owner",
      }),
    /active dispatch/,
  );

  const selection = await runtime.autoSelectSingleJob(finished);
  assert.ok(selection);
  assert.equal(runtime.database.getDispatch(created.dispatch.id)?.status, "completed");
  assert.equal(runtime.database.getDispatch(created.dispatch.id)?.selectedLeafId, outputId);
  assert.equal(runtime.database.hasUnresolvedDispatch(project.id), false);
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

test("hub startup resets transient agent presence without changing attention or revoked states", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "flock-presence-reset-test-"));
  const first = await HubRuntime.open(dataRoot);
  const project = await first.createProject({ name: "Demo", slug: "demo" });
  const agents = ["online", "busy", "attention", "revoked"].map((name) =>
    first.database.enrollAgent({
      enrollmentSecret: first.database.createEnrollment({
        projectId: project.id,
        nameHint: name,
        createdBy: "owner",
      }).secret,
      capabilities,
    }).agent,
  );
  first.database.updateAgentPresence(agents[0]!.id, "online");
  first.database.updateAgentPresence(agents[1]!.id, "busy");
  first.database.updateAgentPresence(agents[2]!.id, "attention");
  first.database.revokeAgent(agents[3]!.id, "owner");
  first.close();

  const reopened = await HubRuntime.open(dataRoot);
  assert.equal(reopened.database.getAgent(agents[0]!.id)?.status, "offline");
  assert.equal(reopened.database.getAgent(agents[1]!.id)?.status, "offline");
  assert.equal(reopened.database.getAgent(agents[2]!.id)?.status, "attention");
  assert.equal(reopened.database.getAgent(agents[3]!.id)?.status, "revoked");
  reopened.close();
});
