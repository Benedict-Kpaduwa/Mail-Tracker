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

test("a client-supplied id is honoured and is idempotent", async () => {
  const id = "mtclientsuppliedid1";
  const first = await createTracker({ id, subject: "x", recipients: ["a@b.com"] });
  assert.equal(first.status, 201);
  assert.equal(((await first.json()) as { id: string }).id, id);

  const again = await createTracker({ id, subject: "x", recipients: ["a@b.com"] });
  assert.equal(again.status, 200); // already existed, not re-created
  assert.equal(((await again.json()) as { id: string }).id, id);
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

test("delete removes the tracker and its records", async () => {
  const { id } = (await (
    await createTracker({ subject: "z", recipients: ["a@b.com"] })
  ).json()) as { id: string };

  assert.equal((await app.request(`/api/trackers/${id}`, { method: "DELETE", headers: AUTH })).status, 200);
  assert.equal((await app.request(`/api/trackers/${id}`, { headers: AUTH })).status, 404);
});
