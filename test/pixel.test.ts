import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Env must be set before importing anything that reads config.
const workdir = mkdtempSync(join(tmpdir(), "mailtrack-pixel-"));
process.env.DB_PATH = join(workdir, "test.db");
process.env.MAILTRACK_TOKEN = "test-token";
process.env.BASE_URL = "http://test.local";
process.env.SELF_OPEN_WINDOW_SEC = "15";
process.env.DEDUPE_WINDOW_SEC = "120";
process.env.DIGEST_ENABLED = "false";

const { db } = await import("../src/server/db.js");
const { recordHit } = await import("../src/server/pixel.js");
const { bus } = await import("../src/server/events.js");

const GMAIL_PROXY = "Mozilla/5.0 (GoogleImageProxy)";

let seq = 0;
function makeTracker(opts: { sentAtOffsetMs?: number; ignored?: boolean } = {}): string {
  const id = `t${Date.now()}_${seq++}`;
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO trackers (id, created_at, subject, recipients, thread_id, gmail_message_id, sent_at, ignored)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      now,
      "Subject",
      JSON.stringify(["a@b.com"]),
      null,
      null,
      now - (opts.sentAtOffsetMs ?? 60_000),
      opts.ignored ? 1 : 0,
    );
  return id;
}

const countOpens = (id: string) =>
  (db().prepare("SELECT COUNT(*) c FROM opens WHERE tracker_id = ?").get(id) as { c: number }).c;
const countHits = (id: string) =>
  (db().prepare("SELECT COUNT(*) c FROM hits WHERE tracker_id = ?").get(id) as { c: number }).c;

beforeEach(() => {
  db().exec("DELETE FROM opens; DELETE FROM hits; DELETE FROM trackers;");
});

after(() => rmSync(workdir, { recursive: true, force: true }));

test("a normal proxy fetch counts as one open", () => {
  const id = makeTracker();
  recordHit({ trackerId: id, ip: "66.249.84.1", ua: GMAIL_PROXY });
  assert.equal(countOpens(id), 1);
  assert.equal(countHits(id), 1);
});

test("fetches inside the self-open window do not count", () => {
  const id = makeTracker({ sentAtOffsetMs: 2_000 }); // 2s ago, inside 15s window
  recordHit({ trackerId: id, ip: null, ua: GMAIL_PROXY });
  assert.equal(countOpens(id), 0);
  assert.equal(countHits(id), 1, "still logged as a raw hit");
});

test("repeat fetches inside the dedupe window collapse to one open", () => {
  const id = makeTracker();
  recordHit({ trackerId: id, ip: null, ua: GMAIL_PROXY });
  recordHit({ trackerId: id, ip: null, ua: GMAIL_PROXY });
  recordHit({ trackerId: id, ip: null, ua: GMAIL_PROXY });
  assert.equal(countOpens(id), 1);
  assert.equal(countHits(id), 3);
});

test("bot / scanner user-agents never count", () => {
  const id = makeTracker();
  recordHit({ trackerId: id, ip: null, ua: "curl/8.4.0" });
  assert.equal(countOpens(id), 0);
});

test("an ignored tracker never counts opens", () => {
  const id = makeTracker({ ignored: true });
  recordHit({ trackerId: id, ip: null, ua: GMAIL_PROXY });
  assert.equal(countOpens(id), 0);
});

test("an unknown tracker id is ignored without throwing or counting", () => {
  assert.doesNotThrow(() => recordHit({ trackerId: "does-not-exist", ip: null, ua: GMAIL_PROXY }));
  assert.equal(countOpens("does-not-exist"), 0);
});

test("a counted open emits an 'open' event with the running count", async () => {
  const id = makeTracker();
  const event = await new Promise<{ trackerId: string; openCount: number }>((resolve) => {
    const off = bus.onOpen((e) => {
      off();
      resolve(e);
    });
    recordHit({ trackerId: id, ip: null, ua: GMAIL_PROXY });
  });
  assert.equal(event.trackerId, id);
  assert.equal(event.openCount, 1);
});
