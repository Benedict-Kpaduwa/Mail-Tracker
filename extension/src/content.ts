/**
 * Runs on mail.google.com. Finds Gmail compose windows, adds a "Track" toggle,
 * and — when tracking is on — drops a tracking pixel into the message body the
 * moment Send is triggered. The send is never blocked: the pixel id is generated
 * here so the <img> can be inserted synchronously, and the server is told about
 * it in the background (fire-and-forget, idempotent on the id).
 *
 * Gmail's DOM is undocumented and changes often; selectors here are defensive.
 */
import {
  getSettings,
  normalizeBaseUrl,
  type ActivityItem,
  type CreateTrackerResult,
  type GetActivityResult,
  type GetTrackersResult,
  type LookupStatusResult,
  type Settings,
  type TrackerSummary,
} from "./shared.js";

const SEND_SELECTOR =
  '[role="button"][data-tooltip^="Send"], [role="button"][aria-label^="Send"]';
const BODY_SELECTOR =
  'div[aria-label][contenteditable="true"][role="textbox"], div[g_editable="true"][role="textbox"]';
const SUBJECT_SELECTOR = 'input[name="subjectbox"]';

const composeState = new WeakMap<HTMLElement, { track: boolean }>();
let settings: Settings = { baseUrl: "", token: "" };
let trackingDefault = true;

void init();

async function init(): Promise<void> {
  settings = await getSettings();
  try {
    const st = (await chrome.runtime.sendMessage({ type: "getState" })) as {
      trackingEnabled: boolean;
    };
    trackingDefault = st?.trackingEnabled ?? true;
  } catch {
    /* background asleep; default on */
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      if (changes.baseUrl) settings.baseUrl = changes.baseUrl.newValue ?? "";
      if (changes.token) settings.token = changes.token.newValue ?? "";
    }
    if (area === "local" && changes.trackingEnabled) {
      trackingDefault = changes.trackingEnabled.newValue ?? true;
    }
  });

  let t: ReturnType<typeof setTimeout> | undefined;
  const mo = new MutationObserver(() => {
    scan();
    clearTimeout(t);
    t = setTimeout(() => {
      annotateOpenThread();
      annotateListRows();
    }, 350);
  });
  mo.observe(document.body, { childList: true, subtree: true });
  scan();
  annotateOpenThread();
  mountActivityPanel();

  // Capture phase so we run before Gmail's own handler, but we do NOT
  // preventDefault — the send proceeds normally right after we inject.
  document.addEventListener("click", onSendTrigger, true);
  document.addEventListener("keydown", onKeyTrigger, true);
}

function scan(): void {
  for (const send of document.querySelectorAll<HTMLElement>(SEND_SELECTOR)) {
    const root = ascendToCompose(send);
    if (!root || root.dataset.mtWired === "1") continue;
    root.dataset.mtWired = "1";
    composeState.set(root, { track: trackingDefault });
    injectToggle(root, send);
  }
}

function ascendToCompose(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node) {
    if (node.getAttribute("role") === "dialog") return node;
    node = node.parentElement;
  }
  // Inline replies have no dialog; fall back to a stable-ish container.
  return el.closest<HTMLElement>("table.aoP, .aoI, .iN, form") ?? el.parentElement;
}

function injectToggle(root: HTMLElement, send: HTMLElement): void {
  if (root.querySelector(".mt-chip")) return;
  const chip = document.createElement("span");
  chip.className = "mt-chip";
  chip.style.cssText =
    "display:inline-flex;align-items:center;gap:6px;margin-left:12px;padding:5px 11px;" +
    "border-radius:14px;font:12px/1 system-ui,-apple-system,sans-serif;cursor:pointer;" +
    "user-select:none;vertical-align:middle;border:1px solid transparent;white-space:nowrap;";
  const st = composeState.get(root)!;
  paintChip(chip, st.track);
  chip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    st.track = !st.track;
    paintChip(chip, st.track);
  });
  (send.parentElement ?? send).appendChild(chip);
}

