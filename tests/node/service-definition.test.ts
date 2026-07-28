import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgentEnvironment } from "../../src/agent/config.ts";
import { launchdPlist, systemdUnit } from "../../src/agent/service.ts";

test("native service definitions preserve command arguments and restart agents", () => {
  const command = ["/usr/local/bin/node", "/opt/Flock Agent/cli.js", "agent", "run", "--config", "/tmp/a&b.json"];
  const plist = launchdPlist(command, "/tmp/out.log", "/tmp/error.log");
  assert.match(plist, /works\.flock\.agent/);
  assert.match(plist, /<key>KeepAlive<\/key>\s+<true\/>/);
  assert.match(plist, /\/opt\/Flock Agent\/cli\.js/);
  assert.match(plist, /\/tmp\/a&amp;b\.json/);

  const unit = systemdUnit(command);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/node" "\/opt\/Flock Agent\/cli\.js"/);
});

test("agent services load protected provider credentials from an env file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flock-env-test-"));
  const path = join(directory, "provider.env");
  await writeFile(path, "export FLOCK_TEST_PROVIDER_KEY='local-only-secret'\n", "utf8");
  await chmod(path, 0o600);
  delete process.env.FLOCK_TEST_PROVIDER_KEY;
  await loadAgentEnvironment(path);
  assert.equal(process.env.FLOCK_TEST_PROVIDER_KEY, "local-only-secret");
  delete process.env.FLOCK_TEST_PROVIDER_KEY;
});
