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
    allowedGroup: string;
    adminGroup: string;
    groupsClaim: string;
  };
  leaseMs: number;
  leaderLock: boolean;
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

  return {
    dataRoot: resolve(input.dataRoot),
    host,
    port,
    publicUrl,
    trustProxy: input.trustProxy ?? false,
    cookieSecret: required("FLOCK_COOKIE_SECRET"),
    oidc: {
      issuer: new URL(required("OIDC_ISSUER")),
      clientId: required("OIDC_CLIENT_ID"),
      clientSecret: required("OIDC_CLIENT_SECRET"),
      allowedGroup: required("FLOCK_OIDC_ALLOWED_GROUP"),
      adminGroup: required("FLOCK_OIDC_ADMIN_GROUP"),
      groupsClaim: process.env.FLOCK_OIDC_GROUPS_CLAIM?.trim() || "groups",
    },
    leaseMs,
    leaderLock: input.leaderLock ?? true,
  };
}
