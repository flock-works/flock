import { mkdir, open, readFile, rename, stat, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import { FlockError, toError } from "./errors.ts";
import { createEntryId, payloadHash } from "./ids.ts";
import { Mutex } from "./mutex.ts";

export type PiSessionHeader = {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  metadata?: Record<string, unknown>;
};

export type SequencedEntry = {
  seq: number;
  entry: SessionTreeEntry;
  hash: string;
};

export type SessionAppendResult = SequencedEntry & { duplicate: boolean };

export type GeneratedSessionEntry = SessionTreeEntry extends infer Entry
  ? Entry extends SessionTreeEntry
    ? Omit<Entry, "id" | "parentId" | "timestamp">
    : never
  : never;

function assertHeader(value: unknown, path: string): asserts value is PiSessionHeader {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { type?: unknown }).type !== "session" ||
    (value as { version?: unknown }).version !== 3 ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { timestamp?: unknown }).timestamp !== "string" ||
    typeof (value as { cwd?: unknown }).cwd !== "string"
  ) {
    throw new FlockError("invalid_session", `Invalid Pi v3 session header in ${path}`, 500);
  }
}

function assertEntry(value: unknown, line: number, path: string): asserts value is SessionTreeEntry {
  if (typeof value !== "object" || value === null) {
    throw new FlockError("invalid_entry", `Invalid session entry at ${path}:${line}`, 500);
  }
  const entry = value as { type?: unknown; id?: unknown; parentId?: unknown; timestamp?: unknown };
  if (
    typeof entry.type !== "string" ||
    typeof entry.id !== "string" ||
    (entry.parentId !== null && typeof entry.parentId !== "string") ||
    typeof entry.timestamp !== "string"
  ) {
    throw new FlockError("invalid_entry", `Invalid session entry at ${path}:${line}`, 500);
  }
}

function leafAfter(entry: SessionTreeEntry): string | null {
  return entry.type === "leaf" ? entry.targetId : entry.id;
}

export class PiJsonlSession {
  readonly path: string;
  readonly header: PiSessionHeader;
  private readonly mutex = new Mutex();
  private readonly ordered: SequencedEntry[] = [];
  private readonly byId = new Map<string, SequencedEntry>();
  private selectedLeafId: string | null = null;

  private constructor(path: string, header: PiSessionHeader) {
    this.path = path;
    this.header = header;
  }

  static projectPath(dataRoot: string, projectId: string): string {
    return join(dataRoot, "projects", projectId, "session.jsonl");
  }

  static async create(
    path: string,
    options: {
      projectId: string;
      projectSlug: string;
      sessionId?: string;
      createdAt?: string;
    },
  ): Promise<PiJsonlSession> {
    await mkdir(dirname(path), { recursive: true });
    const header: PiSessionHeader = {
      type: "session",
      version: 3,
      id: options.sessionId ?? uuidv7(),
      timestamp: options.createdAt ?? new Date().toISOString(),
      cwd: `flock://project/${options.projectSlug}`,
      metadata: { flock: { schemaVersion: 1, projectId: options.projectId } },
    };
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
    return new PiJsonlSession(path, header);
  }

