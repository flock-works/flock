import { resolve } from "node:path";
import { FlockError } from "../shared/errors.ts";

export type HubConfig = {
  dataRoot: string;
  host: string;
  port: number;
  publicUrl: URL;
  trustProxy: boolean;
  cookieSecret: string;
  oidc: {
    issuer: URL;
    clientId: string;
    clientSecret: string;
    access:
      | {
          mode: "groups";
          allowedGroup: string;
          adminGroup: string;
          groupsClaim: string;
        }
      | {
          mode: "google-open";
          adminEmails: string[];
        };
  };
  leaseMs: number;
  leaderLock: boolean;
  hostedAgents: {
    enabled: boolean;
    image: string;
    internalHubUrl: URL;
    credentialKey?: string;
    cpuLimit: number;
    memoryMb: number;
    pidsLimit: number;
    retentionDays: number;
  };
};

export function parseListen(value: string): { host: string; port: number } {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) throw new FlockError("invalid_listen", "Listen address must be host:port");
  const host = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new FlockError("invalid_listen", "Listen address must be host:port");
  }
  return { host, port };
}

export function hubConfigFromEnvironment(input: {
  dataRoot: string;
  listen: string;
  publicUrl: string;
  trustProxy?: boolean;
  leaderLock?: boolean;
  hostedAgents?: boolean;
}): HubConfig {
  const { host, port } = parseListen(input.listen);
  const publicUrl = new URL(input.publicUrl);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(publicUrl.hostname);
  if (!loopback && publicUrl.protocol !== "https:") {
    throw new FlockError("https_required", "Public hub URLs must use HTTPS");
  }

  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new FlockError("missing_configuration", `${name} is required`);
    return value;
  };

  const leaseMs = Number(process.env.FLOCK_LEASE_MS ?? 30_000);
  if (!Number.isFinite(leaseMs) || leaseMs < 3_000 || leaseMs > 10 * 60_000) {
    throw new FlockError("invalid_configuration", "FLOCK_LEASE_MS must be between 3000 and 600000");
  }

  const hostedAgents = hostedAgentConfigFromEnvironment(publicUrl, input.hostedAgents);

  const issuer = new URL(required("OIDC_ISSUER"));
  const accessMode = process.env.FLOCK_OIDC_ACCESS_MODE?.trim() || "groups";
  let access: HubConfig["oidc"]["access"];
  if (accessMode === "groups") {
    access = {
      mode: "groups",
      allowedGroup: required("FLOCK_OIDC_ALLOWED_GROUP"),
      adminGroup: required("FLOCK_OIDC_ADMIN_GROUP"),
      groupsClaim: process.env.FLOCK_OIDC_GROUPS_CLAIM?.trim() || "groups",
    };
  } else if (accessMode === "google-open") {
    if (issuer.href.replace(/\/$/, "") !== "https://accounts.google.com") {
      throw new FlockError(
        "invalid_configuration",
        "google-open access requires OIDC_ISSUER=https://accounts.google.com",
      );
    }
    const adminEmails = required("FLOCK_OIDC_ADMIN_EMAILS")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    if (adminEmails.length === 0) {
      throw new FlockError(
        "missing_configuration",
        "FLOCK_OIDC_ADMIN_EMAILS must contain at least one email address",
      );
    }
    access = { mode: "google-open", adminEmails: [...new Set(adminEmails)] };
  } else {
    throw new FlockError(
      "invalid_configuration",
      "FLOCK_OIDC_ACCESS_MODE must be groups or google-open",
    );
  }

  return {
    dataRoot: resolve(input.dataRoot),
    host,
    port,
    publicUrl,
    trustProxy: input.trustProxy ?? false,
    cookieSecret: required("FLOCK_COOKIE_SECRET"),
    oidc: {
      issuer,
      clientId: required("OIDC_CLIENT_ID"),
      clientSecret: required("OIDC_CLIENT_SECRET"),
      access,
    },
    leaseMs,
    leaderLock: input.leaderLock ?? true,
    hostedAgents,
  };
}

export function hostedAgentConfigFromEnvironment(
  publicUrl: URL,
  enabledOverride?: boolean,
): HubConfig["hostedAgents"] {
  const enabled = enabledOverride ?? parseBoolean(process.env.FLOCK_HOSTED_AGENTS_ENABLED);
  const credentialKey = process.env.FLOCK_HOSTED_AGENT_CREDENTIAL_KEY?.trim();
  if (enabled && !credentialKey) {
    throw new FlockError(
      "missing_configuration",
      "FLOCK_HOSTED_AGENT_CREDENTIAL_KEY is required when hosted agents are enabled",
    );
  }
  return {
    enabled,
    image: process.env.FLOCK_HOSTED_AGENT_IMAGE?.trim() || "flock-agent:latest",
    internalHubUrl: new URL(
      process.env.FLOCK_HOSTED_AGENT_INTERNAL_HUB_URL?.trim() || publicUrl.href,
    ),
    credentialKey,
    cpuLimit: parseBoundedNumber("FLOCK_HOSTED_AGENT_CPUS", 1, 0.1, 64),
    memoryMb: parseBoundedNumber("FLOCK_HOSTED_AGENT_MEMORY_MB", 2048, 128, 262_144),
    pidsLimit: parseBoundedNumber("FLOCK_HOSTED_AGENT_PIDS", 256, 16, 65_536, true),
    retentionDays: parseBoundedNumber("FLOCK_HOSTED_AGENT_RETENTION_DAYS", 7, 0, 3650, true),
  };
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function parseBoundedNumber(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new FlockError(
      "invalid_configuration",
      `${name} must be ${integer ? "an integer " : ""}between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
