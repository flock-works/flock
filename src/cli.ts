#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { AgentClient } from "./agent/client.ts";
import {
  defaultAgentConfigPath,
  defaultAgentDataRoot,
  loadAgentEnvironment,
  loadAgentConfig,
  saveAgentConfig,
  type AgentConfig,
} from "./agent/config.ts";
import { PiAgentRunner } from "./agent/runner.ts";
import {
  agentServiceStatus,
  installAgentService,
  startAgentService,
  stopAgentService,
  uninstallAgentService,
} from "./agent/service.ts";
import { SessionMirror } from "./agent/session-mirror.ts";
import { TestAuthenticator } from "./hub/auth.ts";
import {
  hostedAgentConfigFromEnvironment,
  hubConfigFromEnvironment,
  nousConfigFromEnvironment,
  type HubConfig,
} from "./hub/config.ts";
import { HubServer } from "./hub/hub-server.ts";
import { FlockError, toError } from "./shared/errors.ts";

const program = new Command()
  .name("flock")
  .description("Pi-compatible long-running multi-agent hub and lightweight agent")
  .version("0.1.0");

const hub = program.command("hub").description("Run and administer a Flock hub");
hub
  .command("serve")
  .description("Serve the agent hub, JSONL session tree API, and web application")
  .requiredOption("--data <path>", "durable hub data directory")
  .option("--listen <host:port>", "listen address", "127.0.0.1:4747")
  .option("--public-url <url>", "browser-visible hub URL")
  .option("--trust-proxy", "trust a TLS-terminating reverse proxy", false)
  .option("--no-leader-lock", "disable the shared-directory leader lock")
  .option("--dev-auth", "use a local test identity; only valid on loopback")
  .option("--hosted-agents", "enable Docker-hosted agents")
  .option("--project-name <name>", "create an initial project on first start", "Flock Works")
  .option("--project-slug <slug>", "initial project slug", "flock-works")
  .action(async (options) => {
    const publicUrl =
      options.publicUrl ?? process.env.FLOCK_PUBLIC_URL ?? inferredPublicUrl(options.listen);
    const config = options.devAuth
      ? developmentHubConfig(
          options.data,
          options.listen,
          publicUrl,
          options.leaderLock,
          options.hostedAgents,
        )
      : hubConfigFromEnvironment({
          dataRoot: options.data,
          listen: options.listen,
          publicUrl,
          trustProxy: options.trustProxy,
          leaderLock: options.leaderLock,
          hostedAgents: options.hostedAgents,
        });
    if (options.devAuth && !["127.0.0.1", "localhost", "::1"].includes(config.publicUrl.hostname)) {
      throw new FlockError("unsafe_dev_auth", "--dev-auth may only be used with a loopback public URL");
    }
    const server = new HubServer({
      config,
      authenticator: options.devAuth ? new TestAuthenticator() : undefined,
    });
    await server.start();
    const runtime = server.activeRuntime;
    if (runtime && runtime.database.listProjects().length === 0) {
      const project = await runtime.createProject({
        name: options.projectName,
        slug: options.projectSlug,
      });
      process.stdout.write(`[flock] created project ${project.name} (${project.id})\n`);
    }
    const address = server.address;
    process.stdout.write(
      `[flock] hub ${server.isReady ? "ready" : "standby"} at ${address?.host}:${address?.port}; public URL ${config.publicUrl.href}\n`,
    );
    await untilSignal(async () => server.stop());
  });

const agent = program.command("agent").description("Install or run a lightweight Pi agent");
agent
  .command("enroll")
  .description("Exchange a one-time enrollment token for an agent identity")
  .requiredOption("--hub <url>", "hub URL")
  .requiredOption("--enrollment <token>", "one-time enrollment token")
  .requiredOption("--workspace <path>", "local agent workspace")
  .option("--name <name>", "agent display name")
  .option("--model <provider/model>", "Pi model", "anthropic/claude-sonnet-4-6")
  .option("--thinking <level>", "thinking level", "medium")
  .option("--data <path>", "agent data directory", defaultAgentDataRoot())
  .option("--env-file <path>", "protected provider credential environment file")
  .option("--config <path>", "agent config file")
  .action(async (options) => {
    const config = await enrollAgent(options);
    const configPath = options.config ?? defaultAgentConfigPath(config.dataRoot);
    await saveAgentConfig(config, configPath);
    process.stdout.write(`[flock] enrolled ${config.name}; configuration saved to ${configPath}\n`);
  });

agent
  .command("run")
  .description("Run the long-lived lightweight Pi agent in the foreground")
  .option("--config <path>", "agent config file", defaultAgentConfigPath())
  .action(async (options) => {
    const config = await loadAgentConfig(options.config);
    await loadAgentEnvironment(config.envFile);
    await mkdir(config.workspace, { recursive: true });
    const mirror = await SessionMirror.open(join(config.dataRoot, "sessions", `${config.projectId}.jsonl`));
    const runner = new PiAgentRunner(config, mirror);
    const client = new AgentClient(config, mirror, (lease) => runner.execute(lease));
    process.stdout.write(`[flock] ${config.name} connecting to ${config.hubUrl}\n`);
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await client.run(abort.signal);
  });