  static async open(path: string): Promise<PiJsonlSession> {
    await repairTornTail(path);
    const content = await readFile(path, "utf8");
    const lines = content.split("\n");
    const headerLine = lines.shift();
    if (!headerLine) throw new FlockError("invalid_session", `Missing session header in ${path}`, 500);
    let parsedHeader: unknown;
    try {
      parsedHeader = JSON.parse(headerLine);
    } catch (error) {
      throw new FlockError("invalid_session", `Invalid session header in ${path}`, 500, toError(error));
    }
    assertHeader(parsedHeader, path);
    const session = new PiJsonlSession(path, parsedHeader);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line?.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new FlockError("invalid_entry", `Invalid JSON at ${path}:${index + 2}`, 500, toError(error));
      }
      assertEntry(parsed, index + 2, path);
      session.indexEntry(parsed);
    }
    session.validateTree();
    return session;
  }

  get cursor(): number {
    return this.ordered.length;
  }

  get leafId(): string | null {
    return this.selectedLeafId;
  }

  get entries(): readonly SequencedEntry[] {
    return this.ordered;
  }

  getEntry(id: string): SequencedEntry | undefined {
    return this.byId.get(id);
  }

  entriesAfter(cursor: number, limit = 5_000): SequencedEntry[] {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.cursor) {
      throw new FlockError("invalid_cursor", `Cursor ${cursor} is outside this session`, 409);
    }
    return this.ordered.slice(cursor, cursor + Math.max(0, limit));
  }

  branch(leafId: string | null): SessionTreeEntry[] {
    if (leafId === null) return [];
    const result: SessionTreeEntry[] = [];
    const seen = new Set<string>();
    let current = this.byId.get(leafId)?.entry;
    if (!current) throw new FlockError("entry_not_found", `Entry ${leafId} not found`, 404);
    while (current) {
      if (seen.has(current.id)) throw new FlockError("invalid_session", `Cycle at entry ${current.id}`, 500);
      seen.add(current.id);
      result.unshift(current);
      if (current.parentId === null) break;
      const parent = this.byId.get(current.parentId);
      if (!parent) throw new FlockError("invalid_session", `Missing parent ${current.parentId}`, 500);
      current = parent.entry;
    }
    return result;
  }

  async append(entry: SessionTreeEntry): Promise<SessionAppendResult> {
    return this.mutex.run(async () => {
      const existing = this.byId.get(entry.id);
      const hash = payloadHash(entry);
      if (existing) {
        if (existing.hash !== hash) {
          throw new FlockError("entry_conflict", `Entry ${entry.id} already exists with different content`, 409);
        }
        return { ...existing, duplicate: true };
      }
      this.validateNewEntry(entry);
      const handle = await open(this.path, "a");
      try {
        await handle.write(`${JSON.stringify(entry)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const sequenced = this.indexEntry(entry);
      return { ...sequenced, duplicate: false };
    });
  }

  async appendGenerated(
    pending: GeneratedSessionEntry,
    parentId: string | null,
  ): Promise<SessionAppendResult> {
    const entry = {
      ...pending,
      id: createEntryId(new Set(this.byId.keys())),
      parentId,
      timestamp: new Date().toISOString(),
    } as SessionTreeEntry;
    return this.append(entry);
  }

  private validateNewEntry(entry: SessionTreeEntry): void {
    assertEntry(entry, this.cursor + 2, this.path);
    if (entry.parentId !== null && !this.byId.has(entry.parentId)) {
      throw new FlockError("invalid_parent", `Parent ${entry.parentId} does not exist`, 409);
    }
    if (entry.type === "leaf" && entry.targetId !== null && !this.byId.has(entry.targetId)) {
      throw new FlockError("invalid_leaf", `Leaf target ${entry.targetId} does not exist`, 409);
    }
  }

  private indexEntry(entry: SessionTreeEntry): SequencedEntry {
    const sequenced = { seq: this.ordered.length + 1, entry, hash: payloadHash(entry) };
    this.ordered.push(sequenced);
    this.byId.set(entry.id, sequenced);
    this.selectedLeafId = leafAfter(entry);
    return sequenced;
  }

  private validateTree(): void {
    for (const { entry } of this.ordered) {
      if (entry.parentId !== null && !this.byId.has(entry.parentId)) {
        throw new FlockError("invalid_session", `Entry ${entry.id} has missing parent ${entry.parentId}`, 500);
      }
      if (entry.type === "leaf" && entry.targetId !== null && !this.byId.has(entry.targetId)) {
        throw new FlockError("invalid_session", `Leaf ${entry.id} has missing target ${entry.targetId}`, 500);
      }
    }
    if (this.selectedLeafId !== null) this.branch(this.selectedLeafId);
  }
}

export async function repairTornTail(path: string): Promise<boolean> {
  const fileStat = await stat(path);
  if (fileStat.size === 0) return false;
  const content = await readFile(path);
  if (content.at(-1) === 0x0a) return false;
  const lastNewline = content.lastIndexOf(0x0a);
  const tail = content.subarray(lastNewline + 1).toString("utf8");
  try {
    JSON.parse(tail);
    const handle = await open(path, "a");
    try {
      await handle.write("\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return false;
  } catch {
    await truncate(path, lastNewline + 1);
    return true;
  }
}
