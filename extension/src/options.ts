import {
  getLocal,
  getSettings,
  normalizeBaseUrl,
  setLocal,
  setSettings,
} from "./shared.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const baseUrlEl = $<HTMLInputElement>("baseUrl");
const tokenEl = $<HTMLInputElement>("token");
const trackingEl = $<HTMLInputElement>("trackingEnabled");
const statusEl = $<HTMLDivElement>("status");

void (async function load() {
  const s = await getSettings();
  const local = await getLocal();
  baseUrlEl.value = s.baseUrl;
  tokenEl.value = s.token;
  trackingEl.checked = local.trackingEnabled;
})();

function setStatus(text: string, cls: "" | "ok" | "err"): void {
  statusEl.textContent = text;
  statusEl.className = cls;
}

async function requestHostPermission(base: string): Promise<boolean> {
  try {
    const origin = new URL(base).origin + "/*";
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

$("save").addEventListener("click", async () => {
  const baseUrl = normalizeBaseUrl(baseUrlEl.value);
  const token = tokenEl.value.trim();
  if (!baseUrl || !token) {
    setStatus("Base URL and token are both required.", "err");
    return;
  }
  const granted = await requestHostPermission(baseUrl);
  if (!granted) {
    setStatus("Host permission for that URL was denied.", "err");
    return;
  }
  await setSettings({ baseUrl, token });
  await setLocal({ trackingEnabled: trackingEl.checked });
  setStatus("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  const baseUrl = normalizeBaseUrl(baseUrlEl.value);
  const token = tokenEl.value.trim();
  if (!baseUrl || !token) {
    setStatus("Enter a base URL and token first.", "err");
    return;
  }
  await requestHostPermission(baseUrl);
  setStatus("Testing…", "");
  try {
    const res = await fetch(`${baseUrl}/api/trackers?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) setStatus("Connected. Server and token look good.", "ok");
    else if (res.status === 401) setStatus("Reached the server, but the token was rejected.", "err");
    else setStatus(`Server responded ${res.status}.`, "err");
  } catch (err) {
    setStatus(`Could not reach the server: ${err instanceof Error ? err.message : "error"}`, "err");
  }
});
