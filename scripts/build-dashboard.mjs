import { cpSync, mkdirSync, rmSync } from "node:fs";
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

cpSync(resolve(srcDir, "index.html"), resolve(outDir, "index.html"));
cpSync(resolve(srcDir, "styles.css"), resolve(outDir, "styles.css"));

console.log(`dashboard -> ${outDir}`);
