import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FlockError } from "../shared/errors.ts";

export type AgentConfig = {
  hubUrl: string;
  agentId: string;
  projectId: string;
  token: string;
  name: string;
  workspace: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  dataRoot: string;
  envFile?: string;
};

export function defaultAgentDataRoot(): string {
  const home = homedir();
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Flock");
  }
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Flock");
  return join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "flock");
}

export function defaultAgentConfigPath(dataRoot = defaultAgentDataRoot()): string {
  return join(dataRoot, "agent.json");
}

export async function saveAgentConfig(config: AgentConfig, path = defaultAgentConfigPath(config.dataRoot)): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (platform() !== "win32") await chmod(path, 0o600);
}

export async function loadAgentConfig(path = defaultAgentConfigPath()): Promise<AgentConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new FlockError("agent_config_missing", `Could not read agent configuration at ${path}`, 400, error);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new FlockError("agent_config_invalid", `Agent configuration at ${path} is invalid`);
  }
  const value = parsed as Record<string, unknown>;
  const required = (key: string): string => {
    const item = value[key];
    if (typeof item !== "string" || !item) {
      throw new FlockError("agent_config_invalid", `Agent configuration is missing ${key}`);
    }
    return item;
  };
  const thinkingLevel = required("thinkingLevel") as AgentConfig["thinkingLevel"];
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) {
    throw new FlockError("agent_config_invalid", "Agent thinkingLevel is invalid");
  }
  return {
    hubUrl: new URL(required("hubUrl")).href.replace(/\/$/, ""),
    agentId: required("agentId"),
    projectId: required("projectId"),
    token: required("token"),
    name: required("name"),
    workspace: resolve(required("workspace")),
    model: required("model"),
    thinkingLevel,
    dataRoot: resolve(required("dataRoot")),
    envFile: typeof value.envFile === "string" && value.envFile ? resolve(value.envFile) : undefined,
  };
}

export async function loadAgentEnvironment(path: string | undefined): Promise<void> {
  if (!path) return;
  const info = await stat(path);
  if (platform() !== "win32" && (info.mode & 0o077) !== 0) {
    throw new FlockError(
      "agent_env_permissions",
      `Provider environment file ${path} must not be readable by group or other users`,
    );
  }
  const content = await readFile(path, "utf8");
  for (const [index, sourceLine] of content.split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) {
      throw new FlockError("agent_env_invalid", `Invalid environment assignment at ${path}:${index + 1}`);
    }
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new FlockError("agent_env_invalid", `Invalid environment name at ${path}:${index + 1}`);
    }
    let value = normalized.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}
