import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUa } from "../src/server/ua.js";

test("Gmail image proxy is detected as a proxy open", () => {
  const info = parseUa(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko; GoogleImageProxy) Chrome/120 Safari/537.36",
  );
  assert.equal(info.client, "Gmail");
  assert.equal(info.device, "proxy");
  assert.equal(info.isProxy, true);
});

test("scanners / scripts are flagged as bots", () => {
  for (const ua of ["curl/8.4.0", "python-requests/2.31", "Proofpoint/1.0"]) {
    assert.equal(parseUa(ua).device, "bot", ua);
  }
});

test("plain desktop browser", () => {
  const info = parseUa(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
  );
  assert.equal(info.client, "Chrome");
  assert.equal(info.device, "desktop");
  assert.equal(info.isProxy, false);
});

test("mobile browser", () => {
  const info = parseUa(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/121 Mobile/15E148 Safari/604.1",
  );
  assert.equal(info.device, "mobile");
});

test("empty / missing UA is unknown, not a bot", () => {
  assert.deepEqual(parseUa(""), { client: "unknown", device: "unknown", isProxy: false });
  assert.deepEqual(parseUa(null), { client: "unknown", device: "unknown", isProxy: false });
});
