import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { SessionMirror } from "../../src/agent/session-mirror.ts";

test("agent mirror applies snapshots and strictly ordered incremental entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flock-mirror-test-"));
  const path = join(directory, "session.jsonl");
  const mirror = new SessionMirror(path);
  const first: SessionTreeEntry = {
    type: "custom",
    id: "entry-one",
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "test",
  };
  const second: SessionTreeEntry = {
    type: "custom",
    id: "entry-two",
    parentId: first.id,
    timestamp: new Date().toISOString(),
    customType: "test",
  };
  await mirror.applySnapshot(
    {
      type: "session",
      version: 3,
      id: "session-test",
      timestamp: new Date().toISOString(),
      cwd: "flock://project/test",
    },
    [{ seq: 1, entry: first }],
    first.id,
  );
  await mirror.applyEntries([{ seq: 2, entry: second }], second.id);
  await mirror.applyEntries([{ seq: 2, entry: second }], second.id);

  assert.equal(mirror.cursor, 2);
  assert.deepEqual(mirror.branch(second.id).map((entry) => entry.id), [first.id, second.id]);
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 3);
  await assert.rejects(
    () =>
      mirror.applyEntries(
        [
          {
            seq: 4,
            entry: {
              ...second,
              id: "entry-four",
              parentId: second.id,
            },
          },
        ],
        second.id,
      ),
    /Expected session sequence 3/,
  );
});

