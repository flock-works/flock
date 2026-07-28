import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Credential } from "@earendil-works/pi-ai";
import type { AgentCapabilities } from "../shared/protocol.ts";
import { FlockError } from "../shared/errors.ts";
import { createId, createSecret, hashSecret, secretsEqual } from "../shared/ids.ts";
import { SecretBox } from "./secret-box.ts";

export type Role = "admin" | "member";
export type AgentStatus = "online" | "offline" | "busy" | "attention" | "revoked";
export type JobStatus = "queued" | "offered" | "running" | "completed" | "failed" | "aborted";

export type ProjectRecord = {
  id: string;
  name: string;
  slug: string;
  sessionId: string;
  logicalCwd: string;
  createdAt: string;
};

export type AgentRecord = {
  id: string;
  projectId: string;
  name: string;
  status: AgentStatus;
  lastSeenAt: string | null;
  model: string;
  thinkingLevel: string;
  platform: string;
  workspace: string;
  capabilities: AgentCapabilities;
  revokedAt: string | null;
  hosting: HostedAgentRecord | null;
};

export type ProviderConnectionRecord = {
  id: string;
  userSub: string;
  providerId: OAuthProviderId;
  label: string;
  status: "connected" | "attention" | "revoked";
  version: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
};

export type OAuthProviderId =
  | "anthropic"
  | "openai-codex"
  | "github-copilot"
  | "openrouter"
  | "nous";
export type HostedAgentDesiredState = "running" | "stopped";
export type HostedAgentRuntimeState = "pending" | "starting" | "running" | "stopped" | "attention" | "deleted";

