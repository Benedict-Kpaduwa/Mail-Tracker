# Mail Tracker

Mailtrack-style open tracking for Gmail. Three pieces:

| Piece | What it does |
| --- | --- |
| **Server** (`src/server`) | Serves the tracking pixel, logs opens, exposes an API + SSE stream, sends the optional email digest. SQLite storage. |
| **Dashboard** (`src/dashboard`) | Web page listing tracked emails with open counts, timestamps, device/client, and live desktop notifications. |
| **Chrome extension** (`extension`) | Injects the tracking pixel into Gmail's compose window right before you hit Send, and raises a desktop notification when an email is opened. |

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

## Deployment (later)

`Dockerfile` builds the server + dashboard and runs `dist/server/index.js`.

```bash
docker build -t mail-tracker .
docker run -p 8787:8787 --env-file .env -v mailtrack-data:/app/data mail-tracker
```

On Fly.io / Railway / Render: set the env vars, mount a volume at `/app/data`
(or point `DB_PATH` at one), and set `BASE_URL` to the public HTTPS URL. Then
update the extension's options to that URL.

## Project layout

```
src/server/        Hono app: pixel route, tracker API, SSE, digest, SQLite
src/dashboard/     static SPA (esbuild -> dist/dashboard)
extension/src/     MV3 extension (esbuild -> extension/dist)
scripts/           init (token/.env), tunnel helper, dashboard build
```

## npm scripts

| script | action |
| --- | --- |
| `pnpm run init` | generate `.env` + `MAILTRACK_TOKEN`, create `data/` |
| `pnpm run dev` | build dashboard, then run server with `tsx watch` |
| `pnpm run build` | build server + dashboard + extension |
| `pnpm run build:server` / `:dashboard` / `:extension` | individual builds |
| `pnpm start` | run the compiled server (`dist/server/index.js`) |
| `pnpm run tunnel` | start a `cloudflared`/`ngrok` tunnel to the local server |
