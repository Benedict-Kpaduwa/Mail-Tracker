import { deflateSync } from "node:zlib";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extDir = resolve(root, "extension");
const srcDir = resolve(extDir, "src");
const outDir = resolve(extDir, "dist");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(resolve(outDir, "icons"), { recursive: true });

const prod = process.env.NODE_ENV === "production";

// background: MV3 service worker declared as type:module -> ESM is fine.
await esbuild.build({
  entryPoints: [resolve(srcDir, "background.ts")],
  bundle: true,
  format: "esm",
  target: ["chrome110"],
  outfile: resolve(outDir, "background.js"),
  sourcemap: !prod,
  minify: prod,
  logLevel: "info",
});

// content + options: classic scripts (content scripts can't be ESM modules).
await esbuild.build({
  entryPoints: {
    content: resolve(srcDir, "content.ts"),
    options: resolve(srcDir, "options.ts"),
  },
  bundle: true,
  format: "iife",
  target: ["chrome110"],
  outdir: outDir,
  sourcemap: !prod,
  minify: prod,
  logLevel: "info",
});

cpSync(resolve(extDir, "manifest.json"), resolve(outDir, "manifest.json"));
cpSync(resolve(srcDir, "options.html"), resolve(outDir, "options.html"));

// Copy provided icons if present; otherwise synthesize solid-color placeholders.
const providedIcons = resolve(extDir, "icons");
if (existsSync(providedIcons)) {
  cpSync(providedIcons, resolve(outDir, "icons"), { recursive: true });
} else {
  for (const size of [16, 48, 128]) {
    writeFileSync(resolve(outDir, "icons", `${size}.png`), solidPng(size, [37, 99, 235]));
  }
}

console.log(`extension -> ${outDir}`);

/* --- minimal PNG encoder: solid RGB square, no dependencies --- */
function solidPng(size, [r, g, b]) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  if (!crc32.table) {
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    crc32.table = crcTable;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}
