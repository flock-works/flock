import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  identityFromOidcClaims,
  OidcAuthenticator,
  requestUrl,
  safeReturnTo,
  TestAuthenticator,
} from "../../src/hub/auth.ts";
import type { HubConfig } from "../../src/hub/config.ts";
import { ControlDatabase } from "../../src/hub/control-db.ts";

const googleAccess = {
  mode: "google-open" as const,
  adminEmails: ["owner@example.com"],
};

test("creates Google members from verified identities using the stable subject", () => {
  const identity = identityFromOidcClaims(
    {
      sub: "google-stable-subject",
      email: "member@example.com",
      email_verified: true,
      name: "Flock Member",
    },
    googleAccess,
  );

  assert.deepEqual(identity, {
    sub: "google-stable-subject",
    email: "member@example.com",
    displayName: "Flock Member",
    role: "member",
  });
});

test("matches configured Google administrators case-insensitively", () => {
  const identity = identityFromOidcClaims(
    {
      sub: "admin-subject",
      email: "OWNER@EXAMPLE.COM",
      email_verified: true,
    },
    googleAccess,
  );

  assert.equal(identity.role, "admin");
  assert.equal(identity.sub, "admin-subject");
});

test("rejects Google identities without a verified email", () => {
  assert.throws(
    () =>
      identityFromOidcClaims(
        { sub: "missing-email", email_verified: true },
        googleAccess,
      ),
    /verified email address/,
  );
  assert.throws(
    () =>
      identityFromOidcClaims(
        { sub: "unverified", email: "person@example.com", email_verified: false },
        googleAccess,
      ),
    /verified email address/,
  );
});

test("preserves group-based member and administrator assignment", () => {
  const access = {
    mode: "groups" as const,
    allowedGroup: "members",
    adminGroup: "admins",
    groupsClaim: "groups",
  };
  assert.equal(
    identityFromOidcClaims(
      { sub: "member", email: "member@example.com", groups: ["members"] },
      access,
    ).role,
    "member",
  );
  assert.equal(
    identityFromOidcClaims(
      { sub: "admin", email: "admin@example.com", groups: ["admins"] },
      access,
    ).role,
    "admin",
  );
  assert.throws(
    () =>
      identityFromOidcClaims(
        { sub: "outsider", email: "outside@example.com", groups: [] },
        access,
      ),
    /not allowed/,
  );
});

test("keeps login return paths on the current origin", () => {
  assert.equal(safeReturnTo("/app?project=one"), "/app?project=one");
  assert.equal(safeReturnTo("https://evil.example/app"), "/");
  assert.equal(safeReturnTo("//evil.example/app"), "/");
});

test("development authentication preserves the request origin and safe return path", async () => {
  const authenticator = new TestAuthenticator();
  assert.equal(
    (
      await authenticator.beginLogin(
        "/test-user/chat?project=one",
        new URL("http://localhost:4747/api/v1/auth/login"),
      )
    ).href,
    "http://localhost:4747/test-user/chat?project=one",
  );
  assert.equal(
    (
      await authenticator.beginLogin(
        "https://evil.example/app",
        new URL("http://127.0.0.1:4747/api/v1/auth/login"),
      )
    ).href,
    "http://127.0.0.1:4747/",
  );
});

test("uses a direct loopback origin for local development requests", () => {
  const localRequest = {
    url: "/api/v1/auth/login?returnTo=%2Fapp",
    headers: { host: "localhost:4747" },
  } as IncomingMessage;
  const publicUrl = new URL("https://flock.example.com");

  assert.equal(
    requestUrl(localRequest, publicUrl).href,
    "http://localhost:4747/api/v1/auth/login?returnTo=%2Fapp",
  );

  const publicRequest = {
    url: "/api/v1/auth/login",
    headers: { host: "flock.example.com" },
  } as IncomingMessage;
  assert.equal(
    requestUrl(publicRequest, publicUrl).href,
    "https://flock.example.com/api/v1/auth/login",
  );
});

test("does not trust non-loopback host headers as alternate public origins", () => {
  const request = {
    url: "/api/v1/auth/login",
    headers: { host: "attacker.example" },
  } as IncomingMessage;

  assert.equal(
    requestUrl(request, new URL("https://flock.example.com")).origin,
    "https://flock.example.com",
  );
});

test("removes the persisted web session on logout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flock-auth-test-"));
  const database = new ControlDatabase(join(directory, "control.sqlite"));
  database.upsertUser({
    sub: "session-user",
    email: "member@example.com",
    displayName: "Session User",
    role: "member",
  });
  const session = database.createWebSession("session-user");
  const config: HubConfig = {
    dataRoot: directory,
    host: "127.0.0.1",
    port: 4747,
    publicUrl: new URL("https://flock.example.com"),
    trustProxy: false,
    cookieSecret: "test-secret",
    oidc: {
      issuer: new URL("https://accounts.google.com"),
      clientId: "test-client",
      clientSecret: "test-secret",
      access: googleAccess,
    },
    leaseMs: 30_000,
    leaderLock: false,
    nous: {
      portalUrl: new URL("https://portal.nousresearch.com"),
      inferenceUrl: new URL("https://inference-api.nousresearch.com/v1"),
    },
    hostedAgents: {
      enabled: false,
      image: "flock-agent:test",
      internalHubUrl: new URL("http://127.0.0.1"),
      cpuLimit: 1,
      memoryMb: 512,
      pidsLimit: 128,
      retentionDays: 7,
    },
  };
  const authenticator = new OidcAuthenticator(database, config);
  const request = {
    headers: { cookie: `flock_session=${session.secret}` },
  } as IncomingMessage;

  assert.equal((await authenticator.authenticate(request))?.sub, "session-user");
  authenticator.logout(request);
  assert.equal(await authenticator.authenticate(request), undefined);
  database.close();
});
