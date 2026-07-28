import assert from "node:assert/strict";
import test from "node:test";
import type { Model, OAuthCredential } from "@earendil-works/pi-ai";
import {
  onboardNousModel,
  selectNousModel,
  type OnboardingTerminal,
} from "../../src/agent/nous-onboarding.ts";
import { MemoryCredentialStore } from "../../src/shared/nous-provider.ts";

function model(id: string, name: string): Model<"openai-completions"> {
  return {
    id,
    name,
    api: "openai-completions",
    provider: "nous",
    baseUrl: "https://inference.nous.example/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  };
}

function terminal(answers: string[], interactive = true) {
  let output = "";
  const value: OnboardingTerminal = {
    interactive,
    write(message) {
      output += message;
    },
    async question() {
      return answers.shift() ?? "";
    },
  };
  return { value, output: () => output };
}

test("connects Nous, persists the credential, and selects an account model", async () => {
  const io = terminal(["sol", "1"]);
  const credentials = new MemoryCredentialStore();
  const credential: OAuthCredential = {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  };

  const selected = await onboardNousModel(
    {
      hubUrl: new URL("https://hub.example"),
      enrollmentToken: "enr_example.secret",
    },
    {
      terminal: io.value,
      credentials,
      fetchFn: async () => Response.json({
        enrollment: {
          name: "shark",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        nous: {
          enabled: true,
          clientId: "flock-test",
          portalUrl: "https://portal.nous.example",
          inferenceUrl: "https://inference.nous.example/v1",
        },
      }),
      login: async (interaction) => {
        interaction.notify({
          type: "device_code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://portal.nous.example/activate?user_code=ABCD-EFGH",
        });
        return credential;
      },
      loadModels: async () => [
        model("anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6"),
        model("openai/gpt-5.6-sol", "GPT-5.6 Sol"),
      ],
    },
  );

  assert.equal(selected, "nous/openai/gpt-5.6-sol");
  assert.deepEqual(await credentials.read("nous"), credential);
  assert.match(io.output(), /Open this URL/u);
  assert.match(io.output(), /ABCD-EFGH/u);
  assert.match(io.output(), /Selected GPT-5\.6 Sol/u);
});

test("skips network onboarding outside an interactive terminal", async () => {
  const io = terminal([], false);
  let fetched = false;
  const selected = await onboardNousModel(
    {
      hubUrl: new URL("https://hub.example"),
      enrollmentToken: "enr_example.secret",
    },
    {
      terminal: io.value,
      fetchFn: async () => {
        fetched = true;
        return Response.json({});
      },
    },
  );

  assert.equal(selected, undefined);
  assert.equal(fetched, false);
});

test("falls back cleanly when the hub has no Nous client", async () => {
  const io = terminal([]);
  const selected = await onboardNousModel(
    {
      hubUrl: new URL("https://hub.example"),
      enrollmentToken: "enr_example.secret",
    },
    {
      terminal: io.value,
      fetchFn: async () => Response.json({
        enrollment: {
          name: "shark",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        nous: {
          enabled: false,
          portalUrl: "https://portal.nous.example",
          inferenceUrl: "https://inference.nous.example/v1",
        },
      }),
    },
  );

  assert.equal(selected, undefined);
  assert.match(io.output(), /FLOCK_NOUS_CLIENT_ID/u);
});

test("model selection accepts search text followed by a visible number", async () => {
  const io = terminal(["claude", "1"]);
  const selected = await selectNousModel(
    [
      model("openai/gpt-5.6-sol", "GPT-5.6 Sol"),
      model("anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6"),
    ],
    io.value,
  );

  assert.equal(selected.id, "anthropic/claude-sonnet-4.6");
});
