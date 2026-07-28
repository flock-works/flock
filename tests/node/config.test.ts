import assert from "node:assert/strict";
import test from "node:test";
import { hubConfigFromEnvironment } from "../../src/hub/config.ts";

const managedEnvironment = [
  "FLOCK_COOKIE_SECRET",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "FLOCK_OIDC_ACCESS_MODE",
  "FLOCK_OIDC_ALLOWED_GROUP",
  "FLOCK_OIDC_ADMIN_GROUP",
  "FLOCK_OIDC_GROUPS_CLAIM",
  "FLOCK_OIDC_ADMIN_EMAILS",
  "FLOCK_HOSTED_AGENTS_ENABLED",
  "FLOCK_HOSTED_AGENT_IMAGE",
  "FLOCK_HOSTED_AGENT_INTERNAL_HUB_URL",
  "FLOCK_HOSTED_AGENT_CREDENTIAL_KEY",
  "FLOCK_HOSTED_AGENT_CPUS",
  "FLOCK_HOSTED_AGENT_MEMORY_MB",
  "FLOCK_HOSTED_AGENT_PIDS",
  "FLOCK_HOSTED_AGENT_RETENTION_DAYS",
] as const;

function withEnvironment(
  values: Partial<Record<(typeof managedEnvironment)[number], string>>,
  work: () => void,
): void {
  const previous = Object.fromEntries(
    managedEnvironment.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of managedEnvironment) delete process.env[name];
    Object.assign(process.env, values);
    work();
  } finally {
    for (const name of managedEnvironment) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function parseConfig() {
  return hubConfigFromEnvironment({
    dataRoot: "/tmp/flock-config-test",
    listen: "127.0.0.1:4747",
    publicUrl: "http://127.0.0.1:4747",
  });
}

const baseEnvironment = {
  FLOCK_COOKIE_SECRET: "test-cookie-secret",
  OIDC_CLIENT_ID: "test-client",
  OIDC_CLIENT_SECRET: "test-client-secret",
};

test("keeps group-based OIDC access as the default", () => {
  withEnvironment(
    {
      ...baseEnvironment,
      OIDC_ISSUER: "https://identity.example.test",
      FLOCK_OIDC_ALLOWED_GROUP: "members",
      FLOCK_OIDC_ADMIN_GROUP: "admins",
    },
    () => {
      const config = parseConfig();
      assert.deepEqual(config.oidc.access, {
        mode: "groups",
        allowedGroup: "members",
        adminGroup: "admins",
        groupsClaim: "groups",
      });
    },
  );
});

test("parses Google-open access and normalizes administrator emails", () => {
  withEnvironment(
    {
      ...baseEnvironment,
      OIDC_ISSUER: "https://accounts.google.com",
      FLOCK_OIDC_ACCESS_MODE: "google-open",
      FLOCK_OIDC_ADMIN_EMAILS: " Owner@Example.com, admin@example.com, owner@example.com ",
    },
    () => {
      const config = parseConfig();
      assert.deepEqual(config.oidc.access, {
        mode: "google-open",
        adminEmails: ["owner@example.com", "admin@example.com"],
      });
    },
  );
});

test("rejects Google-open access with a non-Google issuer", () => {
  withEnvironment(
    {
      ...baseEnvironment,
      OIDC_ISSUER: "https://identity.example.test",
      FLOCK_OIDC_ACCESS_MODE: "google-open",
      FLOCK_OIDC_ADMIN_EMAILS: "owner@example.com",
    },
    () => {
      assert.throws(() => parseConfig(), /requires OIDC_ISSUER=https:\/\/accounts\.google\.com/);
    },
  );
});

test("requires at least one configured Google administrator", () => {
  withEnvironment(
    {
      ...baseEnvironment,
      OIDC_ISSUER: "https://accounts.google.com",
      FLOCK_OIDC_ACCESS_MODE: "google-open",
    },
    () => {
      assert.throws(() => parseConfig(), /FLOCK_OIDC_ADMIN_EMAILS is required/);
    },
  );
});

test("requires an encryption key when hosted agents are enabled", () => {
  withEnvironment(
    {
      ...baseEnvironment,
      OIDC_ISSUER: "https://identity.example.test",
      FLOCK_OIDC_ALLOWED_GROUP: "members",
      FLOCK_OIDC_ADMIN_GROUP: "admins",
      FLOCK_HOSTED_AGENTS_ENABLED: "true",
    },
    () => assert.throws(() => parseConfig(), /FLOCK_HOSTED_AGENT_CREDENTIAL_KEY is required/u),
  );
});

test("parses hosted-agent runtime limits and internal URL", () => {
  withEnvironment(
    {
      ...baseEnvironment,
      OIDC_ISSUER: "https://identity.example.test",
      FLOCK_OIDC_ALLOWED_GROUP: "members",
      FLOCK_OIDC_ADMIN_GROUP: "admins",
      FLOCK_HOSTED_AGENTS_ENABLED: "true",
      FLOCK_HOSTED_AGENT_CREDENTIAL_KEY: "22".repeat(32),
      FLOCK_HOSTED_AGENT_IMAGE: "flock-agent:test",
      FLOCK_HOSTED_AGENT_INTERNAL_HUB_URL: "http://host.docker.internal:4747",
      FLOCK_HOSTED_AGENT_CPUS: "2",
      FLOCK_HOSTED_AGENT_MEMORY_MB: "4096",
      FLOCK_HOSTED_AGENT_PIDS: "512",
      FLOCK_HOSTED_AGENT_RETENTION_DAYS: "14",
    },
    () => {
      const config = parseConfig();
      assert.equal(config.hostedAgents.enabled, true);
      assert.equal(config.hostedAgents.image, "flock-agent:test");
      assert.equal(config.hostedAgents.internalHubUrl.href, "http://host.docker.internal:4747/");
      assert.equal(config.hostedAgents.cpuLimit, 2);
      assert.equal(config.hostedAgents.memoryMb, 4096);
      assert.equal(config.hostedAgents.pidsLimit, 512);
      assert.equal(config.hostedAgents.retentionDays, 14);
    },
  );
});
