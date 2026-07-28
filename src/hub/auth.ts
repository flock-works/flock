import type { IncomingMessage, ServerResponse } from "node:http";
import * as oidc from "openid-client";
import type { ControlDatabase, Role } from "./control-db.ts";
import type { HubConfig } from "./config.ts";
import { FlockError } from "../shared/errors.ts";
import { createSecret } from "../shared/ids.ts";

export type HumanIdentity = {
  sub: string;
  email: string;
  displayName: string;
  role: Role;
};

export interface HumanAuthenticator {
  authenticate(request: IncomingMessage): Promise<HumanIdentity | undefined>;
  beginLogin(returnTo: string): Promise<URL>;
  finishLogin(currentUrl: URL): Promise<{ identity: HumanIdentity; returnTo: string; sessionSecret: string }>;
  logout(request: IncomingMessage): void;
  sessionCookie(secret: string, expiresAt: string): string;
  expiredSessionCookie(): string;
}

export class OidcAuthenticator implements HumanAuthenticator {
  private readonly database: ControlDatabase;
  private readonly config: HubConfig;
  private discovery: Promise<oidc.Configuration> | undefined;

  constructor(database: ControlDatabase, config: HubConfig) {
    this.database = database;
    this.config = config;
  }

  async authenticate(request: IncomingMessage): Promise<HumanIdentity | undefined> {
    const cookie = parseCookies(request.headers.cookie).flock_session;
    if (!cookie) return undefined;
    const session = this.database.getWebSession(cookie);
    if (!session) return undefined;
    return this.database.getUser(session.userSub);
  }

  async beginLogin(returnTo: string): Promise<URL> {
    const configuration = await this.getConfiguration();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    this.database.createOidcState({
      state,
      verifier,
      nonce,
      returnTo: safeReturnTo(returnTo),
    });
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: new URL("/api/v1/auth/callback", this.config.publicUrl).href,
      scope: "openid email profile",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
  }

  async finishLogin(currentUrl: URL): Promise<{ identity: HumanIdentity; returnTo: string; sessionSecret: string }> {
    const state = currentUrl.searchParams.get("state");
    if (!state) throw new FlockError("invalid_oidc_callback", "OIDC callback is missing state", 400);
    const pending = this.database.consumeOidcState(state);
    if (!pending) throw new FlockError("invalid_oidc_state", "OIDC state is invalid or expired", 400);
    const configuration = await this.getConfiguration();
    const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: pending.verifier,
      expectedState: state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims() as Record<string, unknown> | undefined;
    const identity = identityFromOidcClaims(claims, this.config.oidc.access);
    this.database.upsertUser(identity);
    const session = this.database.createWebSession(identity.sub);
    return { identity, returnTo: pending.returnTo, sessionSecret: session.secret };
  }

  logout(request: IncomingMessage): void {
    const secret = parseCookies(request.headers.cookie).flock_session;
    if (secret) this.database.deleteWebSession(secret);
  }

  sessionCookie(secret: string, expiresAt: string): string {
    return serializeCookie("flock_session", secret, {
      expires: expiresAt,
      secure: this.config.publicUrl.protocol === "https:",
      sameSite: "Lax",
      httpOnly: true,
      path: "/",
    });
  }

  expiredSessionCookie(): string {
    return serializeCookie("flock_session", "", {
      expires: new Date(0).toISOString(),
      secure: this.config.publicUrl.protocol === "https:",
      sameSite: "Lax",
      httpOnly: true,
      path: "/",
    });
  }

  private getConfiguration(): Promise<oidc.Configuration> {
    this.discovery ??= oidc.discovery(
      this.config.oidc.issuer,
      this.config.oidc.clientId,
      this.config.oidc.clientSecret,
    );
    return this.discovery;
  }
}

export class TestAuthenticator implements HumanAuthenticator {
  readonly identity: HumanIdentity;

  constructor(identity: HumanIdentity = { sub: "test-user", email: "test@example.com", displayName: "Test User", role: "admin" }) {
    this.identity = identity;
  }

  async authenticate(): Promise<HumanIdentity> {
    return this.identity;
  }

  async beginLogin(): Promise<URL> {
    return new URL("http://localhost/");
  }

  async finishLogin(): Promise<{ identity: HumanIdentity; returnTo: string; sessionSecret: string }> {
    return { identity: this.identity, returnTo: "/", sessionSecret: createSecret() };
  }

  logout(): void {}

  sessionCookie(): string {
    return "flock_session=test; Path=/; HttpOnly; SameSite=Lax";
  }

  expiredSessionCookie(): string {
    return "flock_session=; Path=/; Max-Age=0";
  }
}

export function requireRole(identity: HumanIdentity, role: Role): void {
  if (role === "admin" && identity.role !== "admin") {
    throw new FlockError("forbidden", "Administrator access is required", 403);
  }
}

export function identityFromOidcClaims(
  claims: Record<string, unknown> | undefined,
  access: HubConfig["oidc"]["access"],
): HumanIdentity {
  if (!claims || typeof claims.sub !== "string" || !claims.sub) {
    throw new FlockError("invalid_oidc_identity", "OIDC provider did not return a subject", 403);
  }

  let email: string;
  let role: Role;
  if (access.mode === "google-open") {
    if (
      typeof claims.email !== "string" ||
      !claims.email.trim() ||
      claims.email_verified !== true
    ) {
      throw new FlockError(
        "invalid_oidc_identity",
        "Google did not return a verified email address",
        403,
      );
    }
    email = claims.email.trim();
    role = access.adminEmails.includes(email.toLowerCase()) ? "admin" : "member";
  } else {
    const groupsValue = claims[access.groupsClaim];
    const groups = Array.isArray(groupsValue)
      ? groupsValue.filter((value): value is string => typeof value === "string")
      : [];
    if (!groups.includes(access.allowedGroup) && !groups.includes(access.adminGroup)) {
      throw new FlockError(
        "oidc_group_denied",
        "Your identity is not allowed to access this hub",
        403,
      );
    }
    role = groups.includes(access.adminGroup) ? "admin" : "member";
    email =
      typeof claims.email === "string" && claims.email.trim()
        ? claims.email.trim()
        : `${claims.sub}@oidc.invalid`;
  }

  const displayName =
    typeof claims.name === "string" && claims.name.trim()
      ? claims.name.trim()
      : typeof claims.preferred_username === "string" &&
          claims.preferred_username.trim()
        ? claims.preferred_username.trim()
        : email;
  return { sub: claims.sub, email, displayName, role };
}

export function assertSameOrigin(request: IncomingMessage, publicUrl: URL): void {
  const method = request.method ?? "GET";
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
  const origin = request.headers.origin;
  if (!origin || origin !== publicUrl.origin) {
    throw new FlockError("invalid_origin", "Mutation rejected because the request origin did not match the hub", 403);
  }
}

export function sendRedirect(response: ServerResponse, location: string, cookie?: string): void {
  response.writeHead(302, { Location: location, ...(cookie ? { "Set-Cookie": cookie } : {}) });
  response.end();
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const segment of header?.split(";") ?? []) {
    const separator = segment.indexOf("=");
    if (separator < 1) continue;
    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      continue;
    }
  }
  return result;
}

function serializeCookie(
  name: string,
  value: string,
  options: { expires: string; secure: boolean; sameSite: "Lax"; httpOnly: boolean; path: string },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Expires=${new Date(options.expires).toUTCString()}`,
    `SameSite=${options.sameSite}`,
    options.httpOnly ? "HttpOnly" : "",
    options.secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function safeReturnTo(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
