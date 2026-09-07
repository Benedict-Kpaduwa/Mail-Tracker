/**
 * Forward-only database schema. Every statement is idempotent so it can run on
 * every boot. Embedded as a string (rather than a .sql file) so it survives
 * `tsc` compilation into dist/ without a copy step.
 */
export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS trackers (
  id                TEXT PRIMARY KEY,
  created_at        INTEGER NOT NULL,
  subject           TEXT NOT NULL DEFAULT '',
  recipients        TEXT NOT NULL DEFAULT '[]',
  thread_id         TEXT,
  gmail_message_id  TEXT,
  sent_at           INTEGER NOT NULL,
  ignored           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id  TEXT NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  ip          TEXT,
  ua          TEXT,
  client      TEXT,
  device      TEXT,
  is_proxy    INTEGER NOT NULL DEFAULT 0,
  counted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hits_tracker_ts ON hits(tracker_id, ts);

CREATE TABLE IF NOT EXISTS opens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id  TEXT NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  ip          TEXT,
  client      TEXT,
  device      TEXT
);
CREATE INDEX IF NOT EXISTS idx_opens_tracker_ts ON opens(tracker_id, ts);

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;
