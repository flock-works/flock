import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { PiCredentialStore } from "../../src/agent/pi-credentials.ts";

test("PiCredentialStore reads and atomically updates Pi-compatible credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flock-pi-auth-"));
  const path = join(directory, "auth.json");
  const original: Credential = {
    type: "oauth",
    access: "access-before",
    refresh: "refresh-token",
    expires: 1,
  };
  await writeFile(path, JSON.stringify({ "openai-codex": original }), { mode: 0o600 });
  await chmod(path, 0o600);

  const store = new PiCredentialStore(path);
  assert.deepEqual(await store.read("openai-codex"), original);
  assert.deepEqual(await store.list(), [{ providerId: "openai-codex", type: "oauth" }]);

  const updated = await store.modify("openai-codex", async (current) => ({
    ...(current as Credential & { type: "oauth" }),
    access: "access-after",
    expires: 2,
  }));
  assert.equal(updated?.type, "oauth");
  assert.equal(JSON.parse(await readFile(path, "utf8"))["openai-codex"].access, "access-after");

  await store.delete("openai-codex");
  assert.equal(await store.read("openai-codex"), undefined);
});

test("PiCredentialStore refuses credential files with unsafe permissions", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows does not use POSIX permission bits");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "flock-pi-auth-permissions-"));
  const path = join(directory, "auth.json");
  await writeFile(path, "{}\n", { mode: 0o644 });
  await chmod(path, 0o644);

  await assert.rejects(
    new PiCredentialStore(path).read("openai-codex"),
    /must not be readable by group or other users/u,
  );
});
