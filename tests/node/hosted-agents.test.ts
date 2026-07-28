import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { ControlDatabase } from "../../src/hub/control-db.ts";
import {
  dockerRunArguments,
  HostedAgentManager,
  isMissingContainerError,
  type ContainerRuntime,
  type DockerRunInput,
} from "../../src/hub/hosted-agent-manager.ts";
import { SecretBox } from "../../src/hub/secret-box.ts";
import type { HubConfig } from "../../src/hub/config.ts";
import { HubServer } from "../../src/hub/hub-server.ts";
import { TestAuthenticator } from "../../src/hub/auth.ts";
import { OAuthCoordinator } from "../../src/hub/oauth-coordinator.ts";

const key = "11".repeat(32);
const credential: Credential = {
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
};

async function makeDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "flock-hosted-db-"));
  return {
    directory,
    database: new ControlDatabase(join(directory, "control.sqlite"), key),
  };
}

test("SecretBox encrypts values and rejects tampered envelopes", () => {
  const box = new SecretBox(key);
  const sealed = box.seal({ refresh: "secret" });
  assert.doesNotMatch(sealed, /secret/u);
  assert.deepEqual(box.open(sealed), { refresh: "secret" });
  const envelope = JSON.parse(sealed) as { ciphertext: string };
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}aa`;
  assert.throws(() => box.open(JSON.stringify(envelope)), /could not be decrypted/u);
});

test("provider credentials are versioned and hosted agent metadata is secret-free", async () => {
  const { database } = await makeDatabase();
  const project = database.createProject({ name: "Demo", slug: "demo", sessionId: "session-1" });
  const connection = database.upsertProviderConnection({
    userSub: "owner",
    providerId: "openai-codex",
    label: "owner@example.com",
    credential,
  });
  const created = database.createHostedAgent({
    projectId: project.id,
    name: "cloud",
    createdBy: "owner",
    connectionId: connection.id,
    model: "openai-codex/gpt-5.2-codex",
    thinkingLevel: "medium",
    workspace: "/workspace",
  });

  assert.equal(created.agent.hosting?.connectionOwnerSub, "owner");
  assert.equal(created.agent.hosting?.providerId, "openai-codex");
  assert.doesNotMatch(JSON.stringify(created.agent), /access-token|refresh-token/u);
  assert.deepEqual(database.readHostedAgentCredential(created.agent.id).credential, credential);

  const updatedCredential: Credential = { ...credential, access: "new-access" };
  const updated = database.updateProviderCredential({
    id: connection.id,
    expectedVersion: connection.version,
    credential: updatedCredential,
  });
  assert.equal(updated.version, connection.version + 1);
  assert.throws(
    () => database.updateProviderCredential({
      id: connection.id,
      expectedVersion: connection.version,
      credential,
    }),
    /retry the refresh/u,
  );
  assert.doesNotMatch((await readFile(database.path)).toString("latin1"), /access-token|refresh-token|new-access/u);

  database.disconnectProviderConnection(connection.id, "owner");
  assert.throws(
    () => database.createDispatch({
      projectId: project.id,
      baseEntryId: null,
      customEntryId: "entry-1",
      text: "work",
      userSub: "member",
      targetAgentIds: [created.agent.id],
    }),
    /requires attention/u,
  );
  database.close();
});

test("OAuth flows bridge provider events and prompts without exposing another user's flow", async () => {
  const { database } = await makeDatabase();
  const coordinator = new OAuthCoordinator(database, async (_providerId, interaction) => {
    interaction.notify({ type: "auth_url", url: "https://provider.example/authorize" });
    const code = await interaction.prompt({ type: "manual_code", message: "Paste the callback code" });
    assert.equal(code, "authorization-code");
    return credential;
  });
  const started = coordinator.start({
    userSub: "owner",
    label: "owner@example.com",
    providerId: "anthropic",
  });
  assert.throws(() => coordinator.get(started.id, "other-user"), /belongs to another user/u);
  const prompting = await eventually(() => {
    const flow = coordinator.get(started.id, "owner");
    return flow.prompt ? flow : undefined;
  });
  assert.equal(prompting.events[0]?.type, "auth_url");
  coordinator.respond(
    prompting.id,
    "owner",
    prompting.prompt!.id,
    "authorization-code",
  );
  const completed = await eventually(() => {
    const flow = coordinator.get(started.id, "owner");
    return flow.status === "completed" ? flow : undefined;
  });
  assert.equal(completed.connection?.providerId, "anthropic");
  assert.equal(database.listProviderConnections("owner").length, 1);
  coordinator.close();
  database.close();
});

test("Docker arguments harden the container and expose only scoped mounts", () => {
  const args = dockerRunArguments({
    name: "flock-agt_test",
    image: "flock-agent:test",
    configPath: "/data/agent.json",
    statePath: "/data/state",
    workspacePath: "/data/workspace",
    cpuLimit: 1,
    memoryMb: 512,
    pidsLimit: 128,
    user: "1000:1000",
  });
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges"));
  assert.ok(args.includes("--pids-limit=128"));
  assert.ok(args.includes("type=bind,src=/data/workspace,dst=/workspace"));
  assert.equal(args.includes("--publish"), false);
  assert.deepEqual(args.slice(-4), ["agent", "run", "--config", "/etc/flock/agent.json"]);
});

test("Docker missing-container errors are treated as an empty runtime slot", () => {
  assert.equal(
    isMissingContainerError({ stderr: "Error: No such container: flock-agent" }),
    true,
  );
  assert.equal(
    isMissingContainerError({ stderr: "error: no such object: flock-agent" }),
    true,
  );
  assert.equal(isMissingContainerError({ stderr: "permission denied" }), false);
});

class FakeRuntime implements ContainerRuntime {
  runs: DockerRunInput[] = [];
  removed: string[] = [];
  containers = new Map<string, { id: string; running: boolean }>();

  async inspect(name: string) {
    return this.containers.get(name);
  }

  async run(input: DockerRunInput) {
    this.runs.push(input);
    this.containers.set(input.name, { id: "container-1", running: true });
    return "container-1";
  }

  async remove(name: string) {
    this.removed.push(name);
    this.containers.delete(name);
  }
}

test("hosted agent manager reconciles running and stopped desired state", async () => {
  const { database, directory } = await makeDatabase();
  const project = database.createProject({ name: "Demo", slug: "demo", sessionId: "session-1" });
  const connection = database.upsertProviderConnection({
    userSub: "owner",
    providerId: "openai-codex",
    label: "owner@example.com",
    credential,
  });
  const created = database.createHostedAgent({
    projectId: project.id,
    name: "cloud",
    createdBy: "owner",
    connectionId: connection.id,
    model: "openai-codex/gpt-5.2-codex",
    thinkingLevel: "medium",
    workspace: "/workspace",
  });
  const runtime = new FakeRuntime();
  const config = hostedConfig(directory);
  const manager = new HostedAgentManager(database, config, runtime);
  await manager.reconcile();
  assert.equal(runtime.runs.length, 1);
  assert.equal(database.getHostedAgent(created.agent.id)?.runtimeState, "running");

  database.updateHostedAgent({
    agentId: created.agent.id,
    actor: "member",
    desiredState: "stopped",
  });
  await manager.reconcile();
  assert.equal(runtime.removed.length, 1);
  assert.equal(database.getHostedAgent(created.agent.id)?.runtimeState, "stopped");
  database.close();
});

test("hosted-agent APIs create, serve scoped credentials, stop, and delete", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "flock-hosted-api-"));
  const runtime = new FakeRuntime();
  const hub = new HubServer({
    config: hostedConfig(directory),
    authenticator: new TestAuthenticator(),
    hostedAgentRuntime: runtime,
  });
  await hub.start();
  context.after(async () => hub.stop());
  const address = hub.address;
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const projectResponse = await apiRequest<{ project: { id: string } }>(
    baseUrl,
    "/api/v1/projects",
    { method: "POST", body: JSON.stringify({ name: "Demo", slug: "demo" }) },
  );
  const projectId = projectResponse.body.project.id;
  const connection = hub.activeRuntime!.database.upsertProviderConnection({
    userSub: "test-user",
    providerId: "openai-codex",
    label: "test@example.com",
    credential,
  });
  const createResponse = await apiRequest<{
    agent: { id: string; hosting: { runtimeState: string; connectionLabel: string } };
  }>(baseUrl, `/api/v1/projects/${projectId}/hosted-agents`, {
    method: "POST",
    body: JSON.stringify({
      name: "cloud-api",
      connectionId: connection.id,
      model: "openai-codex/gpt-5.4",
      thinkingLevel: "medium",
    }),
  });
  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.body.agent.hosting.connectionLabel, "test@example.com");
  assert.equal(runtime.runs.length, 1);

  const agentToken = hub.activeRuntime!.database.hostedAgentToken(createResponse.body.agent.id);
  const credentialResponse = await apiRequest<{
    providerId: string;
    credential: Credential;
    version: number;
  }>(baseUrl, "/api/v1/agent/provider-credential", {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  assert.equal(credentialResponse.status, 200);
  assert.equal(credentialResponse.body.providerId, "openai-codex");
  assert.deepEqual(credentialResponse.body.credential, credential);

  const refreshResponse = await apiRequest<{ version: number }>(
    baseUrl,
    "/api/v1/agent/provider-credential",
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({
        expectedVersion: credentialResponse.body.version,
        credential: { ...credential, access: "refreshed-access" },
      }),
    },
  );
  assert.equal(refreshResponse.status, 200);

  const stopResponse = await apiRequest<{ agent: { hosting: { desiredState: string } } }>(
    baseUrl,
    `/api/v1/hosted-agents/${createResponse.body.agent.id}`,
    { method: "PATCH", body: JSON.stringify({ desiredState: "stopped" }) },
  );
  assert.equal(stopResponse.status, 200);
  assert.equal(stopResponse.body.agent.hosting.desiredState, "stopped");

  const deleteResponse = await apiRequest(
    baseUrl,
    `/api/v1/hosted-agents/${createResponse.body.agent.id}`,
    { method: "DELETE" },
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal(hub.activeRuntime!.database.getAgent(createResponse.body.agent.id)?.status, "revoked");
});

test("Nous connection models are owner-scoped, cached, and validated before installation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "flock-nous-hosted-api-"));
  const runtime = new FakeRuntime();
  let catalogRequests = 0;
  const hub = new HubServer({
    config: hostedConfig(directory),
    authenticator: new TestAuthenticator(),
    hostedAgentRuntime: runtime,
    nousProviderOptions: {
      fetchFn: async (url, init) => {
        assert.equal(url.toString(), "https://inference.nous.example/v1/models");
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer nous-access");
        catalogRequests += 1;
        return new Response(JSON.stringify({
          data: [
            { id: "anthropic/claude-sonnet-4.6" },
            { id: "nous/custom-agent-model" },
          ],
        }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  });
  await hub.start();
  context.after(async () => hub.stop());
  const address = hub.address;
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const projectResponse = await apiRequest<{ project: { id: string } }>(
    baseUrl,
    "/api/v1/projects",
    { method: "POST", body: JSON.stringify({ name: "Nous Demo", slug: "nous-demo" }) },
  );
  const connection = hub.activeRuntime!.database.upsertProviderConnection({
    userSub: "test-user",
    providerId: "nous",
    label: "test@example.com",
    credential: {
      type: "oauth",
      access: "nous-access",
      refresh: "nous-refresh",
      expires: Date.now() + 60_000,
      clientId: "flock-test",
      portalBaseUrl: "https://portal.nous.example",
      inferenceBaseUrl: "https://inference.nous.example/v1",
    },
  });

  const catalog = await apiRequest<{
    providerId: string;
    models: Array<{ id: string; name: string }>;
  }>(baseUrl, `/api/v1/provider-connections/${connection.id}/models`);
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.providerId, "nous");
  assert.deepEqual(catalog.body.models.map((model) => model.id).sort(), [
    "anthropic/claude-sonnet-4.6",
    "nous/custom-agent-model",
  ]);

  const created = await apiRequest<{ agent: { id: string; model: string } }>(
    baseUrl,
    `/api/v1/projects/${projectResponse.body.project.id}/hosted-agents`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "nous-cloud",
        connectionId: connection.id,
        model: "nous/anthropic/claude-sonnet-4.6",
        thinkingLevel: "medium",
      }),
    },
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.agent.model, "nous/anthropic/claude-sonnet-4.6");
  assert.equal(catalogRequests, 1);
  assert.equal(runtime.runs.length, 1);

  const invalid = await apiRequest(
    baseUrl,
    `/api/v1/projects/${projectResponse.body.project.id}/hosted-agents`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "invalid-nous-cloud",
        connectionId: connection.id,
        model: "nous/not/in-the-catalog",
        thinkingLevel: "medium",
      }),
    },
  );
  assert.equal(invalid.status, 400);
  assert.equal(runtime.runs.length, 1);

  const otherConnection = hub.activeRuntime!.database.upsertProviderConnection({
    userSub: "other-user",
    providerId: "nous",
    label: "other@example.com",
    credential: {
      type: "oauth",
      access: "other-access",
      refresh: "other-refresh",
      expires: Date.now() + 60_000,
      clientId: "flock-test",
      portalBaseUrl: "https://portal.nous.example",
      inferenceBaseUrl: "https://inference.nous.example/v1",
    },
  });
  const foreignCatalog = await apiRequest(
    baseUrl,
    `/api/v1/provider-connections/${otherConnection.id}/models`,
  );
  assert.equal(foreignCatalog.status, 403);
  const foreignUpdate = await apiRequest(
    baseUrl,
    `/api/v1/hosted-agents/${created.body.agent.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ connectionId: otherConnection.id }),
    },
  );
  assert.equal(foreignUpdate.status, 403);
  assert.equal(runtime.runs.length, 1);
});

