import cron from "node-cron";
import nodemailer from "nodemailer";
import { config } from "./config.js";
import { db, getMeta, setMeta } from "./db.js";

const LAST_RUN_KEY = "last_digest_at";

type DigestRow = {
  id: string;
  subject: string;
  recipients: string;
  sent_at: number;
  new_opens: number;
  last_open_at: number;
};

function buildDigest(sinceMs: number): { rows: DigestRow[]; totalOpens: number } {
  const rows = db()
    .prepare(
      `SELECT t.id, t.subject, t.recipients, t.sent_at,
              COUNT(o.id) AS new_opens,
              MAX(o.ts)   AS last_open_at
         FROM trackers t
         JOIN opens o ON o.tracker_id = t.id
        WHERE o.ts > ?
        GROUP BY t.id
        ORDER BY last_open_at DESC`,
    )
    .all(sinceMs) as DigestRow[];
  const totalOpens = rows.reduce((n, r) => n + r.new_opens, 0);
  return { rows, totalOpens };
}

function renderHtml(rows: DigestRow[], totalOpens: number, sinceMs: number): string {
  const since = new Date(sinceMs).toLocaleString();
  const items = rows
    .map((r) => {
      let recips: string[] = [];
      try {
        recips = JSON.parse(r.recipients);
      } catch {
        /* ignore */
      }
      const to = recips.join(", ") || "(unknown)";
      const last = new Date(r.last_open_at).toLocaleString();
      return `<li style="margin:0 0 10px">
        <strong>${escapeHtml(r.subject || "(no subject)")}</strong><br>
        <span style="color:#555">to ${escapeHtml(to)}</span><br>
        ${r.new_opens} new open${r.new_opens === 1 ? "" : "s"} · last ${escapeHtml(last)}
      </li>`;
    })
    .join("");

  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111">
    <h2 style="margin:0 0 4px">Mail Tracker digest</h2>
    <p style="margin:0 0 16px;color:#555">${totalOpens} open${
      totalOpens === 1 ? "" : "s"
    } across ${rows.length} email${rows.length === 1 ? "" : "s"} since ${escapeHtml(since)}</p>
    <ul style="padding-left:18px;margin:0">${items}</ul>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export async function runDigestOnce(opts: { force?: boolean } = {}): Promise<{
  sent: boolean;
  reason?: string;
  totalOpens: number;
}> {
  const now = Date.now();
  const last = Number(getMeta(LAST_RUN_KEY) ?? 0) || now - 24 * 3600 * 1000;
  const { rows, totalOpens } = buildDigest(last);

  if (totalOpens === 0 && !opts.force) {
    setMeta(LAST_RUN_KEY, String(now));
    return { sent: false, reason: "no new opens", totalOpens: 0 };
  }

  const { smtp, to } = config.digest;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  await transport.sendMail({
    from: smtp.user,
    to,
    subject: `Mail Tracker: ${totalOpens} open${totalOpens === 1 ? "" : "s"}`,
    html: renderHtml(rows, totalOpens, last),
  });

  setMeta(LAST_RUN_KEY, String(now));
  return { sent: true, totalOpens };
}

export function startDigestScheduler(): void {
  if (!config.digest.enabled) {
    console.log("[digest] disabled (DIGEST_ENABLED=false)");
    return;
  }
  if (!cron.validate(config.digest.cron)) {
    console.error(`[digest] invalid DIGEST_CRON: ${config.digest.cron}`);
    return;
  }
  if (getMeta(LAST_RUN_KEY) === null) setMeta(LAST_RUN_KEY, String(Date.now()));

  cron.schedule(config.digest.cron, () => {
    runDigestOnce()
      .then((r) =>
        console.log(
          `[digest] ${r.sent ? "sent" : "skipped"} (${r.reason ?? r.totalOpens + " opens"})`,
        ),
      )
      .catch((err) => console.error("[digest] failed:", err));
  });
  console.log(`[digest] scheduled: ${config.digest.cron} -> ${config.digest.to}`);
}
