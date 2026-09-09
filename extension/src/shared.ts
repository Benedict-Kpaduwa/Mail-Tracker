/** Types and storage helpers shared by background + options + content scripts. */

export type Settings = {
  baseUrl: string;
  token: string;
};

export type LocalState = {
  /** Global default for the "Track" toggle in new compose windows. */
  trackingEnabled: boolean;
  /** tracker id -> last seen open count, for notification diffing. */
  openSnapshot: Record<string, number>;
};

export const DEFAULT_SETTINGS: Settings = { baseUrl: "", token: "" };
export const DEFAULT_LOCAL: LocalState = { trackingEnabled: true, openSnapshot: {} };

export async function getSettings(): Promise<Settings> {
  const v = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(v as Partial<Settings>) };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}

export async function getLocal(): Promise<LocalState> {
  const v = await chrome.storage.local.get(DEFAULT_LOCAL);
  return { ...DEFAULT_LOCAL, ...(v as Partial<LocalState>) };
}

export async function setLocal(patch: Partial<LocalState>): Promise<void> {
  await chrome.storage.local.set(patch);
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export type CreateTrackerMsg = {
  type: "createTracker";
  id: string;
  subject: string;
  recipients: string[];
  sentAt: number;
};

export type CreateTrackerResult =
  | { ok: true; id: string; pixelUrl: string }
  | { ok: false; error: string };

export type PingSettingsMsg = { type: "getState" };
export type PingSettingsResult = {
  configured: boolean;
  trackingEnabled: boolean;
};

export type LookupStatusMsg = { type: "lookupStatus"; id: string };
export type LookupStatusResult =
  | { ok: true; openCount: number; ignored: boolean; lastOpenAt: number | null }
  | { ok: false; error: string };

export type TrackerSummary = {
  id: string;
  subject: string;
  recipients: string[];
  sentAt: number;
  ignored: boolean;
  openCount: number;
  firstOpenAt: number | null;
  lastOpenAt: number | null;
};

export type ActivityItem = {
  trackerId: string;
  ts: number;
  client: string | null;
  device: string | null;
  subject: string;
  recipient: string | null;
};

export type GetTrackersMsg = { type: "getTrackers" };
export type GetTrackersResult =
  | { ok: true; trackers: TrackerSummary[] }
  | { ok: false; error: string };

export type GetActivityMsg = { type: "getActivity" };
export type GetActivityResult =
  | { ok: true; activity: ActivityItem[]; baseUrl: string }
  | { ok: false; error: string };
