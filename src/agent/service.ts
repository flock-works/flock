import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { FlockError } from "../shared/errors.ts";

export type ServiceDefinition = {
  kind: "launchd" | "systemd" | "scheduled-task";
  path?: string;
  command: string[];
};

export async function installAgentService(options: {
  configPath: string;
  executablePath?: string;
  cliPath?: string;
  start?: boolean;
}): Promise<ServiceDefinition> {
  const executable = options.executablePath ?? process.execPath;
  const cli = options.cliPath ?? process.argv[1];
  if (!cli) throw new FlockError("service_install_failed", "Could not locate the Flock CLI entry point");
  const command = [executable, cli, "agent", "run", "--config", options.configPath];
  const currentPlatform = platform();
  if (currentPlatform === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", "works.flock.agent.plist");
    const logs = join(dirname(options.configPath), "logs");
    await mkdir(logs, { recursive: true });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      launchdPlist(command, join(logs, "agent.stdout.log"), join(logs, "agent.stderr.log")),
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(path, 0o600);
    if (options.start !== false) {
      await runCommand("launchctl", ["bootout", `gui/${process.getuid?.()}`, path], true);
      await runCommand("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, path]);
    }
    return { kind: "launchd", path, command };
  }
  if (currentPlatform === "linux") {
    const path = join(homedir(), ".config", "systemd", "user", "flock-agent.service");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, systemdUnit(command), { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
    await runCommand("systemctl", ["--user", "daemon-reload"]);
    if (options.start !== false) {
      await runCommand("systemctl", ["--user", "enable", "--now", "flock-agent.service"]);
    }
    return { kind: "systemd", path, command };
  }
  if (currentPlatform === "win32") {
    const taskCommand = command.map(quoteWindows).join(" ");
    await runCommand("schtasks.exe", [
      "/Create",
      "/F",
      "/TN",
      "Flock Agent",
      "/SC",
      "ONLOGON",
      "/TR",
      taskCommand,
    ]);
    if (options.start !== false) await runCommand("schtasks.exe", ["/Run", "/TN", "Flock Agent"]);
    return { kind: "scheduled-task", command };
  }
  throw new FlockError("unsupported_platform", `Agent services are not supported on ${currentPlatform}`);
}

export async function startAgentService(): Promise<void> {
  if (platform() === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", "works.flock.agent.plist");
    await runCommand("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, path]);
    return;
  }
  if (platform() === "linux") {
    await runCommand("systemctl", ["--user", "start", "flock-agent.service"]);
    return;
  }
  if (platform() === "win32") {
    await runCommand("schtasks.exe", ["/Run", "/TN", "Flock Agent"]);
    return;
  }
  throw new FlockError("unsupported_platform", "Unsupported service platform");
}

export async function stopAgentService(ignoreFailure = false): Promise<void> {
  if (platform() === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", "works.flock.agent.plist");
    await runCommand("launchctl", ["bootout", `gui/${process.getuid?.()}`, path], ignoreFailure);
    return;
  }
  if (platform() === "linux") {
    await runCommand("systemctl", ["--user", "stop", "flock-agent.service"], ignoreFailure);
    return;
  }
  if (platform() === "win32") {
    await runCommand("schtasks.exe", ["/End", "/TN", "Flock Agent"], ignoreFailure);
    return;
  }
  throw new FlockError("unsupported_platform", "Unsupported service platform");
}

export async function uninstallAgentService(): Promise<void> {
  await stopAgentService(true);
  if (platform() === "darwin") {
    await rm(join(homedir(), "Library", "LaunchAgents", "works.flock.agent.plist"), { force: true });
    return;
  }
  if (platform() === "linux") {
    await runCommand("systemctl", ["--user", "disable", "flock-agent.service"], true);
    await rm(join(homedir(), ".config", "systemd", "user", "flock-agent.service"), { force: true });
    await runCommand("systemctl", ["--user", "daemon-reload"], true);
    return;
  }
  if (platform() === "win32") {
    await runCommand("schtasks.exe", ["/Delete", "/F", "/TN", "Flock Agent"], true);
    return;
  }
  throw new FlockError("unsupported_platform", "Unsupported service platform");
}

export async function agentServiceStatus(): Promise<string> {
  if (platform() === "darwin") {
    const result = await captureCommand("launchctl", ["print", `gui/${process.getuid?.()}/works.flock.agent`]);
    return result.ok ? result.output : "not loaded";
  }
  if (platform() === "linux") {
    const result = await captureCommand("systemctl", ["--user", "is-active", "flock-agent.service"]);
    return result.output.trim() || "unknown";
  }
  if (platform() === "win32") {
    const result = await captureCommand("schtasks.exe", ["/Query", "/TN", "Flock Agent"]);
    return result.ok ? result.output : "not installed";
  }
  return "unsupported";
}

export function launchdPlist(command: string[], stdoutPath: string, stderrPath: string): string {
  const argumentsXml = command.map((argument) => `      <string>${escapeXml(argument)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>works.flock.agent</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrPath)}</string>
  </dict>
</plist>
`;
}

export function systemdUnit(command: string[]): string {
  return `[Unit]
Description=Flock long-running Pi agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command.map(quoteSystemd).join(" ")}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function runCommand(command: string, args: string[], ignoreFailure = false): Promise<void> {
  const result = await captureCommand(command, args);
  if (!result.ok && !ignoreFailure) {
    throw new FlockError("service_command_failed", `${command} failed: ${result.output.trim()}`);
  }
}

function captureCommand(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", (error) => resolvePromise({ ok: false, output: error.message }));
    child.once("close", (code) => resolvePromise({ ok: code === 0, output }));
  });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteSystemd(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function quoteWindows(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