export type HostedAgentRecord = {
  agentId: string;
  createdBy: string;
  connectionId: string;
  providerId: OAuthProviderId;
  connectionOwnerSub: string;
  connectionLabel: string;
  desiredState: HostedAgentDesiredState;
  runtimeState: HostedAgentRuntimeState;
  containerId: string | null;
  lastError: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DispatchRecord = {
  id: string;
  projectId: string;
  baseEntryId: string | null;
  customEntryId: string;
  text: string;
  userSub: string;
  status: string;
  selectedLeafId: string | null;
  createdAt: string;
};

export type JobRecord = {
  id: string;
  dispatchId: string;
  projectId: string;
  targetAgentId: string;
  assignedAgentId: string | null;
  status: JobStatus;
  leaseId: string | null;
  leaseEpoch: number;
  leaseExpiresAt: string | null;
  baseEntryId: string;
  branchLeafId: string | null;
  prompt: string;
  recoveryCount: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
};

type Row = Record<string, unknown>;

function string(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new FlockError("database_corrupt", `Expected ${key} to be text`, 500);
  return value;
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new FlockError("database_corrupt", `Expected ${key} to be text`, 500);
  return value;
}

function number(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new FlockError("database_corrupt", `Expected ${key} to be numeric`, 500);
  return value;
}

function toProject(row: Row): ProjectRecord {
  return {
    id: string(row, "id"),
    name: string(row, "name"),
    slug: string(row, "slug"),
    sessionId: string(row, "session_id"),
    logicalCwd: string(row, "logical_cwd"),
    createdAt: string(row, "created_at"),
  };
}

function toAgent(row: Row): AgentRecord {
  return {
    id: string(row, "id"),
    projectId: string(row, "project_id"),
    name: string(row, "name"),
    status: string(row, "status") as AgentStatus,
    lastSeenAt: nullableString(row, "last_seen_at"),
    model: string(row, "model"),
    thinkingLevel: string(row, "thinking_level"),
    platform: string(row, "platform"),
    workspace: string(row, "workspace"),
    capabilities: JSON.parse(string(row, "capabilities_json")) as AgentCapabilities,
    revokedAt: nullableString(row, "revoked_at"),
    hosting: null,
  };
}

function toProviderConnection(row: Row): ProviderConnectionRecord {
  return {
    id: string(row, "id"),
    userSub: string(row, "user_sub"),
    providerId: string(row, "provider_id") as OAuthProviderId,
    label: string(row, "label"),
    status: string(row, "status") as ProviderConnectionRecord["status"],
    version: number(row, "version"),
    createdAt: string(row, "created_at"),
    updatedAt: string(row, "updated_at"),
    lastError: nullableString(row, "last_error"),
  };
}

function toHostedAgent(row: Row): HostedAgentRecord {
  return {
    agentId: string(row, "agent_id"),
    createdBy: string(row, "created_by"),
    connectionId: string(row, "connection_id"),
    providerId: string(row, "provider_id") as OAuthProviderId,
    connectionOwnerSub: string(row, "connection_owner_sub"),
    connectionLabel: string(row, "connection_label"),
    desiredState: string(row, "desired_state") as HostedAgentDesiredState,
    runtimeState: string(row, "runtime_state") as HostedAgentRuntimeState,
    containerId: nullableString(row, "container_id"),
    lastError: nullableString(row, "last_error"),
    deletedAt: nullableString(row, "deleted_at"),
    purgeAfter: nullableString(row, "purge_after"),
    createdAt: string(row, "created_at"),
    updatedAt: string(row, "updated_at"),
  };
}

function toDispatch(row: Row): DispatchRecord {
  return {
    id: string(row, "id"),
    projectId: string(row, "project_id"),
    baseEntryId: nullableString(row, "base_entry_id"),
    customEntryId: string(row, "custom_entry_id"),
    text: string(row, "text"),
    userSub: string(row, "user_sub"),
    status: string(row, "status"),
    selectedLeafId: nullableString(row, "selected_leaf_id"),
    createdAt: string(row, "created_at"),
  };
}

function toJob(row: Row): JobRecord {
  return {
    id: string(row, "id"),
    dispatchId: string(row, "dispatch_id"),
    projectId: string(row, "project_id"),
    targetAgentId: string(row, "target_agent_id"),
    assignedAgentId: nullableString(row, "assigned_agent_id"),
    status: string(row, "status") as JobStatus,
    leaseId: nullableString(row, "lease_id"),
    leaseEpoch: number(row, "lease_epoch"),
    leaseExpiresAt: nullableString(row, "lease_expires_at"),
    baseEntryId: string(row, "base_entry_id"),
    branchLeafId: nullableString(row, "branch_leaf_id"),
    prompt: string(row, "prompt"),
    recoveryCount: number(row, "recovery_count"),
    createdAt: string(row, "created_at"),
    updatedAt: string(row, "updated_at"),
    error: nullableString(row, "error"),
  };
}

export class ControlDatabase {
  readonly path: string;
  private readonly database: DatabaseSync;
  private readonly secrets: SecretBox | undefined;

  constructor(path: string, credentialKey?: string) {
    this.path = path;
    this.secrets = credentialKey ? new SecretBox(credentialKey) : undefined;
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        sub TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL UNIQUE,
        logical_cwd TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        last_seen_at TEXT,
        model TEXT NOT NULL,
        thinking_level TEXT NOT NULL,
        platform TEXT NOT NULL,
        workspace TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(project_id, name)
      );

      CREATE TABLE IF NOT EXISTS enrollment_tokens (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name_hint TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dispatches (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        base_entry_id TEXT,
        custom_entry_id TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        user_sub TEXT NOT NULL,
        status TEXT NOT NULL,
        selected_leaf_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        target_agent_id TEXT NOT NULL REFERENCES agents(id),
        assigned_agent_id TEXT REFERENCES agents(id),
        status TEXT NOT NULL,
        lease_id TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_expires_at TEXT,
        base_entry_id TEXT NOT NULL,
        branch_leaf_id TEXT,
        prompt TEXT NOT NULL,
        recovery_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(project_id, status, created_at);
      CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(status, lease_expires_at);

      CREATE TABLE IF NOT EXISTS session_entries (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        entry_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, seq),
        UNIQUE(project_id, entry_id)
      );

      CREATE TABLE IF NOT EXISTS web_sessions (
        id_hash TEXT PRIMARY KEY,
        user_sub TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oidc_states (
        state_hash TEXT PRIMARY KEY,
        verifier TEXT NOT NULL,
        nonce TEXT NOT NULL,
        return_to TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_connections (
        id TEXT PRIMARY KEY,
        user_sub TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        label TEXT NOT NULL,
        credential_ciphertext TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('connected', 'attention', 'revoked')),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        UNIQUE(user_sub, provider_id)
      );
      CREATE INDEX IF NOT EXISTS provider_connections_owner_idx
        ON provider_connections(user_sub, status);

      CREATE TABLE IF NOT EXISTS hosted_agents (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        created_by TEXT NOT NULL,
        connection_id TEXT NOT NULL REFERENCES provider_connections(id),
        agent_token_ciphertext TEXT NOT NULL,
        desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped')),
        runtime_state TEXT NOT NULL CHECK (runtime_state IN ('pending', 'starting', 'running', 'stopped', 'attention', 'deleted')),
        container_id TEXT,
        last_error TEXT,
        deleted_at TEXT,
        purge_after TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hosted_agents_reconcile_idx
        ON hosted_agents(desired_state, runtime_state, deleted_at);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        details_json TEXT NOT NULL
      );
    `);
  }

  transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  upsertUser(input: { sub: string; email: string; displayName: string; role: Role }): void {
    this.database
      .prepare(`
        INSERT INTO users(sub, email, display_name, role, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(sub) DO UPDATE SET
          email = excluded.email,
          display_name = excluded.display_name,
          role = excluded.role,
          last_seen_at = excluded.last_seen_at
      `)
      .run(input.sub, input.email, input.displayName, input.role, new Date().toISOString());
  }

  getUser(sub: string): { sub: string; email: string; displayName: string; role: Role } | undefined {
    const row = this.database.prepare("SELECT * FROM users WHERE sub = ?").get(sub) as Row | undefined;
    if (!row) return undefined;
    return {
      sub: string(row, "sub"),
      email: string(row, "email"),
      displayName: string(row, "display_name"),
      role: string(row, "role") as Role,
    };
  }

  createProject(input: { id?: string; name: string; slug: string; sessionId: string }): ProjectRecord {
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: input.id ?? createId("prj"),
      name: input.name,
      slug: input.slug,
      sessionId: input.sessionId,
      logicalCwd: `flock://project/${input.slug}`,
      createdAt: now,
    };
    this.database
      .prepare("INSERT INTO projects(id, name, slug, session_id, logical_cwd, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(project.id, project.name, project.slug, project.sessionId, project.logicalCwd, project.createdAt);
    return project;
  }

  getProject(id: string): ProjectRecord | undefined {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? toProject(row) : undefined;
  }

  getProjectBySlug(slug: string): ProjectRecord | undefined {
    const row = this.database.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as Row | undefined;
    return row ? toProject(row) : undefined;
  }

  listProjects(): ProjectRecord[] {
    return (this.database.prepare("SELECT * FROM projects ORDER BY created_at").all() as Row[]).map(toProject);
  }

  upsertProviderConnection(input: {
    userSub: string;
    providerId: OAuthProviderId;
    label: string;
    credential: Credential;
  }): ProviderConnectionRecord {
    const secrets = this.requireSecrets();
    const existing = this.database
      .prepare("SELECT id FROM provider_connections WHERE user_sub = ? AND provider_id = ?")
      .get(input.userSub, input.providerId) as Row | undefined;
    const id = existing ? string(existing, "id") : createId("llm");
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO provider_connections(
          id, user_sub, provider_id, label, credential_ciphertext, status,
          version, created_at, updated_at, last_error
        ) VALUES (?, ?, ?, ?, ?, 'connected', 1, ?, ?, NULL)
        ON CONFLICT(user_sub, provider_id) DO UPDATE SET
          label = excluded.label,
          credential_ciphertext = excluded.credential_ciphertext,
          status = 'connected',
          version = provider_connections.version + 1,
          updated_at = excluded.updated_at,
          last_error = NULL
      `)
      .run(
        id,
        input.userSub,
        input.providerId,
        input.label,
        secrets.seal(input.credential),
        now,
        now,
      );
    this.audit(input.userSub, "provider.connection.upsert", id, { providerId: input.providerId });
    const connection = this.getProviderConnection(id);
    if (!connection) throw new FlockError("database_corrupt", "Provider connection was not persisted", 500);
    return connection;
  }

  listProviderConnections(userSub?: string): ProviderConnectionRecord[] {
    const rows = userSub
      ? (this.database
          .prepare("SELECT * FROM provider_connections WHERE user_sub = ? ORDER BY provider_id")
          .all(userSub) as Row[])
      : (this.database
          .prepare("SELECT * FROM provider_connections ORDER BY user_sub, provider_id")
          .all() as Row[]);
    return rows.map(toProviderConnection);
  }

  getProviderConnection(id: string): ProviderConnectionRecord | undefined {
    const row = this.database.prepare("SELECT * FROM provider_connections WHERE id = ?").get(id) as Row | undefined;
    return row ? toProviderConnection(row) : undefined;
  }

  readProviderCredential(id: string): { connection: ProviderConnectionRecord; credential: Credential } {
    const row = this.database.prepare("SELECT * FROM provider_connections WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new FlockError("connection_not_found", "Provider connection not found", 404);
    const connection = toProviderConnection(row);
    if (connection.status !== "connected") {
      throw new FlockError("connection_unavailable", "Provider connection requires attention", 409);
    }
    return {
      connection,
      credential: this.requireSecrets().open<Credential>(string(row, "credential_ciphertext")),
    };
  }

  updateProviderCredential(input: {
    id: string;
    expectedVersion: number;
    credential: Credential;
  }): ProviderConnectionRecord {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(`
        UPDATE provider_connections
        SET credential_ciphertext = ?, version = version + 1, status = 'connected',
          updated_at = ?, last_error = NULL
        WHERE id = ? AND version = ? AND status = 'connected'
      `)
      .run(
        this.requireSecrets().seal(input.credential),
        now,
        input.id,
        input.expectedVersion,
      );
    if (result.changes !== 1) {
      throw new FlockError("credential_version_conflict", "Provider credential changed; retry the refresh", 409);
    }
    const connection = this.getProviderConnection(input.id);
    if (!connection) throw new FlockError("connection_not_found", "Provider connection not found", 404);
    return connection;
  }

  disconnectProviderConnection(id: string, actor: string): ProviderConnectionRecord {
    const connection = this.getProviderConnection(id);
    if (!connection) throw new FlockError("connection_not_found", "Provider connection not found", 404);
    if (connection.userSub !== actor) {
      throw new FlockError("forbidden", "Only the connection owner may disconnect it", 403);
    }
    const now = new Date().toISOString();
    this.transaction(() => {
      this.database
        .prepare(`
          UPDATE provider_connections
          SET status = 'revoked', version = version + 1, updated_at = ?,
            last_error = 'Disconnected by owner'
          WHERE id = ?
        `)
        .run(now, id);
      this.database
        .prepare(`
          UPDATE hosted_agents
          SET runtime_state = 'attention', last_error = 'Provider connection was disconnected',
            updated_at = ?
          WHERE connection_id = ? AND deleted_at IS NULL
        `)
        .run(now, id);
      this.database
        .prepare(`
          UPDATE agents SET status = 'attention'
          WHERE id IN (SELECT agent_id FROM hosted_agents WHERE connection_id = ? AND deleted_at IS NULL)
        `)
        .run(id);
    });
    this.audit(actor, "provider.connection.disconnect", id, { providerId: connection.providerId });
    return this.getProviderConnection(id)!;
  }

  createEnrollment(input: {
    projectId: string;
    nameHint: string;
    createdBy: string;
    ttlMs?: number;
  }): { id: string; secret: string; expiresAt: string } {
    if (!this.getProject(input.projectId)) throw new FlockError("project_not_found", "Project not found", 404);
    const id = createId("enr");
    const secret = createSecret();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 15 * 60_000)).toISOString();
    this.database
      .prepare(`
        INSERT INTO enrollment_tokens(id, project_id, name_hint, token_hash, expires_at, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, input.projectId, input.nameHint, hashSecret(secret), expiresAt, input.createdBy, now.toISOString());
    this.audit(input.createdBy, "agent.enrollment.create", id, { projectId: input.projectId });
    return { id, secret: `${id}.${secret}`, expiresAt };
  }

  inspectEnrollment(enrollmentSecret: string): {
    id: string;
    projectId: string;
    nameHint: string;
    expiresAt: string;
  } {
    const row = this.requireEnrollment(enrollmentSecret);
    return {
      id: string(row, "id"),
      projectId: string(row, "project_id"),
      nameHint: string(row, "name_hint"),
      expiresAt: string(row, "expires_at"),
    };
  }

  enrollAgent(input: {
    enrollmentSecret: string;
    name?: string;
    capabilities: AgentCapabilities;
  }): { agent: AgentRecord; token: string } {
    return this.transaction(() => {
      const row = this.requireEnrollment(input.enrollmentSecret);
      const id = string(row, "id");
      const token = createSecret();
      const now = new Date().toISOString();
      const agentId = createId("agt");
      const projectId = string(row, "project_id");
      const name = input.name?.trim() || string(row, "name_hint");
      this.database
        .prepare(`
          INSERT INTO agents(
            id, project_id, name, token_hash, status, last_seen_at, model, thinking_level,
            platform, workspace, capabilities_json, created_at
          ) VALUES (?, ?, ?, ?, 'offline', NULL, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          agentId,
          projectId,
          name,
          hashSecret(token),
          input.capabilities.model,
          input.capabilities.thinkingLevel,
          input.capabilities.platform,
          input.capabilities.workspace,
          JSON.stringify(input.capabilities),
          now,
        );
      this.database.prepare("UPDATE enrollment_tokens SET used_at = ? WHERE id = ?").run(now, id);
      this.audit(agentId, "agent.enroll", agentId, { projectId });
      const agent = this.getAgent(agentId);
      if (!agent) throw new FlockError("database_corrupt", "Enrolled agent was not persisted", 500);
      return { agent, token: `${agentId}.${token}` };
    });
  }

  private requireEnrollment(enrollmentSecret: string): Row {
    const [id, secret] = enrollmentSecret.split(".", 2);
    if (!id || !secret) throw new FlockError("invalid_enrollment", "Invalid enrollment token", 401);
    const row = this.database.prepare("SELECT * FROM enrollment_tokens WHERE id = ?").get(id) as Row | undefined;
    if (!row || !secretsEqual(secret, string(row, "token_hash"))) {
      throw new FlockError("invalid_enrollment", "Invalid enrollment token", 401);
    }
    if (nullableString(row, "used_at")) {
      throw new FlockError("enrollment_used", "Enrollment token has already been used", 409);
    }
    if (Date.parse(string(row, "expires_at")) <= Date.now()) {
      throw new FlockError("enrollment_expired", "Enrollment token has expired", 401);
    }
    return row;
  }

  createHostedAgent(input: {
    projectId: string;
    name: string;
    createdBy: string;
    connectionId: string;
    model: string;
    thinkingLevel: AgentCapabilities["thinkingLevel"];
    workspace: string;
  }): { agent: AgentRecord; token: string } {
    if (!this.getProject(input.projectId)) throw new FlockError("project_not_found", "Project not found", 404);
    const connection = this.getProviderConnection(input.connectionId);
    if (!connection || connection.status !== "connected") {
      throw new FlockError("connection_unavailable", "Choose a connected provider account", 409);
    }
    if (connection.userSub !== input.createdBy) {
      throw new FlockError("forbidden", "A hosted agent may only be bound to your own provider connection", 403);
    }
    if (!input.model.startsWith(`${connection.providerId}/`)) {
      throw new FlockError("provider_mismatch", "The model must belong to the selected provider connection", 400);
    }
    const token = createSecret();
    const agentId = createId("agt");
    const now = new Date().toISOString();
    const capabilities: AgentCapabilities = {
      tools: ["read", "write", "edit", "bash"],
      platform: "docker",
      workspace: input.workspace,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
    };
    this.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO agents(
            id, project_id, name, token_hash, status, last_seen_at, model, thinking_level,
            platform, workspace, capabilities_json, created_at
          ) VALUES (?, ?, ?, ?, 'offline', NULL, ?, ?, 'docker', ?, ?, ?)
        `)
        .run(
          agentId,
          input.projectId,
          input.name.trim(),
          hashSecret(token),
          input.model,
          input.thinkingLevel,
          input.workspace,
          JSON.stringify(capabilities),
          now,
        );
      this.database
        .prepare(`
          INSERT INTO hosted_agents(
            agent_id, created_by, connection_id, agent_token_ciphertext, desired_state,
            runtime_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'running', 'pending', ?, ?)
        `)
        .run(
          agentId,
          input.createdBy,
          input.connectionId,
          this.requireSecrets().seal(`${agentId}.${token}`),
          now,
          now,
        );
    });
    this.audit(input.createdBy, "hosted_agent.create", agentId, {
      projectId: input.projectId,
      providerId: connection.providerId,
    });
    const agent = this.getAgent(agentId);
    if (!agent) throw new FlockError("database_corrupt", "Hosted agent was not persisted", 500);
    return { agent, token: `${agentId}.${token}` };
  }

  authenticateAgent(bearer: string): AgentRecord | undefined {
    const [id, secret] = bearer.split(".", 2);
    if (!id || !secret) return undefined;
    const row = this.database.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    if (!row || nullableString(row, "revoked_at") || !secretsEqual(secret, string(row, "token_hash"))) return undefined;
    return this.attachHosting(toAgent(row));
  }

  getAgent(id: string): AgentRecord | undefined {
    const row = this.database.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? this.attachHosting(toAgent(row)) : undefined;
  }

  listAgents(projectId: string): AgentRecord[] {
    return (
      this.database.prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY name").all(projectId) as Row[]
    ).map(toAgent).map((agent) => this.attachHosting(agent));
  }

  getHostedAgent(agentId: string): HostedAgentRecord | undefined {
    const row = this.database
      .prepare(`
        SELECT h.*, c.provider_id, c.user_sub AS connection_owner_sub, c.label AS connection_label
        FROM hosted_agents h
        JOIN provider_connections c ON c.id = h.connection_id
        WHERE h.agent_id = ?
      `)
      .get(agentId) as Row | undefined;
    return row ? toHostedAgent(row) : undefined;
  }

  listHostedAgents(includeDeleted = false): HostedAgentRecord[] {
    return (
      this.database
        .prepare(`
          SELECT h.*, c.provider_id, c.user_sub AS connection_owner_sub, c.label AS connection_label
          FROM hosted_agents h
          JOIN provider_connections c ON c.id = h.connection_id
          ${includeDeleted ? "" : "WHERE h.deleted_at IS NULL"}
          ORDER BY h.created_at
        `)
        .all() as Row[]
    ).map(toHostedAgent);
  }

  hostedAgentToken(agentId: string): string {
    const row = this.database
      .prepare("SELECT agent_token_ciphertext FROM hosted_agents WHERE agent_id = ? AND deleted_at IS NULL")
      .get(agentId) as Row | undefined;
    if (!row) throw new FlockError("hosted_agent_not_found", "Hosted agent not found", 404);
    return this.requireSecrets().open<string>(string(row, "agent_token_ciphertext"));
  }

  updateHostedAgent(input: {
    agentId: string;
    actor: string;
    connectionId?: string;
    model?: string;
    thinkingLevel?: string;
    desiredState?: HostedAgentDesiredState;
  }): AgentRecord {
    const hosted = this.getHostedAgent(input.agentId);
    const agent = this.getAgent(input.agentId);
    if (!hosted || !agent || hosted.deletedAt) {
      throw new FlockError("hosted_agent_not_found", "Hosted agent not found", 404);
    }
    const connection = input.connectionId
      ? this.getProviderConnection(input.connectionId)
      : this.getProviderConnection(hosted.connectionId);
    if (!connection || connection.status !== "connected") {
      throw new FlockError("connection_unavailable", "Choose a connected provider account", 409);
    }
    if (input.connectionId && connection.userSub !== input.actor) {
      throw new FlockError("forbidden", "You may only assign one of your own provider connections", 403);
    }
    const model = input.model ?? agent.model;
    if (!model.startsWith(`${connection.providerId}/`)) {
      throw new FlockError("provider_mismatch", "The model must belong to the selected provider connection", 400);
    }
    const thinkingLevel = input.thinkingLevel ?? agent.thinkingLevel;
    const now = new Date().toISOString();
    const capabilities = { ...agent.capabilities, model, thinkingLevel };
    this.transaction(() => {
      this.database
        .prepare(`
          UPDATE hosted_agents
          SET connection_id = ?, desired_state = COALESCE(?, desired_state),
            runtime_state = 'pending', last_error = NULL, updated_at = ?
          WHERE agent_id = ?
        `)
        .run(connection.id, input.desiredState ?? null, now, input.agentId);
      this.database
        .prepare(`
          UPDATE agents SET model = ?, thinking_level = ?, capabilities_json = ?,
            status = CASE WHEN ? = 'stopped' THEN 'offline' ELSE status END
          WHERE id = ?
        `)
        .run(model, thinkingLevel, JSON.stringify(capabilities), input.desiredState ?? null, input.agentId);
    });
    this.audit(input.actor, "hosted_agent.update", input.agentId, {
      providerId: connection.providerId,
      desiredState: input.desiredState,
    });
    return this.getAgent(input.agentId)!;
  }

  setHostedAgentRuntime(
    agentId: string,
    runtimeState: HostedAgentRuntimeState,
    input: { containerId?: string | null; error?: string | null } = {},
  ): HostedAgentRecord {
    this.database
      .prepare(`
        UPDATE hosted_agents SET runtime_state = ?, container_id = ?,
          last_error = ?, updated_at = ? WHERE agent_id = ? AND deleted_at IS NULL
      `)
      .run(runtimeState, input.containerId ?? null, input.error ?? null, new Date().toISOString(), agentId);
    const hosted = this.getHostedAgent(agentId);
    if (!hosted) throw new FlockError("hosted_agent_not_found", "Hosted agent not found", 404);
    return hosted;
  }

  deleteHostedAgent(input: {
    agentId: string;
    actor: string;
    actorRole: Role;
    retentionDays: number;
  }): HostedAgentRecord {
    const hosted = this.getHostedAgent(input.agentId);
    if (!hosted || hosted.deletedAt) throw new FlockError("hosted_agent_not_found", "Hosted agent not found", 404);
    if (hosted.createdBy !== input.actor && input.actorRole !== "admin") {
      throw new FlockError("forbidden", "Only the creator or an administrator may delete this agent", 403);
    }
    const now = new Date();
    const purgeAfter = new Date(now.getTime() + input.retentionDays * 86_400_000).toISOString();
    this.transaction(() => {
      this.database
        .prepare(`
          UPDATE hosted_agents SET desired_state = 'stopped', runtime_state = 'deleted',
            deleted_at = ?, purge_after = ?, updated_at = ? WHERE agent_id = ?
        `)
        .run(now.toISOString(), purgeAfter, now.toISOString(), input.agentId);
      this.database
        .prepare("UPDATE agents SET status = 'revoked', revoked_at = ? WHERE id = ?")
        .run(now.toISOString(), input.agentId);
    });
    this.audit(input.actor, "hosted_agent.delete", input.agentId, { purgeAfter });
    return this.getHostedAgent(input.agentId)!;
  }

  listHostedAgentsDueForPurge(now = new Date()): HostedAgentRecord[] {
    return (
      this.database
        .prepare(`
          SELECT h.*, c.provider_id, c.user_sub AS connection_owner_sub, c.label AS connection_label
          FROM hosted_agents h JOIN provider_connections c ON c.id = h.connection_id
          WHERE h.deleted_at IS NOT NULL AND h.purge_after <= ?
        `)
        .all(now.toISOString()) as Row[]
    ).map(toHostedAgent);
  }

  purgeHostedAgent(agentId: string): void {
    this.database
      .prepare(`
        UPDATE hosted_agents SET purge_after = NULL, container_id = NULL,
          last_error = 'Workspace retention period ended; workspace was purged', updated_at = ?
        WHERE agent_id = ? AND deleted_at IS NOT NULL
      `)
      .run(new Date().toISOString(), agentId);
  }

  readHostedAgentCredential(agentId: string): {
    connection: ProviderConnectionRecord;
    credential: Credential;
  } {
    const hosted = this.getHostedAgent(agentId);
    if (!hosted || hosted.deletedAt) throw new FlockError("hosted_agent_not_found", "Hosted agent not found", 404);
    return this.readProviderCredential(hosted.connectionId);
  }

  updateAgentPresence(id: string, status: AgentStatus, capabilities?: AgentCapabilities): AgentRecord {
    const now = new Date().toISOString();
    if (capabilities) {
      this.database
        .prepare(`
          UPDATE agents SET status = ?, last_seen_at = ?, model = ?, thinking_level = ?,
            platform = ?, workspace = ?, capabilities_json = ? WHERE id = ? AND revoked_at IS NULL
        `)
        .run(
          status,
          now,
          capabilities.model,
          capabilities.thinkingLevel,
          capabilities.platform,
          capabilities.workspace,
          JSON.stringify(capabilities),
          id,
        );
    } else {
      this.database
        .prepare("UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(status, now, id);
    }
    const agent = this.getAgent(id);
    if (!agent) throw new FlockError("agent_not_found", "Agent not found", 404);
    return agent;
  }

  revokeAgent(id: string, actor: string): void {
    const now = new Date().toISOString();
    this.database.prepare("UPDATE agents SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, id);
    this.audit(actor, "agent.revoke", id, {});
  }

  createDispatch(input: {
    dispatchId?: string;
    projectId: string;
    baseEntryId: string | null;
    customEntryId: string;
    text: string;
    userSub: string;
    targetAgentIds: string[];
  }): { dispatch: DispatchRecord; jobs: JobRecord[] } {
    if (input.targetAgentIds.length === 0) throw new FlockError("no_targets", "Choose at least one agent", 400);
    return this.transaction(() => {
      const uniqueTargets = [...new Set(input.targetAgentIds)];
      for (const agentId of uniqueTargets) {
        const agent = this.getAgent(agentId);
        if (!agent || agent.projectId !== input.projectId || agent.revokedAt) {
          throw new FlockError("invalid_target", `Agent ${agentId} cannot receive this dispatch`, 409);
        }
        if (
          agent.hosting &&
          (agent.hosting.desiredState !== "running" ||
            agent.hosting.runtimeState === "attention" ||
            this.getProviderConnection(agent.hosting.connectionId)?.status !== "connected")
        ) {
          throw new FlockError("agent_unavailable", `Hosted agent ${agent.name} requires attention`, 409);
        }
      }
      const now = new Date().toISOString();
      const dispatchId = input.dispatchId ?? createId("dsp");
      this.database
        .prepare(`
          INSERT INTO dispatches(id, project_id, base_entry_id, custom_entry_id, text, user_sub, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
        `)
        .run(dispatchId, input.projectId, input.baseEntryId, input.customEntryId, input.text, input.userSub, now);
      const jobs: JobRecord[] = [];
      for (const targetAgentId of uniqueTargets) {
        const jobId = createId("job");
        this.database
          .prepare(`
            INSERT INTO jobs(
              id, dispatch_id, project_id, target_agent_id, status, lease_epoch, base_entry_id,
              prompt, recovery_count, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, 0, ?, ?)
          `)
          .run(jobId, dispatchId, input.projectId, targetAgentId, input.customEntryId, input.text, now, now);
        const job = this.getJob(jobId);
        if (!job) throw new FlockError("database_corrupt", "Dispatch job was not persisted", 500);
        jobs.push(job);
      }
      const dispatch = this.getDispatch(dispatchId);
      if (!dispatch) throw new FlockError("database_corrupt", "Dispatch was not persisted", 500);
      this.audit(input.userSub, "dispatch.create", dispatchId, { targetAgentIds: uniqueTargets });
      return { dispatch, jobs };
    });
  }

  getDispatch(id: string): DispatchRecord | undefined {
    const row = this.database.prepare("SELECT * FROM dispatches WHERE id = ?").get(id) as Row | undefined;
    return row ? toDispatch(row) : undefined;
  }

  listDispatches(projectId: string, limit = 100): DispatchRecord[] {
    return (
      this.database
        .prepare("SELECT * FROM dispatches WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(projectId, Math.max(1, Math.min(limit, 500))) as Row[]
    ).map(toDispatch);
  }

  hasUnresolvedDispatch(projectId: string): boolean {
    const row = this.database
      .prepare(
        "SELECT 1 AS found FROM dispatches WHERE project_id = ? AND status IN ('running', 'awaiting_selection') LIMIT 1",
      )
      .get(projectId) as Row | undefined;
    return Boolean(row);
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : undefined;
  }

  listJobsForDispatch(dispatchId: string): JobRecord[] {
    return (this.database.prepare("SELECT * FROM jobs WHERE dispatch_id = ? ORDER BY created_at").all(dispatchId) as Row[]).map(toJob);
  }

  nextJobForAgent(agentId: string, leaseMs: number): JobRecord | undefined {
    const agent = this.getAgent(agentId);
    if (!agent || agent.revokedAt) return undefined;
    return this.transaction(() => {
      const row = this.database
        .prepare(`
          SELECT * FROM jobs
          WHERE project_id = ?
            AND status = 'queued'
            AND (target_agent_id = ? OR recovery_count > 0)
          ORDER BY CASE WHEN target_agent_id = ? THEN 0 ELSE 1 END, created_at
          LIMIT 1
        `)
        .get(agent.projectId, agent.id, agent.id) as Row | undefined;
      if (!row) return undefined;
      const job = toJob(row);
      const leaseId = createId("lea");
      const epoch = job.leaseEpoch + 1;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
      this.database
        .prepare(`
          UPDATE jobs
          SET status = 'offered', assigned_agent_id = ?, lease_id = ?, lease_epoch = ?,
            lease_expires_at = ?, updated_at = ?, error = NULL
          WHERE id = ? AND status = 'queued'
        `)
        .run(agent.id, leaseId, epoch, expiresAt, now.toISOString(), job.id);
      return this.getJob(job.id);
    });
  }

  acceptJob(input: { jobId: string; agentId: string; leaseId: string; leaseEpoch: number }): JobRecord {
    const result = this.database
      .prepare(`
        UPDATE jobs SET status = 'running', updated_at = ?
        WHERE id = ? AND assigned_agent_id = ? AND lease_id = ? AND lease_epoch = ? AND status = 'offered'
      `)
      .run(new Date().toISOString(), input.jobId, input.agentId, input.leaseId, input.leaseEpoch);
    if (result.changes !== 1) throw new FlockError("stale_lease", "Job offer is no longer valid", 409);
    const job = this.getJob(input.jobId);
    if (!job) throw new FlockError("job_not_found", "Job not found", 404);
    return job;
  }

  assertLease(input: { jobId: string; agentId: string; leaseId: string; leaseEpoch: number }): JobRecord {
    const job = this.getJob(input.jobId);
    if (
      !job ||
      job.assignedAgentId !== input.agentId ||
      job.leaseId !== input.leaseId ||
      job.leaseEpoch !== input.leaseEpoch ||
      !["offered", "running"].includes(job.status) ||
      !job.leaseExpiresAt ||
      Date.parse(job.leaseExpiresAt) <= Date.now()
    ) {
      throw new FlockError("stale_lease", "Job lease is no longer valid", 409);
    }
    return job;
  }

  renewLease(input: { jobId: string; agentId: string; leaseId: string; leaseEpoch: number; leaseMs: number }): JobRecord {
    this.assertLease(input);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
    this.database
      .prepare("UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(expiresAt, now.toISOString(), input.jobId);
    const job = this.getJob(input.jobId);
    if (!job) throw new FlockError("job_not_found", "Job not found", 404);
    return job;
  }

  updateJobLeaf(jobId: string, leafId: string): JobRecord {
    this.database
      .prepare("UPDATE jobs SET branch_leaf_id = ?, updated_at = ? WHERE id = ?")
      .run(leafId, new Date().toISOString(), jobId);
    const job = this.getJob(jobId);
    if (!job) throw new FlockError("job_not_found", "Job not found", 404);
    return job;
  }

  finishJob(input: {
    jobId: string;
    agentId: string;
    leaseId: string;
    leaseEpoch: number;
    status: Exclude<JobStatus, "queued" | "offered" | "running">;
    leafId: string;
    error?: string;
  }): JobRecord {
    const active = this.assertLease(input);
    if (!active.branchLeafId || active.branchLeafId !== input.leafId) {
      throw new FlockError("branch_conflict", "Finished job leaf does not match the leased branch", 409);
    }
    const now = new Date().toISOString();
    this.database
      .prepare(`
        UPDATE jobs SET status = ?, branch_leaf_id = ?, lease_expires_at = NULL,
          updated_at = ?, error = ? WHERE id = ?
      `)
      .run(input.status, input.leafId, now, input.error ?? null, input.jobId);
    const job = this.getJob(input.jobId);
    if (!job) throw new FlockError("job_not_found", "Job not found", 404);
    this.refreshDispatchStatus(job.dispatchId);
    return job;
  }

  abortJob(jobId: string, actor: string): JobRecord {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(`
        UPDATE jobs SET status = 'aborted', lease_expires_at = NULL, updated_at = ?, error = 'Cancelled by user'
        WHERE id = ? AND status IN ('queued', 'offered', 'running')
      `)
      .run(now, jobId);
    if (result.changes !== 1) throw new FlockError("job_not_active", "Job is not active", 409);
    const job = this.getJob(jobId);
    if (!job) throw new FlockError("job_not_found", "Job not found", 404);
    this.refreshDispatchStatus(job.dispatchId);
    this.audit(actor, "job.abort", jobId, {});
    return job;
  }

  abortActiveJobsForAgent(agentId: string, actor: string): JobRecord[] {
    const rows = this.database
      .prepare(`
        SELECT * FROM jobs
        WHERE (target_agent_id = ? OR assigned_agent_id = ?)
          AND status IN ('queued', 'offered', 'running')
      `)
      .all(agentId, agentId) as Row[];
    const aborted: JobRecord[] = [];
    for (const row of rows) {
      try {
        aborted.push(this.abortJob(string(row, "id"), actor));
      } catch (error) {
        if (!(error instanceof FlockError) || error.code !== "job_not_active") throw error;
      }
    }
    return aborted;
  }

  expireLeases(now = new Date()): JobRecord[] {
    const expired = (
      this.database
        .prepare(`
          SELECT * FROM jobs
          WHERE status IN ('offered', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        `)
        .all(now.toISOString()) as Row[]
    ).map(toJob);
    this.transaction(() => {
      for (const job of expired) {
        this.database
          .prepare(`
            UPDATE jobs SET status = 'queued', assigned_agent_id = NULL, lease_id = NULL,
              lease_expires_at = NULL, recovery_count = recovery_count + 1, updated_at = ?,
              error = 'Agent lease expired; automatic recovery queued'
            WHERE id = ? AND lease_epoch = ?
          `)
          .run(now.toISOString(), job.id, job.leaseEpoch);
      }
    });
    return expired.map((job) => this.getJob(job.id)).filter((job): job is JobRecord => Boolean(job));
  }

  selectDispatchBranch(input: { dispatchId: string; leafId: string; actor: string }): DispatchRecord {
    const jobs = this.listJobsForDispatch(input.dispatchId);
    if (!jobs.some((job) => job.branchLeafId === input.leafId && job.status === "completed")) {
      throw new FlockError("invalid_branch", "Choose a completed response branch", 409);
    }
    this.database
      .prepare("UPDATE dispatches SET selected_leaf_id = ?, status = 'completed' WHERE id = ?")
      .run(input.leafId, input.dispatchId);
    this.audit(input.actor, "dispatch.select", input.dispatchId, { leafId: input.leafId });
    const dispatch = this.getDispatch(input.dispatchId);
    if (!dispatch) throw new FlockError("dispatch_not_found", "Dispatch not found", 404);
    return dispatch;
  }

  indexEntry(projectId: string, seq: number, entryId: string, hash: string, createdAt: string): void {
    this.database
      .prepare(`
        INSERT INTO session_entries(project_id, seq, entry_id, payload_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, entry_id) DO UPDATE SET payload_hash = excluded.payload_hash
      `)
      .run(projectId, seq, entryId, hash, createdAt);
  }

  clearEntryIndex(projectId: string): void {
    this.database.prepare("DELETE FROM session_entries WHERE project_id = ?").run(projectId);
  }

  entryIndexCount(projectId: string): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM session_entries WHERE project_id = ?")
      .get(projectId) as Row;
    return number(row, "count");
  }

  createWebSession(userSub: string, ttlMs = 12 * 60 * 60_000): { secret: string; expiresAt: string } {
    const secret = createSecret();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.database
      .prepare("INSERT INTO web_sessions(id_hash, user_sub, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hashSecret(secret), userSub, expiresAt, now.toISOString());
    return { secret, expiresAt };
  }

  getWebSession(secret: string): { userSub: string; expiresAt: string } | undefined {
    const row = this.database
      .prepare("SELECT * FROM web_sessions WHERE id_hash = ? AND expires_at > ?")
      .get(hashSecret(secret), new Date().toISOString()) as Row | undefined;
    return row ? { userSub: string(row, "user_sub"), expiresAt: string(row, "expires_at") } : undefined;
  }

  deleteWebSession(secret: string): void {
    this.database.prepare("DELETE FROM web_sessions WHERE id_hash = ?").run(hashSecret(secret));
  }

  createOidcState(input: { state: string; verifier: string; nonce: string; returnTo: string; ttlMs?: number }): void {
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? 10 * 60_000)).toISOString();
    this.database
      .prepare("INSERT INTO oidc_states(state_hash, verifier, nonce, return_to, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hashSecret(input.state), input.verifier, input.nonce, input.returnTo, expiresAt);
  }

  consumeOidcState(state: string): { verifier: string; nonce: string; returnTo: string } | undefined {
    return this.transaction(() => {
      const hash = hashSecret(state);
      const row = this.database
        .prepare("SELECT * FROM oidc_states WHERE state_hash = ? AND expires_at > ?")
        .get(hash, new Date().toISOString()) as Row | undefined;
      this.database.prepare("DELETE FROM oidc_states WHERE state_hash = ?").run(hash);
      return row
        ? { verifier: string(row, "verifier"), nonce: string(row, "nonce"), returnTo: string(row, "return_to") }
        : undefined;
    });
  }

  audit(actor: string, action: string, target: string | null, details: Record<string, unknown>): void {
    this.database
      .prepare("INSERT INTO audit_log(occurred_at, actor, action, target, details_json) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), actor, action, target, JSON.stringify(details));
  }

  private attachHosting(agent: AgentRecord): AgentRecord {
    agent.hosting = this.getHostedAgent(agent.id) ?? null;
    return agent;
  }

  private requireSecrets(): SecretBox {
    if (!this.secrets) {
      throw new FlockError(
        "hosted_agents_disabled",
        "Hosted-agent credential protection is not configured",
        503,
      );
    }
    return this.secrets;
  }

  private refreshDispatchStatus(dispatchId: string): void {
    const jobs = this.listJobsForDispatch(dispatchId);
    if (jobs.length === 0) return;
    const terminal = jobs.every((job) => ["completed", "failed", "aborted"].includes(job.status));
    if (!terminal) return;
    const completed = jobs.filter((job) => job.status === "completed");
    const status = completed.length > 0 ? (completed.length === 1 ? "completed" : "awaiting_selection") : "failed";
    this.database.prepare("UPDATE dispatches SET status = ? WHERE id = ?").run(status, dispatchId);
  }
}
