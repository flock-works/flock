import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentClientMessage, parseHubAgentMessage, PROTOCOL_VERSION } from "../../src/shared/protocol.ts";

test("accepts versioned agent messages and rejects unknown wire shapes", () => {
  const hello = parseAgentClientMessage({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    agentId: "agt_123",
    projectId: "prj_123",
    resumeCursor: 0,
    capabilities: {
      tools: ["read"],
      platform: "linux",
      workspace: "/workspace",
      model: "openai/gpt",
      thinkingLevel: "low",
    },
  });
  assert.equal(hello.type, "hello");
  assert.throws(
    () => parseAgentClientMessage({ ...hello, protocolVersion: 99 }),
    /does not match/,
  );
  assert.throws(
    () => parseAgentClientMessage({ ...hello, surprise: true }),
    /does not match/,
  );
});

test("accepts hub snapshots with Pi entries", () => {
  const message = parseHubAgentMessage({
    type: "session.snapshot",
    protocolVersion: PROTOCOL_VERSION,
    projectId: "prj_123",
    sessionId: "session_123",
    header: { type: "session", version: 3 },
    entries: [],
    cursor: 0,
    selectedLeafId: null,
  });
  assert.equal(message.type, "session.snapshot");
});

