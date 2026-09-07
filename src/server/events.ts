import { EventEmitter } from "node:events";

export type OpenEvent = {
  type: "open";
  trackerId: string;
  subject: string;
  recipients: string[];
  ts: number;
  client: string | null;
  device: string | null;
  openCount: number;
};

class Bus extends EventEmitter {
  emitOpen(e: OpenEvent): void {
    this.emit("open", e);
  }
  onOpen(fn: (e: OpenEvent) => void): () => void {
    this.on("open", fn);
    return () => this.off("open", fn);
  }
}

/** Process-wide in-memory event bus. Fine for a single-node deployment. */
export const bus = new Bus();
bus.setMaxListeners(0);
