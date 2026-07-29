import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { WebSocket } from "ws";
import { BrowserEventBus } from "../../src/hub/event-bus.ts";

class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly messages: unknown[] = [];

  send(value: string): void {
    this.messages.push(JSON.parse(value));
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

test("browser events are delivered and replayed only within their project", () => {
  const bus = new BrowserEventBus();
  const first = new FakeSocket();
  const second = new FakeSocket();
  bus.add(first as unknown as WebSocket, "project-one");
  bus.add(second as unknown as WebSocket, "project-two");

  const firstEvent = bus.publish({
    type: "presence",
    projectId: "project-one",
    agentId: "agent-one",
    status: "online",
    lastSeenAt: new Date().toISOString(),
  });
  const secondEvent = bus.publish({
    type: "job",
    projectId: "project-two",
    jobId: "job-two",
    status: "queued",
    agentId: null,
    leafId: null,
  });

  assert.deepEqual(first.messages, [firstEvent]);
  assert.deepEqual(second.messages, [secondEvent]);

  const replay = new FakeSocket();
  bus.add(replay as unknown as WebSocket, "project-one", 0);
  assert.deepEqual(replay.messages, [firstEvent]);

  const afterCursor = new FakeSocket();
  bus.add(afterCursor as unknown as WebSocket, "project-one", firstEvent.cursor);
  assert.deepEqual(afterCursor.messages, []);
  bus.close();
});
