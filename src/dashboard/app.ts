/** Mail Tracker dashboard. Plain TS, bundled to app.js by esbuild. */

type Tracker = {
  id: string;
  subject: string;
  recipients: string[];
  threadId: string | null;
  sentAt: number;
  ignored: boolean;
  openCount: number;
  firstOpenAt: number | null;
  lastOpenAt: number | null;
};

type OpenItem = { id: number; ts: number; ip: string | null; client: string | null; device: string | null };
type HitItem = OpenItem & { ua: string | null; isProxy: boolean; counted: boolean };

const TOKEN_KEY = "mailtrack.token";
const THEME_KEY = "mailtrack.theme";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Allow ?token=… for first load (handy on mobile / as a bookmark), then scrub it
// from the URL so it doesn't linger in history.
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) {
  localStorage.setItem(TOKEN_KEY, urlToken);
  history.replaceState(null, "", location.pathname);
}
let token = localStorage.getItem(TOKEN_KEY) ?? "";
let trackers: Tracker[] = [];
let es: EventSource | null = null;
let deferredPrompt: (Event & { prompt: () => void }) | null = null;

/* ---------- helpers ---------- */
function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

function fmtRel(ts: number | null): string {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
const fmtAbs = (ts: number) => new Date(ts).toLocaleString();

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

const CHECK_ONE =
  '<svg viewBox="0 0 24 16" fill="none" aria-hidden="true"><path d="M3 8.5 L8 13.5 L18 3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHECK_TWO =
  '<svg viewBox="0 0 24 16" fill="none" aria-hidden="true"><path d="M1 8.5 L6 13.5 L16 3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 8.5 L13 13.5 L23 3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function statusCell(t: Tracker): string {
  if (t.ignored)
    return `<span class="status ignored" title="Ignored">${CHECK_TWO}<span class="status-text">ignored</span></span>`;
  if (t.openCount === 0)
    return `<span class="status unopened" title="Sent, not opened yet">${CHECK_ONE}<span class="status-text">sent</span></span>`;
  const badge = t.openCount > 1 ? `<span class="count">×${t.openCount}</span>` : "";
  return `<span class="status opened" title="Opened">${CHECK_TWO}<span class="status-text">opened</span>${badge}</span>`;
}

/* ---------- stats ---------- */
function renderStats(): void {
  const total = trackers.length;
  const opened = trackers.filter((t) => t.openCount > 0 && !t.ignored).length;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const opensToday = trackers.reduce(
    (n, t) => n + (t.lastOpenAt && t.lastOpenAt >= startOfDay.getTime() ? 1 : 0),
    0,
  );
  $("sTotal").textContent = String(total);
  $("sOpened").textContent = String(opened);
  $("sRate").textContent = total ? `${Math.round((opened / total) * 100)}%` : "0%";
  $("sToday").textContent = String(opensToday);
}

/* ---------- table ---------- */
function render(): void {
  const q = $<HTMLInputElement>("filter").value.trim().toLowerCase();
  const list = q
    ? trackers.filter(
        (t) =>
          t.subject.toLowerCase().includes(q) ||
          t.recipients.some((r) => r.toLowerCase().includes(q)),
      )
    : trackers;

  $("empty").hidden = list.length > 0;
  $("rows").innerHTML = list
    .map(
      (t) => `<tr data-id="${t.id}">
        <td data-c="status">${statusCell(t)}</td>
        <td data-c="subject" class="subject-cell">${esc(t.subject || "(no subject)")}</td>
        <td data-c="recips" class="recips">${esc(t.recipients.join(", ") || "—")}</td>
        <td data-c="sent" data-extra="${esc(fmtRel(t.lastOpenAt))}">${esc(fmtRel(t.sentAt))}</td>
        <td data-c="opens" class="num">${t.openCount}</td>
        <td data-c="last">${esc(fmtRel(t.lastOpenAt))}</td>
        <td data-c="del"><button class="del-btn" data-del="${t.id}" title="Delete">✕</button></td>
      </tr>`,
    )
    .join("");
  renderStats();
}

async function load(): Promise<void> {
  const res = await api("/api/trackers");
  if (res.status === 401) return showGate(true);
  if (!res.ok) return;
  trackers = (await res.json()).trackers as Tracker[];
  showApp();
  render();
}

function showGate(err = false): void {
  $("gate").hidden = false;
  $("app").hidden = true;
  closeDrawer();
  $("signout").hidden = true;
  $("gateErr").hidden = !err;
}
function showApp(): void {
  $("gate").hidden = true;
  $("app").hidden = false;
  $("signout").hidden = false;
}

/* ---------- live stream ---------- */
function connectStream(): void {
  es?.close();
  es = new EventSource(`/api/events/stream?token=${encodeURIComponent(token)}`);
  const conn = $("conn");
  const label = conn.querySelector(".pill-label") as HTMLElement;
  es.addEventListener("ready", () => {
    conn.classList.add("live");
    label.textContent = "live";
  });
  es.addEventListener("open", (ev) => onOpenEvent(JSON.parse((ev as MessageEvent).data)));
  es.onerror = () => {
    conn.classList.remove("live");
    label.textContent = "reconnecting";
  };
}

function onOpenEvent(e: {
  trackerId: string;
  subject: string;
  recipients: string[];
  client: string | null;
  openCount: number;
}): void {
  const t = trackers.find((x) => x.id === e.trackerId);
  if (t) {
    t.openCount = e.openCount;
    t.lastOpenAt = Date.now();
    if (!t.firstOpenAt) t.firstOpenAt = t.lastOpenAt;
    trackers = [t, ...trackers.filter((x) => x.id !== t.id)];
    render();
    document.querySelector(`tr[data-id="${e.trackerId}"]`)?.classList.add("row-flash");
  } else {
    void load();
  }
  notify(e);
  if (!$("detail").hidden && detailId === e.trackerId) void openDetail(e.trackerId);
}

