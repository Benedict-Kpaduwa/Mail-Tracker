# Mail Tracker

Mailtrack-style open tracking for Gmail. Three pieces:

| Piece | What it does |
| --- | --- |
| **Server** (`src/server`) | Serves the tracking pixel, logs opens, exposes an API + SSE stream, sends the optional email digest. SQLite storage. |
| **Dashboard** (`src/dashboard`) | Installable PWA listing tracked emails with Mailtrack-style ✓/✓✓ status, stats, live updates, and desktop notifications. Light/dark, phone-friendly. |
| **Chrome extension** (`extension`) | Injects the tracking pixel into Gmail's compose window right before you hit Send, shows a ✓/✓✓ badge on opened messages in Gmail, and raises a desktop notification when an email is opened. |

## Dashboard as a phone app (PWA)

The dashboard is a Progressive Web App — installable, offline-capable shell, its
own icon.

- **Reach it from your phone:** open the server's public URL (your tunnel or
  deploy URL) in the phone browser. Tip: `https://<host>/?token=<MAILTRACK_TOKEN>`
  signs you in on first load, then strips the token from the URL.
- **iOS Safari:** Share → *Add to Home Screen*.
- **Android Chrome / desktop Chrome:** use the *Install* prompt (the ⬇︎ button in
  the header, or the browser's install icon).
- The service worker (`/sw.js`) caches only the app shell; the API and SSE stream
  are always fetched live, so it never shows stale open data.
- A quick `trycloudflare.com` tunnel URL changes on every restart — you'd
  reinstall/re-point. Deploy for a stable install.

## How it works

Each tracked email gets a unique 1×1 transparent GIF embedded in the body
(`https://<your-server>/px/<id>.gif`). When the recipient's mail client renders
the message it fetches that image; the server records the fetch as an **open**
(time, IP, `User-Agent` → client/device).

### Open-detection heuristics

Raw pixel fetches are stored as `hits`; only some become counted `opens`:

- fetches within `SELF_OPEN_WINDOW_SEC` (default 15s) of send are dropped — that
  is usually your own Gmail proxying the image as the sent message renders for you;
- repeated fetches inside `DEDUPE_WINDOW_SEC` (default 120s) collapse into one open;
- obvious link-scanners / scripts are dropped;
- a per-email **Ignore** toggle suppresses counting entirely.

### Known limitations (inherent to pixel tracking)

- **Self-opens** can't be fully eliminated — if you re-open your own sent mail
  after the self-open window, it counts. Use the per-email Ignore toggle.
- **Images-off** recipients never trigger the pixel; they show as unopened.
- Some providers **pre-fetch** images on delivery (a false "open") or **cache**
  the pixel (missed re-opens).
- Apple Mail Privacy Protection loads images through Apple's proxy, so opens
  there are real but time/location is Apple's relay, not the reader.

Only use this on your own correspondence.

## Prerequisites

- Node 20+ (developed on Node 24). `better-sqlite3` compiles a native addon on
  install, so you need a C toolchain (Xcode CLT on macOS: `xcode-select --install`).
- `pnpm` (the repo is set up for it). `pnpm install` is configured to build the
  two native/binary deps (`better-sqlite3`, `esbuild`) via
  `pnpm.onlyBuiltDependencies` in `package.json`.
- For real testing: `cloudflared` (`brew install cloudflared`) or `ngrok`.
- For the digest: a Gmail **App Password**
  (<https://myaccount.google.com/apppasswords>).

## Setup

```bash
pnpm install
pnpm run init      # creates .env, generates MAILTRACK_TOKEN, makes data/
pnpm run build     # builds server + dashboard + extension
pnpm run dev       # server on http://localhost:8787 (rebuilds dashboard first)
```

Open <http://localhost:8787>, paste the `MAILTRACK_TOKEN` (printed by `init`, also
in `.env`), and allow notifications.

### Local pixel + heuristics smoke test (no browser)

```bash
BASE=http://localhost:8787
TOKEN=$(grep '^MAILTRACK_TOKEN=' .env | cut -d= -f2)
UA='Mozilla/5.0 (GoogleImageProxy)'

# create a tracker dated 60s ago so it's outside the self-open window
ID=$(curl -s -XPOST $BASE/api/trackers -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"subject\":\"Test\",\"recipients\":[\"a@b.com\"],\"sentAt\":$(( $(date +%s000) - 60000 ))}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

curl -s -A "$UA" $BASE/px/$ID.gif -o /dev/null          # simulate an open
curl -s $BASE/api/trackers/$ID -H "Authorization: Bearer $TOKEN"   # openCount: 1
```

## Real use with Gmail

1. **Expose the server.** In a second terminal:
   ```bash
   pnpm run tunnel        # runs `cloudflared tunnel --url http://localhost:8787`
   ```
   Copy the `https://<random>.trycloudflare.com` URL.
2. **Point the server at it.** Set `BASE_URL=` to that URL in `.env`, restart
   `pnpm run dev`. (The pixel URLs embedded in mail must be publicly reachable.)
3. **Load the extension.** `chrome://extensions` → enable Developer mode →
   *Load unpacked* → select `extension/dist`.
4. **Configure it.** The options page opens on install (or right-click the
   extension → Options). Enter:
   - **Server base URL** = the same tunnel URL
   - **Access token** = `MAILTRACK_TOKEN`
   Click **Save** (grant the host-permission prompt), then **Test connection**.
5. **Send a tracked email.** Compose in Gmail — a green **✓ Tracking on** chip
   appears next to Send. Send to another address you control. Opening that message
   from the other account registers an open on the dashboard within ~1s (SSE) and
   raises a desktop notification (dashboard + extension).

The chip toggles per compose; the default is set on the options page.

## Email digest

In `.env`:

```
DIGEST_ENABLED=true
DIGEST_CRON=0 8 * * *          # 8am daily; server local time
DIGEST_TO=you@example.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=your-16-char-app-password
```

Restart the server. Each run emails a summary of opens since the previous run.

## CI/CD

`.github/workflows/ci.yml`:

- **every push / PR** — `pnpm run typecheck`, `pnpm test` (Node `node:test` suite
  in `test/`), `pnpm run build`, and a boot smoke-test of the built server. The
  built Chrome extension is uploaded as a workflow artifact.
- **push to `main`** — after the checks pass, deploys: rsyncs the repo to the AWS
  box over SSH and runs `sudo SKIP_GIT=1 bash deploy/update.sh` (rebuild +
  `systemctl restart`), then hits `/healthz` to confirm.

Deploy needs repo secrets `DEPLOY_SSH_HOST`, `DEPLOY_SSH_KEY` (and optionally
`DEPLOY_SSH_USER`, `DEPLOY_PATH`) — see [deploy/README.md](deploy/README.md#cicd-github-actions).
Run `deploy/setup.sh` once by hand first; CI only does updates.

Run the same checks locally: `pnpm run typecheck && pnpm test`.

## Deployment

### AWS (one small instance) — recommended, runs the code unchanged

See **[deploy/README.md](deploy/README.md)**. Create an Ubuntu Lightsail/EC2 box,
open ports 80 + 443, then:

```bash
git clone <repo> mail-tracker && cd mail-tracker
sudo bash deploy/setup.sh            # or: sudo bash deploy/setup.sh your-host.com
```

That installs Node + pnpm + Caddy, builds, runs it as a `systemd` service behind
Caddy (automatic HTTPS), and sets up hourly SQLite backups. With no hostname it
uses `<public-ip>.sslip.io`. Update code later with `sudo bash deploy/update.sh`.

### Docker (any host with a persistent volume)

```bash
docker build -t mail-tracker .
docker run -p 8787:8787 --env-file .env -v mailtrack-data:/app/data mail-tracker
```

Set `BASE_URL` to the public HTTPS URL, mount a volume at `/app/data`, and put a
TLS-terminating proxy in front. Then point the dashboard + extension at that URL.

## Project layout

```
src/server/        Hono app: pixel route, tracker API, SSE, digest, SQLite
src/dashboard/     PWA SPA + logo.svg + sw.js (esbuild -> dist/dashboard)
extension/src/     MV3 extension: pixel injection + in-Gmail ✓/✓✓ badge
scripts/           init, tunnel helper, dashboard build, icon rasteriser (sharp)
```

The dashboard build generates `manifest.webmanifest` and PNG icons (from
`src/dashboard/logo.svg` via `sharp`) into `dist/dashboard/icons/`.

## npm scripts

| script | action |
| --- | --- |
| `pnpm run init` | generate `.env` + `MAILTRACK_TOKEN`, create `data/` |
| `pnpm run dev` | build dashboard, then run server with `tsx watch` |
| `pnpm run build` | build server + dashboard + extension |
| `pnpm run build:server` / `:dashboard` / `:extension` | individual builds |
| `pnpm start` | run the compiled server (`dist/server/index.js`) |
| `pnpm run tunnel` | start a `cloudflared`/`ngrok` tunnel to the local server |