agent
  .command("install")
  .description("Enroll, save protected credentials, and install the native background service")
  .requiredOption("--hub <url>", "hub URL")
  .requiredOption("--enrollment <token>", "one-time enrollment token")
  .requiredOption("--workspace <path>", "local agent workspace")
  .option("--name <name>", "agent display name")
  .option("--model <provider/model>", "Pi model", "anthropic/claude-sonnet-4-6")
  .option("--thinking <level>", "thinking level", "medium")
  .option("--data <path>", "agent data directory", defaultAgentDataRoot())
  .option("--env-file <path>", "protected provider credential environment file")
  .option("--config <path>", "agent config file")
  .option("--no-start", "install without starting the service")
  .action(async (options) => {
    const config = await enrollAgent(options);
    const configPath = resolve(options.config ?? defaultAgentConfigPath(config.dataRoot));
    await saveAgentConfig(config, configPath);
    const definition = await installAgentService({ configPath, start: options.start });
    process.stdout.write(
      `[flock] installed ${config.name} as ${definition.kind}${options.start ? " and started it" : ""}\n`,
    );
  });

agent.command("start").description("Start the installed agent service").action(startAgentService);
agent.command("stop").description("Stop the installed agent service").action(() => stopAgentService());
agent.command("status").description("Show installed agent service status").action(async () => {
  process.stdout.write(`${await agentServiceStatus()}\n`);
});
agent.command("uninstall").description("Remove the native service (keeps config and session mirror)").action(async () => {
  await uninstallAgentService();
  process.stdout.write("[flock] removed the agent service; credentials and session mirror were kept\n");
});

program.parseAsync().catch((error) => {
  const cause = toError(error);
  process.stderr.write(`flock: ${cause.message}\n`);
  process.exitCode = error instanceof FlockError ? 2 : 1;
});

type EnrollmentOptions = {
  hub: string;
  enrollment: string;
  workspace: string;
  name?: string;
  model: string;
  thinking: string;
  data: string;
  envFile?: string;
};

async function enrollAgent(options: EnrollmentOptions): Promise<AgentConfig> {
  const hubUrl = new URL(options.hub);
  const workspace = resolve(options.workspace);
  const dataRoot = resolve(options.data);
  const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  if (!thinkingLevels.includes(options.thinking as (typeof thinkingLevels)[number])) {
    throw new FlockError("invalid_thinking_level", `Thinking level must be one of ${thinkingLevels.join(", ")}`);
  }
  const response = await fetch(new URL("/api/v1/agents/enroll", hubUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enrollmentToken: options.enrollment,
      name: options.name,
      capabilities: {
        tools: ["read", "write", "edit", "bash"],
        platform: `${process.platform}-${process.arch}`,
        workspace,
        model: options.model,
        thinkingLevel: options.thinking,
      },
    }),
  });
  const body = (await response.json()) as {
    agent?: { id: string; projectId: string; name: string };
    token?: string;
    error?: { message?: string };
  };
  if (!response.ok || !body.agent || !body.token) {
    throw new FlockError("enrollment_failed", body.error?.message ?? `Hub returned HTTP ${response.status}`);
  }
  return {
    hubUrl: hubUrl.href.replace(/\/$/, ""),
    agentId: body.agent.id,
    projectId: body.agent.projectId,
    token: body.token,
    name: body.agent.name,
    workspace,
    model: options.model,
    thinkingLevel: options.thinking as AgentConfig["thinkingLevel"],
    dataRoot,
    envFile: options.envFile ? resolve(options.envFile) : undefined,
  };
}

function developmentHubConfig(
  dataRoot: string,
  listen: string,
  publicUrl: string,
  leaderLock: boolean,
  hostedAgents: boolean | undefined,
): HubConfig {
  const separator = listen.lastIndexOf(":");
  const host = listen.slice(0, separator);
  const port = Number(listen.slice(separator + 1));
  if (!host || !Number.isInteger(port)) throw new FlockError("invalid_listen", "Listen address must be host:port");
  return {
    dataRoot: resolve(dataRoot),
    host,
    port,
    publicUrl: new URL(publicUrl),
    trustProxy: false,
    cookieSecret: randomBytes(32).toString("hex"),
    oidc: {
      issuer: new URL("https://identity.invalid"),
      clientId: "development",
      clientSecret: "development",
      access: {
        mode: "groups",
        allowedGroup: "members",
        adminGroup: "admins",
        groupsClaim: "groups",
      },
    },
    leaseMs: 30_000,
    leaderLock,
    nous: nousConfigFromEnvironment(),
    hostedAgents: hostedAgentConfigFromEnvironment(new URL(publicUrl), hostedAgents),
  };
}

function inferredPublicUrl(listen: string): string {
  const [host, port] = listen.split(":");
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${publicHost}:${port}`;
}

function untilSignal(cleanup: () => Promise<void>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      void cleanup().then(resolvePromise, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
