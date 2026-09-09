import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const workdir = mkdtempSync(join(tmpdir(), "mailtrack-api-"));
process.env.DB_PATH = join(workdir, "test.db");
process.env.MAILTRACK_TOKEN = "test-token";
process.env.BASE_URL = "http://test.local";
process.env.SELF_OPEN_WINDOW_SEC = "15";
process.env.DEDUPE_WINDOW_SEC = "120";
process.env.DIGEST_ENABLED = "false";

const { Hono } = await import("hono");
const { pixelRoutes } = await import("../src/server/routes/pixel.js");
const { trackerRoutes } = await import("../src/server/routes/trackers.js");

const app = new Hono();
app.route("/", pixelRoutes);
app.route("/", trackerRoutes);

const AUTH = { authorization: "Bearer test-token" };
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };
const tick = () => new Promise((r) => setTimeout(r, 25)); // let queueMicrotask(recordHit) run

after(() => rmSync(workdir, { recursive: true, force: true }));

async function createTracker(body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/trackers", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

test("the API rejects requests without the bearer token", async () => {
  assert.equal((await app.request("/api/trackers")).status, 401);
  assert.equal(
    (await app.request("/api/trackers", { headers: { authorization: "Bearer wrong" } })).status,
    401,
  );
});

test("the pixel is public and returns a GIF", async () => {
  const res = await app.request("/px/whatever.gif");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/gif");
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});

test("create → open → the count shows up in the list", async () => {
  const created = await createTracker({
    subject: "Proposal",
    recipients: ["jane@acme.com"],
    sentAt: Date.now() - 60_000,
  });
  assert.equal(created.status, 201);
  const { id, pixelUrl } = (await created.json()) as { id: string; pixelUrl: string };
  assert.equal(pixelUrl, `http://test.local/px/${id}.gif`);

  const px = await app.request(`/px/${id}.gif`, {
    headers: { "user-agent": "Mozilla/5.0 (GoogleImageProxy)" },
  });
  assert.equal(px.status, 200);
  await tick();

  const list = await app.request("/api/trackers", { headers: AUTH });
  const { trackers } = (await list.json()) as { trackers: Array<{ id: string; openCount: number }> };
  assert.equal(trackers.find((t) => t.id === id)?.openCount, 1);
});

test("the list is ordered by most recent activity (last open, else sent)", async () => {
  const proxy = { "user-agent": "Mozilla/5.0 (GoogleImageProxy)" };
  const now = Date.now();

  // A: sent long ago, opened just now  -> should end up first
  const a = (await (await createTracker({ id: "mtorderaaaaaa", subject: "A", recipients: ["a@x.com"], sentAt: now - 3_600_000 })).json()) as { id: string };
  // B: sent recently, never opened
  const b = (await (await createTracker({ id: "mtorderbbbbbb", subject: "B", recipients: ["b@x.com"], sentAt: now - 120_000 })).json()) as { id: string };
  // C: sent a while ago, never opened
  await createTracker({ id: "mtordercccccc", subject: "C", recipients: ["c@x.com"], sentAt: now - 600_000 });

  await app.request(`/px/${a.id}.gif`, { headers: proxy });
  await tick();

  const { trackers } = (await (await app.request("/api/trackers", { headers: AUTH })).json()) as {
    trackers: Array<{ id: string }>;
  };
  const order = trackers.map((t) => t.id);
  assert.equal(order.indexOf("mtorderaaaaaa") < order.indexOf("mtorderbbbbbb"), true, "opened A before unopened B");
  assert.equal(order.indexOf("mtorderbbbbbb") < order.indexOf("mtordercccccc"), true, "newer-sent B before older-sent C");
});

test("a client-supplied id is honoured and is idempotent", async () => {
  const id = "mtclientsuppliedid1";
  const first = await createTracker({ id, subject: "x", recipients: ["a@b.com"] });
  assert.equal(first.status, 201);
  assert.equal(((await first.json()) as { id: string }).id, id);

  const again = await createTracker({ id, subject: "x", recipients: ["a@b.com"] });
  assert.equal(again.status, 200); // already existed, not re-created
  assert.equal(((await again.json()) as { id: string }).id, id);
});

test("a reported self-view suppresses and rolls back the sender's own open", async () => {
  const proxy = { "user-agent": "Mozilla/5.0 (GoogleImageProxy)" };

  // Case 1: self-view reported first -> the following open is not counted.
  const a = (await (
    await createTracker({ subject: "SV a", recipients: ["r@x.com"], sentAt: Date.now() - 60_000 })
  ).json()) as { id: string };
  const sv = await app.request(`/api/trackers/${a.id}/self-view`, { method: "POST", headers: AUTH });
  assert.equal(sv.status, 200);
  await app.request(`/px/${a.id}.gif`, { headers: proxy });
  await tick();
  let detail = (await (await app.request(`/api/trackers/${a.id}`, { headers: AUTH })).json()) as {
    opens: unknown[];
    hits: Array<{ counted: boolean }>;
  };
  assert.equal(detail.opens.length, 0, "open suppressed when self-view came first");
  assert.equal(detail.hits.length, 1, "the pixel fetch is still logged as a raw hit");

  // Case 2: open counted first, THEN self-view reported -> it's rolled back.
  const b = (await (
    await createTracker({ subject: "SV b", recipients: ["r@x.com"], sentAt: Date.now() - 60_000 })
  ).json()) as { id: string };
  await app.request(`/px/${b.id}.gif`, { headers: proxy });
  await tick();
  detail = (await (await app.request(`/api/trackers/${b.id}`, { headers: AUTH })).json()) as {
    opens: unknown[];
    hits: Array<{ counted: boolean }>;
  };
  assert.equal(detail.opens.length, 1, "open counted before the self-view report");

  const roll = await app.request(`/api/trackers/${b.id}/self-view`, { method: "POST", headers: AUTH });
  assert.equal(((await roll.json()) as { removed: number }).removed, 1);
  detail = (await (await app.request(`/api/trackers/${b.id}`, { headers: AUTH })).json()) as {
    opens: unknown[];
    hits: Array<{ counted: boolean }>;
  };
  assert.equal(detail.opens.length, 0, "open rolled back after self-view report");
});

test("the ignore toggle stops opens counting", async () => {
  const { id } = (await (
    await createTracker({ subject: "y", recipients: ["a@b.com"], sentAt: Date.now() - 60_000 })
  ).json()) as { id: string };

  const patch = await app.request(`/api/trackers/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ignored: true }),
  });
  assert.equal(patch.status, 200);

  await app.request(`/px/${id}.gif`, { headers: { "user-agent": "Mozilla/5.0 (GoogleImageProxy)" } });
  await tick();

  const detail = await (await app.request(`/api/trackers/${id}`, { headers: AUTH })).json();
  assert.equal((detail as { opens: unknown[] }).opens.length, 0);
  assert.equal((detail as { tracker: { ignored: boolean } }).tracker.ignored, true);
});

test("/api/activity returns recent opens with tracker context, newest first", async () => {
  const proxy = { "user-agent": "Mozilla/5.0 (GoogleImageProxy)" };
  const { id } = (await (
    await createTracker({ subject: "Activity subject", recipients: ["dana@x.com"], sentAt: Date.now() - 60_000 })
  ).json()) as { id: string };

  await app.request(`/px/${id}.gif`, { headers: proxy });
  await tick();

  const res = await app.request("/api/activity?limit=5", { headers: AUTH });
  assert.equal(res.status, 200);
  const { activity } = (await res.json()) as {
    activity: Array<{ trackerId: string; subject: string; recipient: string | null; ts: number }>;
  };
  const mine = activity.find((a) => a.trackerId === id);
  assert.ok(mine, "the open shows up in activity");
  assert.equal(mine!.subject, "Activity subject");
  assert.equal(mine!.recipient, "dana@x.com");
  // newest first
  for (let i = 1; i < activity.length; i++) assert.ok(activity[i - 1]!.ts >= activity[i]!.ts);
});

test("tracked emails cannot be deleted (no DELETE route)", async () => {
  const { id } = (await (
    await createTracker({ subject: "z", recipients: ["a@b.com"] })
  ).json()) as { id: string };

  // No DELETE handler is registered, so Hono 404s the method+path.
  assert.equal((await app.request(`/api/trackers/${id}`, { method: "DELETE", headers: AUTH })).status, 404);
  // ...and the tracker is still there.
  assert.equal((await app.request(`/api/trackers/${id}`, { headers: AUTH })).status, 200);
});
