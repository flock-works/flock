import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { saveAgentConfig, type AgentConfig } from "../agent/config.ts";
import { toError } from "../shared/errors.ts";
import type { HubConfig } from "./config.ts";
import type { HostedAgentRecord } from "./control-db.ts";
import { ControlDatabase } from "./control-db.ts";

const execFileAsync = promisify(execFile);

export interface ContainerRuntime {
  inspect(name: string): Promise<{ id: string; running: boolean } | undefined>;
  run(input: DockerRunInput): Promise<string>;
  remove(name: string): Promise<void>;
}

export type DockerRunInput = {
  name: string;
  image: string;
  configPath: string;
  statePath: string;
  workspacePath: string;
  cpuLimit: number;
  memoryMb: number;
  pidsLimit: number;
  user: string;
};

export class DockerCliRuntime implements ContainerRuntime {
  async inspect(name: string): Promise<{ id: string; running: boolean } | undefined> {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["inspect", "--format", "{{.Id}} {{.State.Running}}", name],
        { timeout: 15_000 },
      );
      const [id, running] = stdout.trim().split(/\s+/, 2);
      return id ? { id, running: running === "true" } : undefined;
    } catch (error) {
      const stderr = typeof error === "object" && error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr)
        : "";
      if (stderr.includes("No such object")) return undefined;
      throw error;
    }
  }

  async run(input: DockerRunInput): Promise<string> {
    const { stdout } = await execFileAsync(
      "docker",
      dockerRunArguments(input),
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim();
  }

  async remove(name: string): Promise<void> {
    try {
      await execFileAsync("docker", ["rm", "--force", name], { timeout: 30_000 });
    } catch (error) {
      const stderr = typeof error === "object" && error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr)
        : "";
      if (!stderr.includes("No such container")) throw error;
    }
  }
}

export function dockerRunArguments(input: DockerRunInput): string[] {
  return [
    "run",
    "--detach",
    "--name",
    input.name,
    "--label",
    "flock.hosted-agent=true",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--cpus=${input.cpuLimit}`,
    `--memory=${input.memoryMb}m`,
    `--pids-limit=${input.pidsLimit}`,
    "--user",
    input.user,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=256m",
    "--mount",
    `type=bind,src=${input.configPath},dst=/etc/flock/agent.json,readonly`,
    "--mount",
    `type=bind,src=${input.statePath},dst=/var/lib/flock-agent`,
    "--mount",
    `type=bind,src=${input.workspacePath},dst=/workspace`,
    input.image,
    "agent",
    "run",
    "--config",
    "/etc/flock/agent.json",
  ];
}

export class HostedAgentManager {
  private readonly database: ControlDatabase;
  private readonly config: HubConfig;
  private readonly runtime: ContainerRuntime;
  private timer: NodeJS.Timeout | undefined;
  private reconciling = false;

  constructor(
    database: ControlDatabase,
    config: HubConfig,
    runtime: ContainerRuntime = new DockerCliRuntime(),
  ) {
    this.database = database;
    this.config = config;
    this.runtime = runtime;
  }

  async start(): Promise<void> {
    await this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 5_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async reconcileAgent(agentId: string): Promise<void> {
    const hosted = this.database.getHostedAgent(agentId);
    if (hosted) await this.reconcileOne(hosted);
  }

  async removeAgentContainer(agentId: string): Promise<void> {
    await this.runtime.remove(containerName(agentId));
  }

  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const hosted of this.database.listHostedAgents(true)) {
        await this.reconcileOne(hosted);
      }
      for (const hosted of this.database.listHostedAgentsDueForPurge()) {
        await this.runtime.remove(containerName(hosted.agentId));
        await rm(this.agentRoot(hosted.agentId), { recursive: true, force: true });
        this.database.purgeHostedAgent(hosted.agentId);
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOne(hosted: HostedAgentRecord): Promise<void> {
    const name = containerName(hosted.agentId);
    try {
      const existing = await this.runtime.inspect(name);
      if (hosted.deletedAt || hosted.desiredState === "stopped") {
        if (existing) await this.runtime.remove(name);
        if (!hosted.deletedAt) this.database.setHostedAgentRuntime(hosted.agentId, "stopped", { containerId: null });
        return;
      }
      const connection = this.database.getProviderConnection(hosted.connectionId);
      if (!connection || connection.status !== "connected") {
        if (existing) await this.runtime.remove(name);
        this.database.setHostedAgentRuntime(hosted.agentId, "attention", {
          error: "Provider connection is unavailable",
        });
        return;
      }
      if (existing?.running) {
        this.database.setHostedAgentRuntime(hosted.agentId, "running", {
          containerId: existing.id,
        });
        return;
      }
      if (existing) await this.runtime.remove(name);
      this.database.setHostedAgentRuntime(hosted.agentId, "starting");
      const paths = await this.prepareAgentFiles(hosted);
      const containerId = await this.runtime.run({
        name,
        image: this.config.hostedAgents.image,
        ...paths,
        cpuLimit: this.config.hostedAgents.cpuLimit,
        memoryMb: this.config.hostedAgents.memoryMb,
        pidsLimit: this.config.hostedAgents.pidsLimit,
        user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      });
      this.database.setHostedAgentRuntime(hosted.agentId, "running", { containerId });
    } catch (error) {
      this.database.setHostedAgentRuntime(hosted.agentId, "attention", {
        error: toError(error).message.slice(0, 1000),
      });
    }
  }

  private async prepareAgentFiles(hosted: HostedAgentRecord): Promise<{
    configPath: string;
    statePath: string;
    workspacePath: string;
  }> {
    const agent = this.database.getAgent(hosted.agentId);
    if (!agent) throw new Error("Hosted agent identity is missing");
    const root = this.agentRoot(hosted.agentId);
    const configPath = join(root, "agent.json");
    const statePath = join(root, "state");
    const workspacePath = join(root, "workspace");
    await mkdir(statePath, { recursive: true, mode: 0o700 });
    await mkdir(workspacePath, { recursive: true, mode: 0o700 });
    const config: AgentConfig = {
      hubUrl: this.config.hostedAgents.internalHubUrl.href.replace(/\/$/, ""),
      agentId: agent.id,
      projectId: agent.projectId,
      token: this.database.hostedAgentToken(agent.id),
      name: agent.name,
      workspace: "/workspace",
      model: agent.model,
      thinkingLevel: agent.thinkingLevel as AgentConfig["thinkingLevel"],
      dataRoot: "/var/lib/flock-agent",
      credentialSource: "hub",
    };
    await saveAgentConfig(config, configPath);
    return { configPath, statePath, workspacePath };
  }

  private agentRoot(agentId: string): string {
    return join(this.config.dataRoot, "hosted-agents", agentId);
  }
}

function containerName(agentId: string): string {
  return `flock-${agentId}`.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
}
