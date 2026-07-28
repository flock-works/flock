import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  JsonlSessionStorage,
  NodeExecutionEnv,
  Session,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core/node";
import { PiJsonlSession } from "../../src/shared/pi-session.ts";

async function makeSession() {
  const directory = await mkdtemp(join(tmpdir(), "flock-session-test-"));
  const path = join(directory, "session.jsonl");
  const session = await PiJsonlSession.create(path, {
    projectId: "prj_test",
    projectSlug: "demo",
    sessionId: "session-test",
    createdAt: "2026-07-27T12:00:00.000Z",
  });
  return { directory, path, session };
}

function userEntry(id: string, parentId: string | null, text: string): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-07-27T12:00:01.000Z",
    message: { role: "user", content: text, timestamp: Date.parse("2026-07-27T12:00:01.000Z") },
  };
}

test("writes an exact Pi v3 tree that upstream storage opens", async () => {
  const { directory, path, session } = await makeSession();
  await session.append(userEntry("user0001", null, "hello"));
  await session.append({
    type: "custom",
    id: "custom01",
    parentId: "user0001",
    timestamp: "2026-07-27T12:00:02.000Z",
    customType: "flock.agent_turn",
    data: { jobId: "job_1", agentId: "agt_1", leaseEpoch: 1 },
  });
  await session.append(userEntry("user0002", "custom01", "branch prompt"));
  await session.append({
    type: "leaf",
    id: "leaf0001",
    parentId: "user0002",
    timestamp: "2026-07-27T12:00:03.000Z",
    targetId: "user0002",
  });

  const env = new NodeExecutionEnv({ cwd: directory });
  const upstreamStorage = await JsonlSessionStorage.open(env, path);
  const upstream = new Session(upstreamStorage);
  assert.equal((await upstream.getMetadata()).id, "session-test");
  assert.equal(await upstream.getLeafId(), "user0002");
  assert.deepEqual(
    (await upstream.getEntries()).map((entry) => entry.id),
    ["user0001", "custom01", "user0002", "leaf0001"],
  );
  assert.deepEqual(
    (await upstream.buildContext()).messages.map((message) => message.role),
    ["user", "user"],
  );
  await env.cleanup();
});

test("supports branches, cursors, idempotent appends, and explicit leaf selection", async () => {
  const { session } = await makeSession();
  await session.append(userEntry("root0001", null, "root"));
  await session.append(userEntry("branchA1", "root0001", "A"));
  await session.append(userEntry("branchB1", "root0001", "B"));

  assert.deepEqual(session.branch("branchA1").map((entry) => entry.id), ["root0001", "branchA1"]);
  assert.deepEqual(session.branch("branchB1").map((entry) => entry.id), ["root0001", "branchB1"]);
  assert.equal(session.cursor, 3);
  assert.deepEqual(session.entriesAfter(1).map((item) => item.entry.id), ["branchA1", "branchB1"]);

  const duplicate = await session.append(userEntry("branchB1", "root0001", "B"));
  assert.equal(duplicate.duplicate, true);
  assert.equal(session.cursor, 3);

  await assert.rejects(
    () => session.append(userEntry("branchB1", "root0001", "changed")),
    /different content/,
  );

  await session.append({
    type: "leaf",
    id: "leaf0002",
    parentId: "branchB1",
    timestamp: "2026-07-27T12:00:04.000Z",
    targetId: "branchA1",
  });
  assert.equal(session.leafId, "branchA1");
});

test("repairs only an invalid torn final line", async () => {
  const { path, session } = await makeSession();
  await session.append(userEntry("root0001", null, "root"));
  await appendFile(path, '{"type":"message","id":"torn');

  const repaired = await PiJsonlSession.open(path);
  assert.equal(repaired.cursor, 1);
  assert.equal(repaired.leafId, "root0001");
  assert.match(await readFile(path, "utf8"), /\n$/);

  const original = await readFile(path, "utf8");
  await writeFile(path, original.trimEnd());
  const validWithoutNewline = await PiJsonlSession.open(path);
  assert.equal(validWithoutNewline.cursor, 1);
  assert.match(await readFile(path, "utf8"), /\n$/);
});

