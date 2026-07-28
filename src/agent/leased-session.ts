import {
  InMemorySessionStorage,
  SessionError,
  type SessionEntryCursorOptions,
  type SessionMetadata,
  type SessionStats,
  type SessionStorage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

export type RemoteAppend = (entry: SessionTreeEntry) => Promise<void>;

export class LeasedSessionStorage implements SessionStorage {
  private readonly memory: InMemorySessionStorage;
  private readonly appendRemote: RemoteAppend;

  constructor(options: {
    metadata: SessionMetadata;
    branch: SessionTreeEntry[];
    appendRemote: RemoteAppend;
  }) {
    this.memory = new InMemorySessionStorage({ metadata: options.metadata, entries: options.branch });
    this.appendRemote = options.appendRemote;
  }

  getMetadata(): Promise<SessionMetadata> {
    return this.memory.getMetadata();
  }

  getLeafId(): Promise<string | null> {
    return this.memory.getLeafId();
  }

  async setLeafId(): Promise<void> {
    throw new SessionError("invalid_entry", "Only a human may select a shared Flock branch");
  }

  createEntryId(): Promise<string> {
    return this.memory.createEntryId();
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    await this.appendRemote(entry);
    await this.memory.appendEntry(entry);
  }

  getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return this.memory.getEntry(id);
  }

  findEntries<Type extends SessionTreeEntry["type"]>(
    type: Type,
  ): Promise<Array<Extract<SessionTreeEntry, { type: Type }>>> {
    return this.memory.findEntries(type);
  }

  getLabel(id: string): Promise<string | undefined> {
    return this.memory.getLabel(id);
  }

  getSessionName(): Promise<string | undefined> {
    return this.memory.getSessionName();
  }

  getSessionStats(): Promise<SessionStats> {
    return this.memory.getSessionStats();
  }

  getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
    return this.memory.getPathToRootOrCompaction(leafId);
  }

  getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
    return this.memory.getEntries(options);
  }
}

