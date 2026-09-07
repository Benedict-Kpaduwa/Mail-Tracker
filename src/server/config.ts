import { config as loadEnv } from "dotenv";

loadEnv();

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${key} must be an integer, got: ${v}`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

const rawBase = str("BASE_URL", "http://localhost:8787");

export const config = {
  /** Public origin the pixel URL is built from. No trailing slash. */
  baseUrl: rawBase.replace(/\/+$/, ""),
  port: int("PORT", 8787),
  token: str("MAILTRACK_TOKEN", ""),
  dbPath: str("DB_PATH", "./data/mailtrack.db"),
  selfOpenWindowSec: int("SELF_OPEN_WINDOW_SEC", 15),
  dedupeWindowSec: int("DEDUPE_WINDOW_SEC", 120),
  digest: {
    enabled: bool("DIGEST_ENABLED", false),
    cron: str("DIGEST_CRON", "0 8 * * *"),
    to: str("DIGEST_TO", ""),
    smtp: {
      host: str("SMTP_HOST", "smtp.gmail.com"),
      port: int("SMTP_PORT", 465),
      user: str("SMTP_USER", ""),
      pass: str("SMTP_PASS", ""),
    },
  },
};

export function assertRuntimeConfig(): void {
  if (!config.token) {
    throw new Error(
      "MAILTRACK_TOKEN is not set. Run `npm run init` to generate one, or set it in .env.",
    );
  }
  if (config.digest.enabled) {
    const { to, smtp } = config.digest;
    if (!to || !smtp.user || !smtp.pass) {
      throw new Error(
        "DIGEST_ENABLED=true but DIGEST_TO / SMTP_USER / SMTP_PASS are incomplete.",
      );
    }
  }
}
