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
  type CreateTrackerResult,
  type Settings,
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

  const mo = new MutationObserver(() => scan());
  mo.observe(document.body, { childList: true, subtree: true });
  scan();

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