function hostedConfig(dataRoot: string): HubConfig {
  return {
    dataRoot,
    host: "127.0.0.1",
    port: 0,
    publicUrl: new URL("http://127.0.0.1"),
    trustProxy: false,
    cookieSecret: "test",
    oidc: {
      issuer: new URL("https://identity.example.test"),
      clientId: "test",
      clientSecret: "test",
      access: { mode: "groups", allowedGroup: "members", adminGroup: "admins", groupsClaim: "groups" },
    },
    leaseMs: 10_000,
    leaderLock: false,
    nous: {
      clientId: "flock-test",
      portalUrl: new URL("https://portal.nous.example"),
      inferenceUrl: new URL("https://inference.nous.example/v1"),
    },
    hostedAgents: {
      enabled: true,
      image: "flock-agent:test",
      internalHubUrl: new URL("http://hub.internal"),
      credentialKey: key,
      cpuLimit: 1,
      memoryMb: 512,
      pidsLimit: 128,
      retentionDays: 7,
    },
  };
}

async function apiRequest<Value = unknown>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Value }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1",
      ...init.headers,
    },
  });
  return { status: response.status, body: (await response.json()) as Value };
}

async function eventually<Value>(
  operation: () => Value | undefined,
  timeoutMs = 2_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = operation();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
