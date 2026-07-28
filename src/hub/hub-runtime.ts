import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import { FlockError } from "../shared/errors.ts";
import { createId, payloadHash } from "../shared/ids.ts";
import { PiJsonlSession, type SessionAppendResult } from "../shared/pi-session.ts";
import { ControlDatabase, type DispatchRecord, type JobRecord, type ProjectRecord } from "./control-db.ts";

export class HubRuntime {
  readonly dataRoot: string;
  readonly database: ControlDatabase;
  private readonly sessions = new Map<string, PiJsonlSession>();

  private constructor(dataRoot: string, database: ControlDatabase) {
    this.dataRoot = dataRoot;
    this.database = database;
  }

  static async open(dataRoot: string, credentialKey?: string): Promise<HubRuntime> {
    await mkdir(dataRoot, { recursive: true });
    const database = new ControlDatabase(join(dataRoot, "control.sqlite"), credentialKey);
    const runtime = new HubRuntime(dataRoot, database);
    for (const project of database.listProjects()) {
      const session = await PiJsonlSession.open(PiJsonlSession.projectPath(dataRoot, project.id));
      if (session.header.id !== project.sessionId) {
        throw new FlockError("session_mismatch", `Project ${project.id} references a different session`, 500);
      }
      runtime.sessions.set(project.id, session);
      runtime.reconcileEntryIndex(project.id, session);
    }
    return runtime;
  }

  close(): void {
    this.database.close();
    this.sessions.clear();
  }

  async createProject(input: { name: string; slug: string }): Promise<ProjectRecord> {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.slug)) {
      throw new FlockError("invalid_slug", "Project slug must use lowercase letters, numbers, and single hyphens");
    }
    if (this.database.getProjectBySlug(input.slug)) {
      throw new FlockError("slug_conflict", "A project with this slug already exists", 409);
    }
    const sessionId = uuidv7();
    const projectId = createId("prj");
    const createdAt = new Date().toISOString();
    const session = await PiJsonlSession.create(PiJsonlSession.projectPath(this.dataRoot, projectId), {
      projectId,
      projectSlug: input.slug,
      sessionId,
      createdAt,
    });
    const project = this.database.createProject({ id: projectId, name: input.name.trim(), slug: input.slug, sessionId });
    this.sessions.set(project.id, session);
    return project;
  }

  getSession(projectId: string): PiJsonlSession {
    const session = this.sessions.get(projectId);
    if (!session) throw new FlockError("project_not_found", "Project not found", 404);
    return session;
  }

  async createDispatch(input: {
    projectId: string;
    text: string;
    targetAgentIds: string[];
    userSub: string;
    baseEntryId?: string;
  }): Promise<{ dispatch: DispatchRecord; jobs: JobRecord[]; entry: SessionAppendResult }> {
    const text = input.text.trim();
    if (!text) throw new FlockError("empty_dispatch", "Message cannot be empty");
    if (text.length > 100_000) throw new FlockError("dispatch_too_large", "Message is too large", 413);
    if (this.database.hasUnresolvedDispatch(input.projectId)) {
      throw new FlockError(
        "dispatch_unresolved",
        "Wait for the active dispatch to finish and select a branch before sending another message",
        409,
      );
    }
    const targetAgentIds = [...new Set(input.targetAgentIds)];
    if (targetAgentIds.length === 0) throw new FlockError("no_targets", "Choose at least one agent");
    for (const agentId of targetAgentIds) {
      const agent = this.database.getAgent(agentId);
      if (!agent || agent.projectId !== input.projectId || agent.revokedAt) {
        throw new FlockError("invalid_target", `Agent ${agentId} cannot receive this dispatch`, 409);
      }
      if (
        agent.hosting &&
        (agent.hosting.desiredState !== "running" ||
          agent.hosting.runtimeState === "attention" ||
          this.database.getProviderConnection(agent.hosting.connectionId)?.status !== "connected")
      ) {
        throw new FlockError("agent_unavailable", `Hosted agent ${agent.name} requires attention`, 409);
      }
    }
    const session = this.getSession(input.projectId);
    const baseEntryId = input.baseEntryId ?? session.leafId;
    if (baseEntryId !== null && !session.getEntry(baseEntryId)) {
      throw new FlockError("invalid_branch", "Dispatch base entry does not exist", 409);
    }
    const dispatchId = `dsp_${uuidv7().replaceAll("-", "")}`;
    const entry = await session.appendGenerated(
      {
        type: "custom",
        customType: "flock.dispatch",
        data: {
          schemaVersion: 1,
          dispatchId,
          userSub: input.userSub,
          targetAgentIds,
          text,
          textHash: payloadHash(text),
        },
      },
      baseEntryId,
    );
    this.indexEntry(input.projectId, entry);
    const created = this.database.createDispatch({
      dispatchId,
      projectId: input.projectId,
      baseEntryId,
      customEntryId: entry.entry.id,
      text,
      userSub: input.userSub,
      targetAgentIds,
    });
    return { ...created, entry };
  }

  async appendJobEntry(input: {
    job: JobRecord;
    agentId: string;
    entry: SessionTreeEntry;
  }): Promise<SessionAppendResult> {
    const session = this.getSession(input.job.projectId);
    const expectedParent = input.job.branchLeafId ?? input.job.baseEntryId;
    if (input.entry.parentId !== expectedParent) {
      throw new FlockError(
        "branch_conflict",
        `Entry parent ${input.entry.parentId ?? "root"} does not match leased branch ${expectedParent}`,
        409,
      );
    }
    if (input.entry.type === "leaf") {
      throw new FlockError("entry_type_denied", "Agents cannot select the project leaf", 403);
    }
    const result = await session.append(input.entry);
    this.indexEntry(input.job.projectId, result);
    this.database.updateJobLeaf(input.job.id, input.entry.id);
    return result;
  }

  async selectDispatchBranch(input: {
    dispatchId: string;
    leafId: string;
    actor: string;
  }): Promise<{ dispatch: DispatchRecord; entry: SessionAppendResult }> {
    const dispatch = this.database.getDispatch(input.dispatchId);
    if (!dispatch) throw new FlockError("dispatch_not_found", "Dispatch not found", 404);
    const session = this.getSession(dispatch.projectId);
    if (!session.getEntry(input.leafId)) throw new FlockError("invalid_branch", "Branch leaf does not exist", 409);
    const selected = this.database.selectDispatchBranch(input);
    const entry = await session.appendGenerated(
      { type: "leaf", targetId: input.leafId },
      session.leafId,
    );
    this.indexEntry(dispatch.projectId, entry);
    return { dispatch: selected, entry };
  }

  async autoSelectSingleJob(job: JobRecord): Promise<SessionAppendResult | undefined> {
    if (job.status !== "completed" || !job.branchLeafId) return undefined;
    const jobs = this.database.listJobsForDispatch(job.dispatchId);
    if (jobs.length !== 1) return undefined;
    const selected = await this.selectDispatchBranch({
      dispatchId: job.dispatchId,
      leafId: job.branchLeafId,
      actor: "system",
    });
    return selected.entry;
  }

  reconcileEntryIndex(projectId: string, session = this.getSession(projectId)): void {
    this.database.clearEntryIndex(projectId);
    for (const item of session.entries) this.indexEntry(projectId, item);
  }

  private indexEntry(projectId: string, item: { seq: number; entry: SessionTreeEntry; hash: string }): void {
    this.database.indexEntry(projectId, item.seq, item.entry.id, item.hash, item.entry.timestamp);
  }
}
