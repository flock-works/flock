import assert from "node:assert/strict";
import test from "node:test";
import type { AuthEvent, OAuthCredential } from "@earendil-works/pi-ai";
import {
  createFlockModels,
  fetchNousModels,
  loginNousPortal,
  MemoryCredentialStore,
  refreshNousCredential,
} from "../../src/shared/nous-provider.ts";

const portalUrl = "https://portal.nous.example";
const inferenceUrl = "https://inference.nous.example/v1";

test("Nous device login reports the code, handles polling backoff, and stores renewable OAuth state", async () => {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const events: AuthEvent[] = [];
  const responses = [
    json({
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri: `${portalUrl}/activate`,
      verification_uri_complete: `${portalUrl}/activate?user_code=ABCD-EFGH`,
      expires_in: 900,
      interval: 1,
    }),
    json({ error: "authorization_pending" }, 400),
    json({ error: "slow_down" }, 400),
    json({
      access_token: "access-jwt",
      refresh_token: "refresh-secret",
      expires_in: 3600,
      scope: "inference:invoke",
    }),
  ];
  const credential = await loginNousPortal(
    {
      notify: (event) => events.push(event),
      prompt: async () => "",
    },
    {
      clientId: "flock-test",
      portalUrl,
      inferenceUrl,
      fetchFn: async () => responses.shift()!,
      now: () => clock,
      sleepFn: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    },
  );

  assert.deepEqual(events, [{
    type: "device_code",
    userCode: "ABCD-EFGH",
    verificationUri: `${portalUrl}/activate?user_code=ABCD-EFGH`,
    intervalSeconds: 1,
    expiresInSeconds: 900,
  }]);
  assert.deepEqual(sleeps, [1_000, 6_000]);
  assert.equal(credential.type, "oauth");
  assert.equal(credential.access, "access-jwt");
  assert.equal(credential.refresh, "refresh-secret");
  assert.equal(credential.clientId, "flock-test");
  assert.equal(credential.portalBaseUrl, portalUrl);
  assert.equal(credential.inferenceBaseUrl, inferenceUrl);
  assert.equal(credential.expires, clock + 3_600_000 - 120_000);
});

test("Nous login rejects verification links outside the configured Portal origin", async () => {
  await assert.rejects(
    loginNousPortal(
      { notify() {}, prompt: async () => "" },
      {
        clientId: "flock-test",
        portalUrl,
        inferenceUrl,
        fetchFn: async () => json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: `${portalUrl}/activate`,
          verification_uri_complete: "https://phishing.example/activate",
          expires_in: 900,
          interval: 1,
        }),
      },
    ),
    /unexpected origin/u,
  );
});

test("Nous device login reports denial, expiry, cancellation, and malformed token responses", async (t) => {
  await t.test("denied", async () => {
    await assert.rejects(
      loginWithResponses([
        deviceResponse(),
        json({ error: "access_denied" }, 400),
      ]),
      /login was denied/u,
    );
  });

  await t.test("expired", async () => {
    let clock = 10_000;
    await assert.rejects(
      loginWithResponses(
        [
          deviceResponse({ expires_in: 1 }),
          json({ error: "authorization_pending" }, 400),
        ],
        {
          now: () => clock,
          sleepFn: async (milliseconds) => {
            clock += milliseconds;
          },
        },
      ),
      /login expired/u,
    );
  });

  await t.test("cancelled", async () => {
    const controller = new AbortController();
    await assert.rejects(
      loginWithResponses(
        [deviceResponse()],
        {},
        {
          signal: controller.signal,
          notify: () => controller.abort(new Error("cancelled by user")),
          prompt: async () => "",
        },
      ),
      /cancelled by user/u,
    );
  });

  await t.test("malformed token", async () => {
    await assert.rejects(
      loginWithResponses([
        deviceResponse(),
        json({ refresh_token: "refresh-only", expires_in: 3600 }),
      ]),
      /token response is invalid/u,
    );
  });

  await t.test("missing inference scope", async () => {
    await assert.rejects(
      loginWithResponses([
        deviceResponse(),
        json({
          access_token: "access-jwt",
          refresh_token: "refresh-secret",
          expires_in: 3600,
          scope: "profile",
        }),
      ]),
      /missing the inference:invoke scope/u,
    );
  });
});

