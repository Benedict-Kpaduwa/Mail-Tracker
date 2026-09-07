import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const envPath = resolve(root, ".env");
const examplePath = resolve(root, ".env.example");

function genToken(): string {
  return randomBytes(24).toString("base64url");
}

mkdirSync(resolve(root, "data"), { recursive: true });

if (!existsSync(envPath)) {
  if (!existsSync(examplePath)) {
    console.error("Missing .env.example — cannot scaffold .env");
    process.exit(1);
  }
  const token = genToken();
  const contents = readFileSync(examplePath, "utf8").replace(
    /^MAILTRACK_TOKEN=.*$/m,
    `MAILTRACK_TOKEN=${token}`,
  );
  writeFileSync(envPath, contents);
  console.log(".env created.");
  console.log(`MAILTRACK_TOKEN=${token}`);
} else {
  let contents = readFileSync(envPath, "utf8");
  const m = contents.match(/^MAILTRACK_TOKEN=(.*)$/m);
  if (!m || !m[1]?.trim()) {
    const token = genToken();
    contents = m
      ? contents.replace(/^MAILTRACK_TOKEN=.*$/m, `MAILTRACK_TOKEN=${token}`)
      : `${contents.trimEnd()}\nMAILTRACK_TOKEN=${token}\n`;
    writeFileSync(envPath, contents);
    console.log(".env already existed; generated a missing MAILTRACK_TOKEN.");
    console.log(`MAILTRACK_TOKEN=${token}`);
  } else {
    console.log(".env already exists with a token — nothing to do.");
    console.log(`MAILTRACK_TOKEN=${m[1].trim()}`);
  }
}

console.log("\nNext:");
console.log("  npm run build   # build dashboard + extension");
console.log("  npm run dev     # start the server on http://localhost:8787");
