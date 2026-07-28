import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { FlockError, toError } from "../shared/errors.ts";

export type LeaderState = {
  nodeId: string;
  acquiredAt: string;
  epoch: string;
};

export class LeaderLock {
  readonly dataRoot: string;
  readonly nodeId: string;
  private releaseLock: (() => Promise<void>) | undefined;
  private compromisedError: Error | undefined;

  constructor(dataRoot: string, nodeId: string) {
    this.dataRoot = dataRoot;
    this.nodeId = nodeId;
  }

  get isLeader(): boolean {
    return Boolean(this.releaseLock) && !this.compromisedError;
  }

  async acquire(): Promise<LeaderState> {
    await mkdir(this.dataRoot, { recursive: true });
    const target = join(this.dataRoot, ".hub-leader");
    const handle = await open(target, "a");
    await handle.close();
    try {
      this.releaseLock = await lockfile.lock(target, {
        realpath: false,
        stale: 15_000,
        update: 5_000,
        retries: 0,
        onCompromised: (error) => {
          this.compromisedError = error;
        },
      });
    } catch (error) {
      throw new FlockError("not_leader", "Another hub node currently owns the data directory", 503, toError(error));
    }
    const state: LeaderState = {
      nodeId: this.nodeId,
      acquiredAt: new Date().toISOString(),
      epoch: `${Date.now()}-${process.pid}`,
    };
    await BunlessAtomicFile.write(`${target}.json`, JSON.stringify(state));
    return state;
  }

  assertLeader(): void {
    if (!this.releaseLock) throw new FlockError("not_leader", "This hub node is a standby", 503);
    if (this.compromisedError) {
      throw new FlockError("leader_lock_lost", "The hub leader lock was compromised", 503, this.compromisedError);
    }
  }

  async release(): Promise<void> {
    const release = this.releaseLock;
    this.releaseLock = undefined;
    if (release) await release();
  }

  async currentState(): Promise<LeaderState | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dataRoot, ".hub-leader.json"), "utf8")) as LeaderState;
    } catch {
      return undefined;
    }
  }
}

class BunlessAtomicFile {
  static async write(path: string, content: string): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  }
}
