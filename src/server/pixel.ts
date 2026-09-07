import { config } from "./config.js";
import { db, type TrackerRow } from "./db.js";
import { bus } from "./events.js";
import { parseUa } from "./ua.js";

/** 43-byte 1x1 fully transparent GIF89a. */
export const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

export function pixelUrl(trackerId: string): string {
  return `${config.baseUrl}/px/${trackerId}.gif`;
}

type RecordArgs = {
  trackerId: string;
  ip: string | null;
  ua: string | null;
};

/**
 * Record a pixel fetch. Always inserts a raw `hits` row. Decides whether the hit
 * counts as a genuine recipient "open" via three heuristics:
 *   1. tracker is not flagged `ignored`
 *   2. hit is outside the self-open window after send
 *   3. no counted open already exists inside the dedupe window
 * Emits an `open` event on the bus when a new open is recorded.
 *
 * Safe to call after the HTTP response has been flushed; never throws.
 */
export function recordHit({ trackerId, ip, ua }: RecordArgs): void {
  try {
    const conn = db();
    const tracker = conn
      .prepare("SELECT * FROM trackers WHERE id = ?")
      .get(trackerId) as TrackerRow | undefined;

    const now = Date.now();
    const info = parseUa(ua);

    if (!tracker) {
      // Unknown id — still log the hit for debugging, but it can't be an open.
      conn
        .prepare(
          "INSERT INTO hits (tracker_id, ts, ip, ua, client, device, is_proxy, counted) VALUES (?,?,?,?,?,?,?,0)",
        )
        .run(trackerId, now, ip, ua, info.client, info.device, info.isProxy ? 1 : 0);
      return;
    }

    const withinSelfWindow =
      now - tracker.sent_at < config.selfOpenWindowSec * 1000;

    const recentOpen = conn
      .prepare(
        "SELECT 1 FROM opens WHERE tracker_id = ? AND ts >= ? LIMIT 1",
      )
      .get(trackerId, now - config.dedupeWindowSec * 1000);

    const scanner = info.device === "bot";
    const counted =
      !tracker.ignored && !withinSelfWindow && !recentOpen && !scanner;

    const insertHit = conn.prepare(
      "INSERT INTO hits (tracker_id, ts, ip, ua, client, device, is_proxy, counted) VALUES (?,?,?,?,?,?,?,?)",
    );

    if (!counted) {
      insertHit.run(
        trackerId,
        now,
        ip,
        ua,
        info.client,
        info.device,
        info.isProxy ? 1 : 0,
        0,
      );
      return;
    }

    const tx = conn.transaction(() => {
      insertHit.run(
        trackerId,
        now,
        ip,
        ua,
        info.client,
        info.device,
        info.isProxy ? 1 : 0,
        1,
      );
      conn
        .prepare(
          "INSERT INTO opens (tracker_id, ts, ip, client, device) VALUES (?,?,?,?,?)",
        )
        .run(trackerId, now, ip, info.client, info.device);
      const { c } = conn
        .prepare("SELECT COUNT(*) AS c FROM opens WHERE tracker_id = ?")
        .get(trackerId) as { c: number };
      return c;
    });
    const openCount = tx();

    let recipients: string[] = [];
    try {
      recipients = JSON.parse(tracker.recipients) as string[];
    } catch {
      recipients = [];
    }

    bus.emitOpen({
      type: "open",
      trackerId,
      subject: tracker.subject,
      recipients,
      ts: now,
      client: info.client,
      device: info.device,
      openCount,
    });
  } catch (err) {
    console.error("[pixel] recordHit failed:", err);
  }
}
