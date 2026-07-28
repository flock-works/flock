import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlDatabase } from "../../src/hub/control-db.ts";

const capabilities = {
  tools: ["read", "write", "edit", "bash"],
  platform: "test",
  workspace: "/workspace",
  model: "faux/test",
  thinkingLevel: "low",
};

async function makeDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "flock-db-test-"));
  return new ControlDatabase(join(directory, "control.sqlite"));
}

test("enrolls and authenticates a one-time project agent", async () => {
  const db = await makeDatabase();
  const project = db.createProject({ name: "Demo", slug: "demo", sessionId: "session-1" });
  const enrollment = db.createEnrollment({ projectId: project.id, nameHint: "shark", createdBy: "owner" });
  assert.deepEqual(db.inspectEnrollment(enrollment.secret), {
    id: enrollment.id,
    projectId: project.id,
    nameHint: "shark",
    expiresAt: enrollment.expiresAt,
  });
  const enrolled = db.enrollAgent({ enrollmentSecret: enrollment.secret, capabilities });

  assert.equal(enrolled.agent.projectId, project.id);
  assert.equal(enrolled.agent.name, "shark");
  assert.equal(db.authenticateAgent(enrolled.token)?.id, enrolled.agent.id);
  assert.equal(db.authenticateAgent(`${enrolled.agent.id}.wrong`), undefined);
  await assert.rejects(
    async () => db.enrollAgent({ enrollmentSecret: enrollment.secret, capabilities }),
    /already been used/,
  );
  assert.throws(() => db.inspectEnrollment(enrollment.secret), /already been used/);
  db.close();
});

test("offers targeted jobs and reassigns expired recovery to any project agent", async () => {
  const db = await makeDatabase();
  const project = db.createProject({ name: "Demo", slug: "demo", sessionId: "session-1" });
  const shark = db.enrollAgent({
    enrollmentSecret: db.createEnrollment({ projectId: project.id, nameHint: "shark", createdBy: "owner" }).secret,
    capabilities,
  }).agent;
  const cindy = db.enrollAgent({
    enrollmentSecret: db.createEnrollment({ projectId: project.id, nameHint: "Cindy", createdBy: "owner" }).secret,
    capabilities,
  }).agent;
  const created = db.createDispatch({
    projectId: project.id,
    baseEntryId: null,
    customEntryId: "dispatch-entry",
    text: "Implement recovery",
    userSub: "owner",
    targetAgentIds: [shark.id],
  });

  assert.equal(db.nextJobForAgent(cindy.id, 1_000), undefined);
  const offer = db.nextJobForAgent(shark.id, 1,);
  assert.ok(offer?.leaseId);
  const running = db.acceptJob({
    jobId: created.jobs[0]!.id,
    agentId: shark.id,
    leaseId: offer.leaseId,
    leaseEpoch: offer.leaseEpoch,
  });
  assert.equal(running.status, "running");

  const recovered = db.expireLeases(new Date(Date.now() + 10_000));
  assert.equal(recovered[0]?.recoveryCount, 1);
  const reassigned = db.nextJobForAgent(cindy.id, 10_000);
  assert.equal(reassigned?.assignedAgentId, cindy.id);
  assert.equal(reassigned?.recoveryCount, 1);
  db.close();
});

test("finishes multi-agent dispatches and requires selecting a completed branch", async () => {
  const db = await makeDatabase();
  const project = db.createProject({ name: "Demo", slug: "demo", sessionId: "session-1" });
  const agents = ["shark", "Cindy"].map((name) =>
    db.enrollAgent({
      enrollmentSecret: db.createEnrollment({ projectId: project.id, nameHint: name, createdBy: "owner" }).secret,
      capabilities,
    }).agent,
  );
  const { dispatch, jobs } = db.createDispatch({
    projectId: project.id,
    baseEntryId: null,
    customEntryId: "dispatch-entry",
    text: "Compare approaches",
    userSub: "owner",
    targetAgentIds: agents.map((agent) => agent.id),
  });

  for (const [index, agent] of agents.entries()) {
    const offered = db.nextJobForAgent(agent.id, 10_000);
    assert.ok(offered?.leaseId);
    db.acceptJob({ jobId: offered.id, agentId: agent.id, leaseId: offered.leaseId, leaseEpoch: offered.leaseEpoch });
    db.updateJobLeaf(offered.id, `leaf-${index}`);
    db.finishJob({
      jobId: offered.id,
      agentId: agent.id,
      leaseId: offered.leaseId,
      leaseEpoch: offered.leaseEpoch,
      status: "completed",
      leafId: `leaf-${index}`,
    });
  }

  assert.equal(db.getDispatch(dispatch.id)?.status, "awaiting_selection");
  await assert.rejects(
    async () => db.selectDispatchBranch({ dispatchId: dispatch.id, leafId: "missing", actor: "owner" }),
    /completed response branch/,
  );
  const selected = db.selectDispatchBranch({ dispatchId: dispatch.id, leafId: "leaf-1", actor: "owner" });
  assert.equal(selected.selectedLeafId, "leaf-1");
  assert.equal(selected.status, "completed");
  assert.equal(jobs.length, 2);
  db.close();
});
