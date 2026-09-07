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
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let token = localStorage.getItem(TOKEN_KEY) ?? "";
let trackers: Tracker[] = [];
let es: EventSource | null = null;

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
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
const fmtAbs = (ts: number) => new Date(ts).toLocaleString();

function badge(t: Tracker): string {
  if (t.ignored) return `<span class="badge ignored">ignored</span>`;
  if (t.openCount === 0) return `<span class="badge unopened">unopened</span>`;
  if (t.openCount === 1) return `<span class="badge opened">opened</span>`;
  return `<span class="badge reopened">opened ×${t.openCount}</span>`;
}

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

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
  const tbody = $("rows");
  tbody.innerHTML = list
    .map(
      (t) => `<tr data-id="${t.id}">
        <td>${badge(t)}</td>
        <td class="subject">${esc(t.subject || "(no subject)")}</td>
        <td class="recips">${esc(t.recipients.join(", ") || "—")}</td>
        <td>${esc(fmtRel(t.sentAt))}</td>
        <td class="num">${t.openCount}</td>
        <td>${esc(fmtRel(t.lastOpenAt))}</td>
        <td class="num"><button class="del" data-del="${t.id}" title="Delete this tracked email">✕</button></td>
      </tr>`,
    )
    .join("");
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
  $("detail").hidden = true;
  $("gateErr").hidden = !err;
}
function showApp(): void {
  $("gate").hidden = true;
  $("app").hidden = false;
}

/* ---- live stream ---- */
function connectStream(): void {
  es?.close();
  es = new EventSource(`/api/events/stream?token=${encodeURIComponent(token)}`);
  const conn = $("conn");
  es.addEventListener("ready", () => {
    conn.textContent = "live";
    conn.classList.add("live");
  });
  es.addEventListener("open", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as {
      trackerId: string;
      subject: string;
      recipients: string[];
      client: string | null;
      openCount: number;
    };
    onOpenEvent(e);
  });
  es.onerror = () => {
    conn.textContent = "reconnecting…";
    conn.classList.remove("live");
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
    const tr = document.querySelector<HTMLElement>(`tr[data-id="${e.trackerId}"]`);
    tr?.classList.add("row-flash");
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
    tag: e.subject,
  });
}

/* ---- detail drawer ---- */
let detailId: string | null = null;
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
    `${openCount} open${openCount === 1 ? "" : "s"}` +
    ` · ${data.hits.length} raw hit${data.hits.length === 1 ? "" : "s"}` +
    (firstOpenAt ? ` · first open ${esc(fmtAbs(firstOpenAt))}` : "");
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
          `<li><span class="when">${esc(fmtAbs(h.ts))}</span>
           ${h.counted ? "✓ counted" : "· ignored"}
           <div class="sub">${esc(h.client ?? "?")} · ${esc(h.device ?? "?")} · ${esc(h.ip ?? "no ip")}</div></li>`,
      )
      .join("") || `<li class="sub">No hits yet.</li>`;

  $("detail").hidden = false;
}

/* ---- wiring ---- */
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
    if (!confirm("Delete this tracked email and all its open records?")) return;
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
  await Promise.all(
    trackers.map((t) => api(`/api/trackers/${t.id}`, { method: "DELETE" })),
  );
  trackers = [];
  render();
});
$("dClose").addEventListener("click", () => {
  $("detail").hidden = true;
  detailId = null;
});
$("dIgnore").addEventListener("change", async (e) => {
  if (!detailId) return;
  const ignored = (e.target as HTMLInputElement).checked;
  await api(`/api/trackers/${detailId}`, {
    method: "PATCH",
    body: JSON.stringify({ ignored }),
  });
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

/* ---- boot ---- */
setInterval(render, 60_000); // keep relative times fresh
if (token) {
  syncNotifyBtn();
  connectStream();
  void load();
} else {
  showGate(false);
}
