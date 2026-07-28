import assert from "node:assert/strict";
import test from "node:test";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import {
  FALLBACK_AGENT_MODEL,
  resolveAgentModel,
} from "../../src/agent/model-selection.ts";

function credentialStore(values: Record<string, Credential>): CredentialStore {
  return {
    async read(providerId) {
      return values[providerId];
    },
    async list() {
      return Object.entries(values).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    async modify(providerId, fn) {
      const next = await fn(values[providerId]);
      if (next !== undefined) values[providerId] = next;
      return next ?? values[providerId];
    },
    async delete(providerId) {
      delete values[providerId];
    },
  };
}

test("keeps an explicitly selected agent model", async () => {
  assert.equal(
    await resolveAgentModel("openrouter/custom/model", credentialStore({})),
    "openrouter/custom/model",
  );
});

test("selects OpenAI Codex when its saved login is the available credential", async () => {
  const credentials = credentialStore({
    "openai-codex": {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    },
  });

  assert.equal(await resolveAgentModel(undefined, credentials), "openai-codex/gpt-5.4");
});

test("preserves the Anthropic default when Anthropic is configured", async () => {
  const credentials = credentialStore({
    anthropic: { type: "api_key", key: "anthropic-key" },
    "openai-codex": {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    },
  });

  assert.equal(await resolveAgentModel(undefined, credentials), FALLBACK_AGENT_MODEL);
});

test("falls back to Anthropic when no provider credential is detectable", async () => {
  assert.equal(
    await resolveAgentModel(undefined, credentialStore({})),
    FALLBACK_AGENT_MODEL,
  );
});
