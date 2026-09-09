import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { tokenFrom } from "../auth.js";
import { config } from "../config.js";
import { bus, type OpenEvent, type RecountEvent } from "../events.js";

type Queued =
  | { event: "open"; data: OpenEvent }
  | { event: "recount"; data: RecountEvent };

export const streamRoutes = new Hono();

/**
 * Server-Sent Events stream of open events. `EventSource` can't set headers, so
 * this route also accepts `?token=` (checked here rather than via the shared
 * middleware).
 */
streamRoutes.get("/api/events/stream", (c) => {
  const provided = tokenFrom(c);
  if (!provided || provided !== config.token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  return streamSSE(c, async (stream) => {
    let running = true;
    const queue: Queued[] = [];
    let wake: (() => void) | null = null;

    const offOpen = bus.onOpen((data) => {
      queue.push({ event: "open", data });
      wake?.();
    });
    const offRecount = bus.onRecount((data) => {
      queue.push({ event: "recount", data });
      wake?.();
    });
    const off = () => {
      offOpen();
      offRecount();
    };
    stream.onAbort(() => {
      running = false;
      wake?.();
    });

    await stream.writeSSE({ event: "ready", data: JSON.stringify({ ts: Date.now() }) });

    try {
      while (running) {
        while (queue.length && running) {
          const q = queue.shift()!;
          await stream.writeSSE({ event: q.event, data: JSON.stringify(q.data) });
        }
        if (!running) break;

        // Wait for the next event or a 20s keepalive timeout, whichever first.
        await new Promise<void>((res) => {
          const timer = setTimeout(() => {
            wake = null;
            res();
          }, 20_000);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            res();
          };
        });

        if (running && queue.length === 0) {
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        }
      }
    } finally {
      off();
    }
  });
});