test("Nous refresh accepts rotated refresh tokens and remains pinned to configured inference", async () => {
  const current: OAuthCredential = {
    type: "oauth",
    access: "old-access",
    refresh: "old-refresh",
    expires: 0,
    clientId: "flock-test",
    portalBaseUrl: portalUrl,
    inferenceBaseUrl: inferenceUrl,
  };
  let requestBody = "";
  const refreshed = await refreshNousCredential(current, {
    fetchFn: async (_url, init) => {
      requestBody = String(init?.body);
      return json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });
    },
    now: () => 5_000,
  });

  assert.match(requestBody, /grant_type=refresh_token/u);
  assert.match(requestBody, /refresh_token=old-refresh/u);
  assert.equal(refreshed.access, "new-access");
  assert.equal(refreshed.refresh, "new-refresh");
  assert.equal(refreshed.inferenceBaseUrl, inferenceUrl);
});

test("Nous catalog keeps nested model ids and enriches known OpenRouter models", async () => {
  const credential: OAuthCredential = {
    type: "oauth",
    access: "catalog-access",
    refresh: "catalog-refresh",
    expires: Date.now() + 60_000,
    inferenceBaseUrl: inferenceUrl,
  };
  const models = await fetchNousModels(credential, {
    fetchFn: async (url, init) => {
      assert.equal(url.toString(), `${inferenceUrl}/models`);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer catalog-access");
      return json({
        data: [
          { id: "anthropic/claude-sonnet-4.6" },
          { id: "nous/custom-agent-model" },
        ],
      });
    },
  });

  assert.deepEqual(models.map((model) => model.id), [
    "anthropic/claude-sonnet-4.6",
    "nous/custom-agent-model",
  ]);
  assert.ok(models.every((model) => model.provider === "nous"));
  assert.equal(models[1]?.baseUrl, inferenceUrl);
});

test("Flock model registry retains the selected Nous model through catalog outages", async () => {
  const credentials = new MemoryCredentialStore();
  await credentials.modify("nous", async () => ({
    type: "oauth",
    access: "seed-access",
    refresh: "seed-refresh",
    expires: Date.now() + 60_000,
    inferenceBaseUrl: inferenceUrl,
  }));
  const models = createFlockModels({
    credentials,
    seedModelIds: ["nous/anthropic/claude-sonnet-4.6"],
    fetchFn: async () => {
      throw new Error("temporary catalog outage");
    },
  });
  const refreshed = await models.refresh({ allowNetwork: true });
  const model = models.getModel("nous", "anthropic/claude-sonnet-4.6");
  assert.match(refreshed.errors.get("nous")?.message ?? "", /temporary catalog outage/u);
  assert.ok(model);
  assert.equal(model.provider, "nous");
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deviceResponse(overrides: Record<string, unknown> = {}): Response {
  return json({
    device_code: "device-secret",
    user_code: "ABCD-EFGH",
    verification_uri: `${portalUrl}/activate`,
    expires_in: 900,
    interval: 1,
    ...overrides,
  });
}

function loginWithResponses(
  responses: Response[],
  options: Parameters<typeof loginNousPortal>[1] = {},
  interaction: Parameters<typeof loginNousPortal>[0] = {
    notify() {},
    prompt: async () => "",
  },
) {
  return loginNousPortal(interaction, {
    clientId: "flock-test",
    portalUrl,
    inferenceUrl,
    sleepFn: async () => {},
    ...options,
    fetchFn: async () => {
      const response = responses.shift();
      assert.ok(response, "unexpected Nous request");
      return response;
    },
  });
}
