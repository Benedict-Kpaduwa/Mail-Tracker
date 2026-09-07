import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { assertRuntimeConfig, config } from "./config.js";
import { db } from "./db.js";
import { startDigestScheduler } from "./digest.js";
import { pixelRoutes } from "./routes/pixel.js";
import { streamRoutes } from "./routes/stream.js";
import { trackerRoutes } from "./routes/trackers.js";

assertRuntimeConfig();
db(); // open + migrate on boot

const app = new Hono();

app.use("*", logger());
// The extension (origin https://mail.google.com) and the dashboard both call the
// API cross-origin.
app.use("/api/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type"] }));

app.get("/healthz", (c) => c.json({ ok: true, ts: Date.now() }));

app.route("/", pixelRoutes);
app.route("/", trackerRoutes);
app.route("/", streamRoutes);

// Static dashboard (built by `npm run build:dashboard` into dist/dashboard).
const dashboardDir = "dist/dashboard";
if (existsSync(dashboardDir)) {
  app.use("/", serveStatic({ path: `${dashboardDir}/index.html` }));
  app.use("/*", serveStatic({ root: `./${dashboardDir}` }));
} else {
  app.get("/", (c) =>
    c.text(
      "Dashboard not built yet. Run `npm run build:dashboard` (or `npm run build`).",
      200,
    ),
  );
}

startDigestScheduler();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`mail-tracker listening on http://localhost:${info.port}`);
  console.log(`  pixel base:   ${config.baseUrl}/px/<id>.gif`);
  console.log(`  dashboard:    http://localhost:${info.port}/`);
  if (config.baseUrl.includes("localhost")) {
    console.log(
      "  note: BASE_URL is localhost — set it to your tunnel/deploy URL before sending real mail.",
    );
  }
});
