import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { FlockError } from "../shared/errors.ts";
import { payloadHash } from "../shared/ids.ts";
import type { PiSessionHeader } from "../shared/pi-session.ts";

export type SessionEnvelope = { seq: number; entry: SessionTreeEntry };

export class SessionMirror {
  readonly path: string;
  private headerValue: PiSessionHeader | undefined;
  private readonly entriesValue: SessionTreeEntry[] = [];
  private readonly byId = new Map<string, SessionTreeEntry>();
  private selectedLeafValue: string | null = null;

  constructor(path: string) {
    this.path = path;
  }

  get header(): PiSessionHeader | undefined {
    return this.headerValue;
  }

  get entries(): readonly SessionTreeEntry[] {
    return this.entriesValue;
  }

  get cursor(): number {
    return this.entriesValue.length;
  }

  get selectedLeafId(): string | null {
    return this.selectedLeafValue;
  }

  static async open(path: string): Promise<SessionMirror> {
    const mirror = new SessionMirror(path);
    try {
      const content = await readFile(path, "utf8");
      const lines = content.split("\n").filter((line) => line.trim());
      if (lines.length === 0) throw new FlockError("mirror_invalid", "Local session mirror is empty");
      mirror.headerValue = parseHeader(JSON.parse(lines[0]!));
      for (const line of lines.slice(1)) mirror.index(parseEntry(JSON.parse(line)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return mirror;
  }

  async applySnapshot(
    header: unknown,
    envelopes: readonly SessionEnvelope[],
    selectedLeafId: string | null,
  ): Promise<void> {
    const parsedHeader = parseHeader(header);
    const entries = envelopes.map(({ entry }) => parseEntry(entry));
    assertContinuous(envelopes, 1);
    validateTree(entries);
    if (selectedLeafId !== null && !entries.some((entry) => entry.id === selectedLeafId)) {
      throw new FlockError("mirror_invalid", `Selected leaf ${selectedLeafId} is missing from the snapshot`);
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const content = `${[parsedHeader, ...entries].map((value) => JSON.stringify(value)).join("\n")}\n`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
    this.headerValue = parsedHeader;
    this.entriesValue.splice(0);
    this.byId.clear();
    this.selectedLeafValue = null;
    for (const entry of entries) this.index(entry);
    this.selectedLeafValue = selectedLeafId;
  }

  async applyEntries(envelopes: readonly SessionEnvelope[], selectedLeafId: string | null): Promise<void> {
    if (!this.headerValue) throw new FlockError("mirror_uninitialized", "A session snapshot is required before incremental sync");
    for (const envelope of envelopes) {
      const entry = parseEntry(envelope.entry);
      if (envelope.seq <= this.cursor) {
        const existing = this.entriesValue[envelope.seq - 1];
        if (!existing || payloadHash(existing) !== payloadHash(entry)) {
          throw new FlockError("mirror_conflict", `Session sequence ${envelope.seq} changed`, 409);
        }
        continue;
      }
      if (envelope.seq !== this.cursor + 1) {
        throw new FlockError("mirror_gap", `Expected session sequence ${this.cursor + 1}, received ${envelope.seq}`, 409);
      }
      validateEntryParent(entry, this.byId);
      const handle = await open(this.path, "a");
      try {
        await handle.write(`${JSON.stringify(entry)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.index(entry);
    }
    if (selectedLeafId !== null && !this.byId.has(selectedLeafId)) {
      throw new FlockError("mirror_invalid", `Selected leaf ${selectedLeafId} is missing after sync`, 409);
    }
    this.selectedLeafValue = selectedLeafId;
  }

  branch(leafId: string): SessionTreeEntry[] {
    const branch: SessionTreeEntry[] = [];
    const seen = new Set<string>();
    let current = this.byId.get(leafId);
    if (!current) throw new FlockError("mirror_entry_missing", `Session entry ${leafId} is not mirrored`, 409);
    while (current) {
      if (seen.has(current.id)) throw new FlockError("mirror_invalid", `Session tree cycle at ${current.id}`);
      seen.add(current.id);
      branch.unshift(current);
      current = current.parentId === null ? undefined : this.byId.get(current.parentId);
      if (!current && branch[0]!.parentId !== null) {
        throw new FlockError("mirror_invalid", `Session branch has a missing parent`);
      }
    }
    return branch;
  }

  private index(entry: SessionTreeEntry): void {
    this.entriesValue.push(entry);
    this.byId.set(entry.id, entry);
    this.selectedLeafValue = entry.type === "leaf" ? entry.targetId : entry.id;
  }
}

function parseHeader(value: unknown): PiSessionHeader {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { type?: unknown }).type !== "session" ||
    (value as { version?: unknown }).version !== 3 ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { timestamp?: unknown }).timestamp !== "string" ||
    typeof (value as { cwd?: unknown }).cwd !== "string"
  ) {
    throw new FlockError("mirror_invalid", "Hub returned an invalid Pi v3 session header");
  }
  return value as PiSessionHeader;
}

function parseEntry(value: unknown): SessionTreeEntry {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { type?: unknown }).type !== "string" ||
    typeof (value as { id?: unknown }).id !== "string" ||
    ((value as { parentId?: unknown }).parentId !== null &&
      typeof (value as { parentId?: unknown }).parentId !== "string") ||
    typeof (value as { timestamp?: unknown }).timestamp !== "string"
  ) {
    throw new FlockError("mirror_invalid", "Hub returned an invalid Pi session entry");
  }
  return value as SessionTreeEntry;
}

function assertContinuous(envelopes: readonly SessionEnvelope[], start: number): void {
  for (const [index, envelope] of envelopes.entries()) {
    if (envelope.seq !== start + index) {
      throw new FlockError("mirror_gap", `Snapshot sequence is not continuous at ${envelope.seq}`);
    }
  }
}

function validateTree(entries: readonly SessionTreeEntry[]): void {
  const byId = new Map<string, SessionTreeEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new FlockError("mirror_invalid", `Duplicate session entry ${entry.id}`);
    validateEntryParent(entry, byId);
    byId.set(entry.id, entry);
  }
}

function validateEntryParent(entry: SessionTreeEntry, byId: ReadonlyMap<string, SessionTreeEntry>): void {
  if (entry.parentId !== null && !byId.has(entry.parentId)) {
    throw new FlockError("mirror_invalid", `Session entry ${entry.id} has missing parent ${entry.parentId}`);
  }
  if (entry.type === "leaf" && entry.targetId !== null && !byId.has(entry.targetId)) {
    throw new FlockError("mirror_invalid", `Session leaf ${entry.id} has missing target ${entry.targetId}`);
  }
}

