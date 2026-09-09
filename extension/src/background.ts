import {
  getLocal,
  getSettings,
  normalizeBaseUrl,
  setLocal,
  type ActivityItem,
  type CreateTrackerMsg,
  type CreateTrackerResult,
  type GetActivityResult,
  type GetTrackersResult,
  type PingSettingsResult,
  type TrackerSummary,
} from "./shared.js";

const POLL_ALARM = "mailtrack-poll";
const POLL_PERIOD_MIN = 1;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MIN });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MIN });
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === POLL_ALARM) void pollOpens();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "createTracker") {
    void handleCreate(msg as CreateTrackerMsg).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === "getState") {
    void getState().then(sendResponse);
    return true;
  }
  if (msg?.type === "lookupStatus") {
    void lookupStatus(String(msg.id)).then(sendResponse);
    return true;
  }
  if (msg?.type === "getTrackers") {
    void getTrackers().then(sendResponse);
    return true;
  }
  if (msg?.type === "getActivity") {
    void getActivity().then(sendResponse);
    return true;
  }
  return false;
});

async function apiGet<T>(path: string): Promise<{ ok: true; data: T; base: string } | { ok: false; error: string }> {
  const { baseUrl, token } = await getSettings();
  const base = normalizeBaseUrl(baseUrl);
  if (!base || !token) return { ok: false, error: "not configured" };
  try {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, error: `server ${res.status}` };
    return { ok: true, data: (await res.json()) as T, base };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}

async function getTrackers(): Promise<GetTrackersResult> {
  const r = await apiGet<{ trackers: TrackerSummary[] }>("/api/trackers?limit=500");
  return r.ok ? { ok: true, trackers: r.data.trackers } : { ok: false, error: r.error };
}

async function getActivity(): Promise<GetActivityResult> {
  const r = await apiGet<{ activity: ActivityItem[] }>("/api/activity?limit=40");
  return r.ok ? { ok: true, activity: r.data.activity, baseUrl: r.base } : { ok: false, error: r.error };
}

async function lookupStatus(
  id: string,
): Promise<
  | { ok: true; openCount: number; ignored: boolean; lastOpenAt: number | null }
  | { ok: false; error: string }
> {
  const { baseUrl, token } = await getSettings();
  const base = normalizeBaseUrl(baseUrl);
  if (!base || !token) return { ok: false, error: "not configured" };
  try {
    const res = await fetch(`${base}/api/trackers/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, error: `server ${res.status}` };
    const data = (await res.json()) as {
      opens: Array<{ ts: number }>;
      tracker: { ignored: boolean };
    };
    return {
      ok: true,
      openCount: data.opens.length,
      ignored: data.tracker.ignored,
      lastOpenAt: data.opens[0]?.ts ?? null,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}

async function handleCreate(msg: CreateTrackerMsg): Promise<CreateTrackerResult> {
  const { baseUrl, token } = await getSettings();
  const base = normalizeBaseUrl(baseUrl);
  if (!base || !token) {
    return { ok: false, error: "Extension not configured. Open its options page." };
  }
  try {
    const res = await fetch(`${base}/api/trackers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: msg.id,
        subject: msg.subject,
        recipients: msg.recipients,
        sentAt: msg.sentAt,
      }),
    });
    if (!res.ok) return { ok: false, error: `server ${res.status}` };
    const data = (await res.json()) as { id: string; pixelUrl: string };
    return { ok: true, id: data.id, pixelUrl: data.pixelUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}

async function getState(): Promise<PingSettingsResult> {
  const { baseUrl, token } = await getSettings();
  const { trackingEnabled } = await getLocal();
  return {
    configured: !!normalizeBaseUrl(baseUrl) && !!token,
    trackingEnabled,
  };
}

/** Poll the server, diff open counts, and raise a desktop notification per new open. */
async function pollOpens(): Promise<void> {
  const { baseUrl, token } = await getSettings();
  const base = normalizeBaseUrl(baseUrl);
  if (!base || !token) return;

  let trackers: Array<{
    id: string;
    subject: string;
    recipients: string[];
    openCount: number;
  }>;
  try {
    const res = await fetch(`${base}/api/trackers?limit=200`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    trackers = (await res.json()).trackers;
  } catch {
    return;
  }

  const { openSnapshot } = await getLocal();
  const next: Record<string, number> = {};
  let firstRun = Object.keys(openSnapshot).length === 0;

  for (const t of trackers) {
    next[t.id] = t.openCount;
    const prev = openSnapshot[t.id] ?? 0;
    if (!firstRun && t.openCount > prev) {
      const who = t.recipients[0] ?? "Someone";
      chrome.notifications.create(`mt-${t.id}-${t.openCount}`, {
        type: "basic",
        iconUrl: "icons/128.png",
        title: `${who} opened "${t.subject || "(no subject)"}"`,
        message:
          t.openCount === 1 ? "First open · just now" : `Opened ${t.openCount}× · just now`,
        priority: 2,
      });
    }
  }
  await setLocal({ openSnapshot: next });
}
