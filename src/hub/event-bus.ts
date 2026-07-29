import { WebSocket } from "ws";
import type { BrowserEvent, BrowserEventInput } from "../shared/protocol.ts";

export class BrowserEventBus {
  private cursor = 0;
  private readonly retained: BrowserEvent[] = [];
  private readonly clients = new Map<WebSocket, string>();

  add(socket: WebSocket, projectId: string, afterCursor = 0): void {
    this.clients.set(socket, projectId);
    for (const event of this.retained) {
      if (event.cursor <= afterCursor) continue;
      if (event.projectId !== projectId) continue;
      socket.send(JSON.stringify(event));
    }
    socket.once("close", () => this.clients.delete(socket));
  }

  publish(event: BrowserEventInput): BrowserEvent {
    const complete = { ...event, cursor: ++this.cursor } as BrowserEvent;
    this.retained.push(complete);
    if (this.retained.length > 1_000) this.retained.splice(0, this.retained.length - 1_000);
    const serialized = JSON.stringify(complete);
    for (const [socket, projectId] of this.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (complete.projectId !== projectId) continue;
      socket.send(serialized);
    }
    return complete;
  }

  close(): void {
    for (const socket of this.clients.keys()) socket.close(1012, "Hub leadership changed");
    this.clients.clear();
  }
}