function paintChip(chip: HTMLElement, on: boolean): void {
  chip.textContent = on ? "✓ Tracking on" : "Tracking off";
  chip.style.background = on ? "#dcfce7" : "#f1f3f4";
  chip.style.color = on ? "#166534" : "#5f6368";
  chip.style.borderColor = on ? "#86efac" : "#dadce0";
}

/* ---------- send detection (non-blocking) ---------- */

function onSendTrigger(e: MouseEvent): void {
  const send = (e.target as HTMLElement | null)?.closest<HTMLElement>(SEND_SELECTOR);
  if (!send) return;
  const root = ascendToCompose(send);
  if (root) maybeInject(root);
}

function onKeyTrigger(e: KeyboardEvent): void {
  if (!((e.metaKey || e.ctrlKey) && e.key === "Enter")) return;
  const root = ascendToCompose(e.target as HTMLElement);
  if (root) maybeInject(root);
}

function maybeInject(root: HTMLElement): void {
  const st = composeState.get(root);
  if (!st || !st.track) return;

  const body = root.querySelector<HTMLElement>(BODY_SELECTOR);
  if (!body || body.querySelector('img[data-mt="1"]')) return;

  const base = normalizeBaseUrl(settings.baseUrl);
  if (!base) {
    toast("Mail Tracker isn't configured — opening its options.", "#b45309");
    void chrome.runtime.openOptionsPage?.();
    return;
  }

  const id = genId();
  const img = document.createElement("img");
  img.src = `${base}/px/${id}.gif`;
  img.width = 1;
  img.height = 1;
  img.alt = "";
  img.setAttribute("data-mt", "1");
  img.style.cssText = "width:1px;height:1px;opacity:0;border:0;outline:0";
  body.appendChild(img);

  const subject = readSubject(root);
  const recipients = readRecipients(root);

  Promise.resolve(
    chrome.runtime.sendMessage({
      type: "createTracker",
      id,
      subject,
      recipients,
      sentAt: Date.now(),
    }) as Promise<CreateTrackerResult>,
  )
    .then((r) => {
      if (r?.ok) toast(`Tracking "${subject || "(no subject)"}"`, "#166534");
      else toast(`Sent, but tracking failed: ${r?.error ?? "no response"}`, "#b45309");
    })
    .catch(() => toast("Sent, but tracking failed (extension error).", "#b45309"));
}

function genId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return "mt" + Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

function readSubject(root: HTMLElement): string {
  const input = root.querySelector<HTMLInputElement>(SUBJECT_SELECTOR);
  if (input?.value) return input.value.trim();
  return document.querySelector<HTMLElement>("h2.hP")?.textContent?.trim() ?? "";
}

function readRecipients(root: HTMLElement): string[] {
  const emails = new Set<string>();
  root.querySelectorAll<HTMLElement>("[email]").forEach((el) => {
    const v = el.getAttribute("email");
    if (v && v.includes("@")) emails.add(v.toLowerCase());
  });
  root
    .querySelectorAll<HTMLInputElement>(
      'input[type="text"][name="to"], textarea[name="to"], input[peoplekit-id]',
    )
    .forEach((el) => {
      (el.value ?? "")
        .split(/[,;\s]+/)
        .filter((s) => s.includes("@"))
        .forEach((s) => emails.add(s.toLowerCase()));
    });
  return [...emails];
}

