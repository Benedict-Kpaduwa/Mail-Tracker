import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = resolve(root, "src/dashboard/logo.svg");
const outDir = resolve(root, "dist/dashboard/icons");

mkdirSync(outDir, { recursive: true });
const svg = readFileSync(svgPath);

const targets = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  // apple-touch-icon must be opaque; iOS applies its own mask/rounding.
  { file: "apple-touch-icon.png", size: 180, flatten: "#4f46e5" },
  { file: "favicon-48.png", size: 48 },
  { file: "favicon-32.png", size: 32 },
];

for (const t of targets) {
  let img = sharp(svg, { density: 384 }).resize(t.size, t.size);
  if (t.flatten) img = img.flatten({ background: t.flatten });
  await img.png().toFile(resolve(outDir, t.file));
  console.log(`icons -> ${t.file}`);
}
