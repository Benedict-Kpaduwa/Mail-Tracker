import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = resolve(root, "src/dashboard");
const outDir = resolve(root, "dist/dashboard");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(srcDir, "app.ts")],
  bundle: true,
  format: "iife",
  target: ["es2020"],
  outfile: resolve(outDir, "app.js"),
  sourcemap: true,
  minify: process.env.NODE_ENV === "production",
  logLevel: "info",
});

for (const f of ["index.html", "styles.css", "logo.svg", "sw.js"]) {
  cpSync(resolve(srcDir, f), resolve(outDir, f));
}

const manifest = {
  name: "Mail Tracker",
  short_name: "Tracker",
  description: "See when your Gmail messages get opened.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0b0c10",
  theme_color: "#4f46e5",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};
writeFileSync(resolve(outDir, "manifest.webmanifest"), JSON.stringify(manifest, null, 2));

try {
  await import("./build-icons.mjs");
} catch (err) {
  console.warn(
    `[build-dashboard] icon rasterisation skipped (${err?.message ?? err}). ` +
      "PWA install icons won't be generated, but the app still works. Install `sharp` to fix.",
  );
}

console.log(`dashboard -> ${outDir}`);
