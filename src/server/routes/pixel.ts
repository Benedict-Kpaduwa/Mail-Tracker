import { Hono } from "hono";
import { PIXEL_GIF, recordHit } from "../pixel.js";

export const pixelRoutes = new Hono();

/**
 * The tracking pixel. Public and unauthenticated — recipients' mail clients must
 * be able to fetch it. Responds immediately with the GIF, then logs the hit
 * without blocking the response.
 */
pixelRoutes.get("/px/:file", (c) => {
  const file = c.req.param("file");
  const trackerId = file.replace(/\.(gif|png|jpg)$/i, "");

  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    null;
  const ua = c.req.header("user-agent") ?? null;

  queueMicrotask(() => recordHit({ trackerId, ip, ua }));

  return c.body(PIXEL_GIF, 200, {
    "Content-Type": "image/gif",
    "Content-Length": String(PIXEL_GIF.length),
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
});
