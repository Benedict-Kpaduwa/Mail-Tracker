import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { config } from "./config.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extracts a token from `Authorization: Bearer` or a `?token=` query param. */
export function tokenFrom(c: Context): string | null {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const q = c.req.query("token");
  return q ? q.trim() : null;
}

/** Hono middleware guarding `/api/*`. */
export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const provided = tokenFrom(c);
  if (!provided || !config.token || !safeEqual(provided, config.token)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
}