function toast(text: string, color: string): void {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText =
    "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;" +
    `background:#fff;color:${color};border:1px solid ${color};border-radius:8px;` +
    "padding:8px 14px;font:13px system-ui,-apple-system,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.15)";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ---------- Mailtrack-style checkmark on opened messages ---------- */

const PIXEL_ID_RE = /\/px\/(mt[A-Za-z0-9_-]{6,40})\.gif/;
const statusCache = new Map<string, { at: number; openCount: number; ignored: boolean }>();
const STATUS_TTL = 15_000;

function annotateOpenThread(): void {
  const subj = document.querySelector<HTMLElement>("h2.hP");
  if (!subj) return;
  const main = document.querySelector<HTMLElement>('[role="main"]');
  if (!main) return;

  const match = main.innerHTML.match(PIXEL_ID_RE);
  const id = match?.[1];
  if (!id) {
    subj.parentElement?.querySelector(".mt-thread-status")?.remove();
    delete subj.dataset.mtId;
    return;
  }

  const hasBadge = !!subj.parentElement?.querySelector(".mt-thread-status");
  const cached = statusCache.get(id);
  if (subj.dataset.mtId === id && hasBadge && cached && Date.now() - cached.at < STATUS_TTL) {
    return;
  }
  subj.dataset.mtId = id;
  void refreshThreadStatus(subj, id);
}

async function refreshThreadStatus(subj: HTMLElement, id: string): Promise<void> {
  let st = statusCache.get(id);
  if (!st || Date.now() - st.at >= STATUS_TTL) {
    try {
      const r = (await chrome.runtime.sendMessage({
        type: "lookupStatus",
        id,
      })) as LookupStatusResult;
      if (!r?.ok) return;
      st = { at: Date.now(), openCount: r.openCount, ignored: r.ignored };
      statusCache.set(id, st);
    } catch {
      return;
    }
  }
  if (subj.dataset.mtId !== id) return; // navigated away
  renderThreadBadge(subj, st);
}

function renderThreadBadge(
  subj: HTMLElement,
  st: { openCount: number; ignored: boolean },
): void {
  const host = subj.parentElement ?? subj;
  host.querySelector(".mt-thread-status")?.remove();

  const opened = st.openCount > 0 && !st.ignored;
  const badge = document.createElement("span");
  badge.className = "mt-thread-status";
  badge.style.cssText =
    "display:inline-flex;align-items:center;gap:5px;margin-left:10px;padding:2px 9px;" +
    "border-radius:12px;font:600 12px/1 system-ui,-apple-system,sans-serif;vertical-align:middle;" +
    (opened
      ? "background:#dcfce7;color:#166534;"
      : st.ignored
        ? "background:#f1f3f4;color:#5f6368;"
        : "background:#eef2ff;color:#4f46e5;");
  badge.innerHTML =
    (opened || st.ignored ? doubleCheckSvg() : singleCheckSvg()) +
    `<span>${
      st.ignored
        ? "Ignored"
        : opened
          ? st.openCount > 1
            ? `Opened ×${st.openCount}`
            : "Opened"
          : "Sent"
    }</span>`;
  subj.after(badge);
}

function singleCheckSvg(w = 16): string {
  return `<svg width="${w}" height="${Math.round((w * 11) / 16)}" viewBox="0 0 24 16" fill="none"><path d="M3 8.5 L8 13.5 L18 3" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function doubleCheckSvg(w = 18): string {
  return `<svg width="${w}" height="${Math.round((w * 11) / 18)}" viewBox="0 0 24 16" fill="none"><path d="M1 8.5 L6 13.5 L16 3" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 8.5 L13 13.5 L23 3" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function relTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ---------- shared tracker list cache ---------- */

let trackerCache: { at: number; list: TrackerSummary[] } | null = null;
const TRACKER_TTL = 45_000;

async function getTrackerList(force = false): Promise<TrackerSummary[]> {
  if (!force && trackerCache && Date.now() - trackerCache.at < TRACKER_TTL) {
    return trackerCache.list;
  }
  try {
    const r = (await chrome.runtime.sendMessage({ type: "getTrackers" })) as GetTrackersResult;
    if (!r?.ok) return trackerCache?.list ?? [];
    trackerCache = { at: Date.now(), list: r.trackers };
    return r.trackers;
  } catch {
    return trackerCache?.list ?? [];
  }
}

/* ---------- Sent-list row markers + hover tooltip ---------- */

const normSubject = (s: string) =>
  s
    .toLowerCase()
    .replace(/^\s*(re|fwd|fw)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

function annotateListRows(): void {
  const rows = document.querySelectorAll<HTMLElement>("tr.zA");
  if (!rows.length) return;

  void getTrackerList().then((list) => {
    if (!list.length) return;
    const bySubject = new Map<string, TrackerSummary[]>();
    for (const t of list) {
      if (t.ignored) continue;
      const k = normSubject(t.subject);
      let arr = bySubject.get(k);
      if (!arr) bySubject.set(k, (arr = []));
      arr.push(t);
    }

    for (const row of rows) {
      const subjEl = row.querySelector<HTMLElement>("span.bog");
      const subject = (subjEl?.textContent ?? "").trim();
      if (!subjEl || !subject) continue;
      if (row.dataset.mtRowSubj === subject) continue; // same content, already handled
      row.dataset.mtRowSubj = subject;
      row.querySelector(".mt-row-mark")?.remove();

      const candidates = bySubject.get(normSubject(subject));
      if (!candidates || !candidates.length) continue;

      const rowEmail = row
        .querySelector<HTMLElement>("[email]")
        ?.getAttribute("email")
        ?.toLowerCase();
      const narrowed = rowEmail
        ? candidates.filter((t) => t.recipients.some((r) => r.toLowerCase() === rowEmail))
        : candidates;
      const pool = narrowed.length ? narrowed : candidates;
      const t = pool.reduce((a, b) => (b.sentAt > a.sentAt ? b : a));

      const host = subjEl.closest<HTMLElement>(".y6") ?? subjEl.parentElement;
      host?.insertBefore(buildRowMark(t), host.firstChild);
    }
  });
}

function buildRowMark(t: TrackerSummary): HTMLElement {
  const opened = t.openCount > 0;
  const mark = document.createElement("span");
  mark.className = "mt-row-mark";
  mark.style.cssText =
    "display:inline-flex;align-items:center;margin-right:6px;vertical-align:middle;cursor:default;" +
    (opened ? "color:#16a34a;" : "color:#9aa0a6;");
  mark.innerHTML = opened ? doubleCheckSvg(16) : singleCheckSvg(14);

  const who = t.recipients[0] ?? "The recipient";
  const label = opened
    ? `${who} opened your email · ${relTime(t.lastOpenAt ?? t.sentAt)}` +
      (t.openCount > 1 ? ` (${t.openCount}×)` : "")
    : `${who} hasn't opened your email yet`;

  mark.addEventListener("mouseenter", () => showTooltip(mark, label));
  mark.addEventListener("mouseleave", hideTooltip);
  return mark;
}

let tooltipEl: HTMLElement | null = null;
function showTooltip(anchor: HTMLElement, text: string): void {
  hideTooltip();
  const r = anchor.getBoundingClientRect();
  const tip = document.createElement("div");
  tip.className = "mt-tooltip";
  tip.textContent = text;
  tip.style.cssText =
    "position:fixed;z-index:100000;max-width:280px;background:#202124;color:#fff;" +
    "font:12px/1.4 system-ui,-apple-system,sans-serif;padding:6px 10px;border-radius:6px;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;";
  tip.style.left = `${Math.min(r.left, window.innerWidth - 300)}px`;
  tip.style.top = `${r.bottom + 6}px`;
  document.body.appendChild(tip);
  tooltipEl = tip;
}
function hideTooltip(): void {
  tooltipEl?.remove();
  tooltipEl = null;
}

/* ---------- in-Gmail activity panel ---------- */

let activityTimer: ReturnType<typeof setInterval> | undefined;
let panelOpen = false;

function mountActivityPanel(): void {
  if (document.getElementById("mt-launcher")) return;

  const launcher = document.createElement("button");
  launcher.id = "mt-launcher";
  launcher.title = "Mail Tracker — recent opens";
  launcher.innerHTML = doubleCheckSvg(22);
  launcher.style.cssText =
    "position:fixed;right:18px;bottom:18px;z-index:99998;width:46px;height:46px;border-radius:50%;" +
    "border:none;background:#4f46e5;color:#fff;display:flex;align-items:center;justify-content:center;" +
    "cursor:pointer;box-shadow:0 6px 20px rgba(79,70,229,.45);transition:background .15s,transform .15s;";

  const panel = document.createElement("div");
  panel.id = "mt-panel";
  // Starts closed. Toggle switches display between "none" and "flex".
  panel.style.cssText =
    "position:fixed;right:18px;bottom:74px;z-index:99998;width:320px;max-height:60vh;display:none;" +
    "flex-direction:column;background:#fff;color:#202124;border:1px solid #e0e0e0;border-radius:12px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.22);font:13px/1.5 system-ui,-apple-system,sans-serif;overflow:hidden;";
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #eee">
      <strong style="font-size:13px">Mail Tracker</strong>
      <button id="mt-panel-dash" style="font:inherit;font-weight:600;border:1px solid #dadce0;background:#fff;color:#202124;border-radius:7px;padding:5px 10px;cursor:pointer">Dashboard ↗</button>
    </div>
    <div id="mt-panel-body" style="padding:6px 0;overflow-y:auto;flex:1"></div>`;

  document.body.append(launcher, panel);

  const setOpen = (open: boolean) => {
    panelOpen = open;
    panel.style.display = open ? "flex" : "none";
    launcher.style.background = open ? "#3730a3" : "#4f46e5";
    launcher.style.transform = open ? "scale(0.94)" : "scale(1)";
    if (open) {
      void refreshActivity();
      activityTimer = setInterval(() => void refreshActivity(), 30_000);
    } else if (activityTimer) {
      clearInterval(activityTimer);
      activityTimer = undefined;
    }
  };

  launcher.addEventListener("click", () => setOpen(!panelOpen));

  // Click outside the panel (but not on the launcher) closes it.
  document.addEventListener("click", (e) => {
    if (!panelOpen) return;
    const target = e.target as Node;
    if (!panel.contains(target) && !launcher.contains(target)) setOpen(false);
  });

  panel.querySelector("#mt-panel-dash")!.addEventListener("click", () => {
    const base = normalizeBaseUrl(settings.baseUrl);
    if (base) window.open(`${base}/${settings.token ? `?token=${encodeURIComponent(settings.token)}` : ""}`, "_blank");
    else void chrome.runtime.openOptionsPage?.();
  });
}

async function refreshActivity(): Promise<void> {
  const body = document.getElementById("mt-panel-body");
  if (!body) return;
  let res: GetActivityResult;
  try {
    res = (await chrome.runtime.sendMessage({ type: "getActivity" })) as GetActivityResult;
  } catch {
    return;
  }
  if (!res?.ok) {
    body.innerHTML = `<div style="padding:16px 14px;color:#5f6368">Open the extension options to connect.</div>`;
    return;
  }
  const items: ActivityItem[] = res.activity;
  if (!items.length) {
    body.innerHTML = `<div style="padding:16px 14px;color:#5f6368">No opens yet. Send a tracked email from Gmail.</div>`;
    return;
  }
  body.innerHTML = items
    .map((a) => {
      const who = esc(a.recipient ?? "Someone");
      const subj = esc(a.subject || "(no subject)");
      return `<div style="padding:9px 14px;border-bottom:1px solid #f1f3f4">
        <div><span style="color:#16a34a;vertical-align:middle;margin-right:5px">${doubleCheckSvg(15)}</span><strong>${who}</strong> opened your email</div>
        <div style="color:#5f6368;font-size:12px;margin-top:1px">${subj} · ${relTime(a.ts)}</div>
      </div>`;
    })
    .join("");
}

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