function notify(e: { subject: string; recipients: string[]; client: string | null }): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const who = e.recipients[0] ?? "Someone";
  new Notification(`${who} opened "${e.subject || "(no subject)"}"`, {
    body: e.client ? `via ${e.client} · just now` : "just now",
    icon: "/icons/icon-192.png",
    tag: e.subject,
  });
}

/* ---------- detail drawer ---------- */
let detailId: string | null = null;
function closeDrawer(): void {
  $("detail").hidden = true;
  $("scrim").hidden = true;
  detailId = null;
}
async function openDetail(id: string): Promise<void> {
  detailId = id;
  const res = await api(`/api/trackers/${id}`);
  if (!res.ok) return;
  const data = (await res.json()) as {
    tracker: Tracker & { createdAt: number; gmailMessageId: string | null };
    opens: OpenItem[];
    hits: HitItem[];
  };
  const t = data.tracker;
  const openCount = data.opens.length;
  const firstOpenAt = openCount ? data.opens[data.opens.length - 1]!.ts : null;

  $("dSubject").textContent = t.subject || "(no subject)";
  $("dMeta").innerHTML =
    `To ${esc(t.recipients.join(", ") || "—")}<br>` +
    `Sent ${esc(fmtAbs(t.sentAt))}<br>` +
    `<strong>${openCount}</strong> open${openCount === 1 ? "" : "s"} · ${data.hits.length} raw hit${
      data.hits.length === 1 ? "" : "s"
    }` +
    (firstOpenAt ? `<br>First open ${esc(fmtAbs(firstOpenAt))}` : "");
  ($("dIgnore") as HTMLInputElement).checked = t.ignored;

  $("dOpens").innerHTML =
    data.opens
      .map(
        (o) =>
          `<li><span class="when">${esc(fmtAbs(o.ts))}</span> · ${esc(fmtRel(o.ts))}
           <div class="sub">${esc(o.client ?? "unknown")} · ${esc(o.device ?? "?")} · ${esc(o.ip ?? "no ip")}</div></li>`,
      )
      .join("") || `<li class="sub">No counted opens yet.</li>`;

  $("dHits").innerHTML =
    data.hits
      .map(
        (h) =>
          `<li><span class="when">${esc(fmtAbs(h.ts))}</span> ${h.counted ? "✓ counted" : "· not counted"}
           <div class="sub">${esc(h.client ?? "?")} · ${esc(h.device ?? "?")} · ${esc(h.ip ?? "no ip")}</div></li>`,
      )
      .join("") || `<li class="sub">No hits yet.</li>`;

  $("detail").hidden = false;
  $("scrim").hidden = false;
}

/* ---------- theme ---------- */
function applyTheme(mode: "light" | "dark" | null): void {
  if (mode) document.documentElement.setAttribute("data-theme", mode);
  else document.documentElement.removeAttribute("data-theme");
}
applyTheme((localStorage.getItem(THEME_KEY) as "light" | "dark" | null) ?? null);
$("themeBtn").addEventListener("click", () => {
  const cur = localStorage.getItem(THEME_KEY);
  const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const next = cur === "dark" ? "light" : cur === "light" ? "dark" : prefersDark ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

/* ---------- PWA ---------- */
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e as Event & { prompt: () => void };
  $("installBtn").hidden = false;
});
$("installBtn").addEventListener("click", () => {
  deferredPrompt?.prompt();
  deferredPrompt = null;
  $("installBtn").hidden = true;
});

/* ---------- wiring ---------- */
$("gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $<HTMLInputElement>("tokenInput").value.trim();
  const res = await api("/api/trackers");
  if (res.ok) {
    localStorage.setItem(TOKEN_KEY, token);
    connectStream();
    await load();
  } else {
    showGate(true);
  }
});

$("signout").addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  es?.close();
  token = "";
  showGate(false);
});

$("refresh").addEventListener("click", () => void load());
$("filter").addEventListener("input", render);

$("rows").addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;
  const delId = target.dataset.del;
  if (delId) {
    e.stopPropagation();
    if (!confirm("Delete this tracked email and its open records?")) return;
    await api(`/api/trackers/${delId}`, { method: "DELETE" });
    trackers = trackers.filter((t) => t.id !== delId);
    render();
    return;
  }
  const tr = target.closest("tr");
  if (tr?.dataset.id) void openDetail(tr.dataset.id);
});

$("clearAll").addEventListener("click", async () => {
  if (!trackers.length) return;
  if (!confirm(`Delete ALL ${trackers.length} tracked emails? This cannot be undone.`)) return;
  await Promise.all(trackers.map((t) => api(`/api/trackers/${t.id}`, { method: "DELETE" })));
  trackers = [];
  render();
});

$("dClose").addEventListener("click", closeDrawer);
$("scrim").addEventListener("click", closeDrawer);
addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

$("dIgnore").addEventListener("change", async (e) => {
  if (!detailId) return;
  const ignored = (e.target as HTMLInputElement).checked;
  await api(`/api/trackers/${detailId}`, { method: "PATCH", body: JSON.stringify({ ignored }) });
  await load();
  await openDetail(detailId);
});

const notifyBtn = $("notifyBtn");
function syncNotifyBtn(): void {
  notifyBtn.hidden = !("Notification" in window) || Notification.permission !== "default";
}
notifyBtn.addEventListener("click", async () => {
  await Notification.requestPermission();
  syncNotifyBtn();
});

/* ---------- boot ---------- */
setInterval(render, 60_000);
if (token) {
  syncNotifyBtn();
  connectStream();
  void load();
} else {
  showGate(false);
}
