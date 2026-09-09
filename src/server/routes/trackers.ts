import { Hono } from "hono";
import { nanoid } from "nanoid";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { db, type OpenRow, type HitRow, type TrackerRow } from "../db.js";
import { bus } from "../events.js";
import { pixelUrl } from "../pixel.js";

export const trackerRoutes = new Hono();

trackerRoutes.use("/api/*", requireAuth);

type CreateBody = {
  id?: string;
  subject?: string;
  recipients?: string[];
  threadId?: string | null;
  gmailMessageId?: string | null;
  sentAt?: number;
};

const ID_RE = /^[A-Za-z0-9_-]{10,40}$/;

/**
 * Called by the Chrome extension when a Gmail send is triggered. The extension
 * generates the id client-side (so it can build the pixel URL and inject it
 * synchronously without waiting on this request), then sends it here. Idempotent
 * on `id` so a retry can't create a duplicate.
 */
trackerRoutes.post("/api/trackers", async (c) => {
  let body: CreateBody;
  try {
    body = (await c.req.json()) as CreateBody;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const id = body.id && ID_RE.test(body.id) ? body.id : nanoid(16);
  const now = Date.now();
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.filter((r) => typeof r === "string").slice(0, 50)
    : [];
  const sentAt =
    typeof body.sentAt === "number" && Number.isFinite(body.sentAt)
      ? body.sentAt
      : now;

  const existing = db().prepare("SELECT id FROM trackers WHERE id = ?").get(id);
  if (!existing) {
    db()
      .prepare(
        `INSERT INTO trackers (id, created_at, subject, recipients, thread_id, gmail_message_id, sent_at, ignored)
         VALUES (?,?,?,?,?,?,?,0)`,
      )
      .run(
        id,
        now,
        (body.subject ?? "").slice(0, 500),
        JSON.stringify(recipients),
        body.threadId ?? null,
        body.gmailMessageId ?? null,
        sentAt,
      );
  }

  return c.json({ id, pixelUrl: pixelUrl(id) }, existing ? 200 : 201);
});

type ListRow = TrackerRow & {
  open_count: number;
  first_open_at: number | null;
  last_open_at: number | null;
};

trackerRoutes.get("/api/trackers", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 1000);
  const rows = db()
    .prepare(
      `SELECT t.*,
              COUNT(o.id)  AS open_count,
              MIN(o.ts)    AS first_open_at,
              MAX(o.ts)    AS last_open_at
         FROM trackers t
         LEFT JOIN opens o ON o.tracker_id = t.id
        GROUP BY t.id
        -- most recent activity first: last open, or sent time if never opened
        ORDER BY COALESCE(last_open_at, t.sent_at) DESC
        LIMIT ?`,
    )
    .all(limit) as ListRow[];

  return c.json({
    trackers: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      recipients: safeParse(r.recipients),
      threadId: r.thread_id,
      sentAt: r.sent_at,
      ignored: !!r.ignored,
      openCount: r.open_count,
      firstOpenAt: r.first_open_at,
      lastOpenAt: r.last_open_at,
    })),
  });
});

type ActivityRow = {
  tracker_id: string;
  ts: number;
  client: string | null;
  device: string | null;
  subject: string;
  recipients: string;
};

/** Recent counted opens across all trackers — feeds the in-Gmail activity panel. */
trackerRoutes.get("/api/activity", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 40) || 40, 200);
  const rows = db()
    .prepare(
      `SELECT o.tracker_id, o.ts, o.client, o.device, t.subject, t.recipients
         FROM opens o
         JOIN trackers t ON t.id = o.tracker_id
        WHERE t.ignored = 0
        ORDER BY o.ts DESC
        LIMIT ?`,
    )
    .all(limit) as ActivityRow[];

  return c.json({
    activity: rows.map((r) => ({
      trackerId: r.tracker_id,
      ts: r.ts,
      client: r.client,
      device: r.device,
      subject: r.subject,
      recipient: safeParse(r.recipients)[0] ?? null,
    })),
  });
});

trackerRoutes.get("/api/trackers/:id", (c) => {
  const id = c.req.param("id");
  const t = db().prepare("SELECT * FROM trackers WHERE id = ?").get(id) as
    | TrackerRow
    | undefined;
  if (!t) return c.json({ error: "not found" }, 404);

  const opens = db()
    .prepare("SELECT * FROM opens WHERE tracker_id = ? ORDER BY ts DESC")
    .all(id) as OpenRow[];
  const hits = db()
    .prepare("SELECT * FROM hits WHERE tracker_id = ? ORDER BY ts DESC LIMIT 200")
    .all(id) as HitRow[];

  return c.json({
    tracker: {
      id: t.id,
      subject: t.subject,
      recipients: safeParse(t.recipients),
      threadId: t.thread_id,
      gmailMessageId: t.gmail_message_id,
      sentAt: t.sent_at,
      createdAt: t.created_at,
      ignored: !!t.ignored,
    },
    opens: opens.map((o) => ({
      id: o.id,
      ts: o.ts,
      ip: o.ip,
      client: o.client,
      device: o.device,
    })),
    hits: hits.map((h) => ({
      id: h.id,
      ts: h.ts,
      ip: h.ip,
      ua: h.ua,
      client: h.client,
      device: h.device,
      isProxy: !!h.is_proxy,
      counted: !!h.counted,
    })),
  });
});

trackerRoutes.patch("/api/trackers/:id", async (c) => {
  const id = c.req.param("id");
  let body: { ignored?: boolean };
  try {
    body = (await c.req.json()) as { ignored?: boolean };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.ignored !== "boolean") {
    return c.json({ error: "expected { ignored: boolean }" }, 400);
  }
  const res = db()
    .prepare("UPDATE trackers SET ignored = ? WHERE id = ?")
    .run(body.ignored ? 1 : 0, id);
  if (res.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, ignored: body.ignored });
});

/**
 * The extension calls this when the sender opens their own tracked mail. Records
 * the moment (so `recordHit` suppresses the matching proxy fetch) and undoes any
 * open already counted in the last `selfViewWindowSec` seconds — covers the race
 * where the pixel fetch landed before this report.
 */
trackerRoutes.post("/api/trackers/:id/self-view", (c) => {
  const id = c.req.param("id");
  const now = Date.now();
  const since = now - config.selfViewWindowSec * 1000;

  const upd = db()
    .prepare("UPDATE trackers SET last_self_view_at = ? WHERE id = ?")
    .run(now, id);
  if (upd.changes === 0) return c.json({ error: "not found" }, 404);

  const removed = db()
    .prepare("DELETE FROM opens WHERE tracker_id = ? AND ts >= ?")
    .run(id, since).changes;
  if (removed > 0) {
    db()
      .prepare("UPDATE hits SET counted = 0 WHERE tracker_id = ? AND counted = 1 AND ts >= ?")
      .run(id, since);
  }

  const { c: openCount } = db()
    .prepare("SELECT COUNT(*) AS c FROM opens WHERE tracker_id = ?")
    .get(id) as { c: number };

  if (removed > 0) bus.emitRecount({ type: "recount", trackerId: id, openCount });
  return c.json({ ok: true, removed, openCount });
});

// Tracked emails are intentionally immutable — there is no delete endpoint.
// Use PATCH { ignored: true } to exclude one from open counts.

function safeParse(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
