import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentInstallCommand } from "../../src/shared/install-command.ts";

test("builds one shell-independent agent installation command", () => {
  const command = buildAgentInstallCommand("http://[::1]:4747", "enr_example.secret");

  assert.equal(
    command,
    'npx --yes @flock-works/flock@latest agent install --hub "http://[::1]:4747" --enrollment "enr_example.secret" --workspace "."',
  );
  assert.doesNotMatch(command, /&&|\$PWD|%CD%/u);
});

test("rejects values that could escape the cross-platform quoting", () => {
  assert.throws(
    () => buildAgentInstallCommand("https://flock.example.com", 'enr_example."secret'),
    /cannot contain quotes or newlines/u,
  );
});
