import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { SCHEMA_SQL } from "./schema.js";

export type TrackerRow = {
  id: string;
  created_at: number;
  subject: string;
  recipients: string;
  thread_id: string | null;
  gmail_message_id: string | null;
  sent_at: number;
  ignored: number;
};

export type OpenRow = {
  id: number;
  tracker_id: string;
  ts: number;
  ip: string | null;
  client: string | null;
  device: string | null;
};

export type HitRow = {
  id: number;
  tracker_id: string;
  ts: number;
  ip: string | null;
  ua: string | null;
  client: string | null;
  device: string | null;
  is_proxy: number;
  counted: number;
};

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  const path = resolve(process.cwd(), config.dbPath);
  mkdirSync(dirname(path), { recursive: true });
  const conn = new Database(path);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(SCHEMA_SQL);
  _db = conn;
  return conn;
}

export function getMeta(key: string): string | null {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db()
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}
