import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  identityFromOidcClaims,
  OidcAuthenticator,
  safeReturnTo,
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
