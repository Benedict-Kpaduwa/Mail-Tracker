# Deploying Mail Tracker on AWS

Runs the app unchanged on one small Linux box: Node process managed by `systemd`,
SQLite file on the disk, **Caddy** in front for automatic HTTPS. Live updates and
the digest keep working (unlike serverless).

`deploy/setup.sh` does everything after you have a box + open ports.

---

## 1. Create the server

### Option A — Lightsail (simplest)

1. AWS console → **Lightsail** → **Create instance**.
2. Platform **Linux/Unix**, blueprint **OS Only → Ubuntu 22.04 LTS**.
3. Smallest plan is fine ($5/mo, first 3 months free). Create.
4. Instance → **Networking** tab → **IPv4 Firewall** → add a rule:
   **HTTPS / TCP / 443**. (HTTP 80 and SSH 22 are already open.)
5. **Networking** → **Attach static IP** → attach one (free while attached). Note it.

### Option B — EC2 (free for 12 months)

1. EC2 → **Launch instance** → **Ubuntu Server 22.04 LTS**, type **t3.micro**
   (or **t4g.micro**) — both are Free Tier eligible.
2. Create/download a key pair.
3. Security group inbound rules:
   - SSH / TCP / 22 / **My IP**
   - HTTP / TCP / 80 / Anywhere
   - HTTPS / TCP / 443 / Anywhere
4. Launch. Then **Elastic IPs** → allocate → associate with the instance. Note it.

---

## 2. Point a name at it (optional but recommended)

Gmail's image proxy and the PWA need real HTTPS, so you need a hostname —
`https://<ip>` won't work.

- **Have a domain?** Add a DNS **A record** → your static IP
  (e.g. `tracker.yourdomain.com`).
- **No domain?** Two free choices:
  - **Nothing to do:** `setup.sh` will use `<your-ip-with-dashes>.sslip.io`,
    which resolves to your IP automatically. Good enough to start.
  - **DuckDNS** (nicer name, free): create a subdomain at
    <https://www.duckdns.org>, set it to your static IP, use e.g.
    `yourname.duckdns.org`.

---

## 3. Run the setup script

SSH in (Lightsail has a browser SSH button; EC2: `ssh -i key.pem ubuntu@<ip>`):

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <your-repo-url> mail-tracker
cd mail-tracker

# no hostname arg  -> uses <ip>.sslip.io
sudo bash deploy/setup.sh

# or with your own name:
sudo bash deploy/setup.sh tracker.yourdomain.com
```

It installs Node + pnpm + Caddy, builds, generates `MAILTRACK_TOKEN`, starts the
`mail-tracker` service, configures Caddy, and adds an hourly DB backup. At the end
it prints your URL and token.

The **first** HTTPS request takes ~30s while Caddy fetches a certificate.

---

## 4. Point the clients at it

- **Dashboard:** open `https://<your-host>/` , paste the token. On your phone:
  `https://<your-host>/?token=<MAILTRACK_TOKEN>` then Add to Home Screen.
- **Chrome extension:** Options page → set **Server base URL** to
  `https://<your-host>` and the token → Save → Test connection.

You can stop the `cloudflared` tunnel now — it's no longer needed.

---

## CI/CD (GitHub Actions)

`.github/workflows/ci.yml` runs on every push/PR: **typecheck → test → build →
boot smoke-test**. On push to `main` it then **deploys**: rsyncs the repo to the
box and runs `sudo SKIP_GIT=1 bash deploy/update.sh` (rebuild + restart), so the
box needs no git credentials.

Do the **first** deploy manually with `deploy/setup.sh` (above). After that,
GitHub Actions handles updates.

### Secrets (repo → Settings → Secrets and variables → Actions)

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_HOST` | instance public IP or hostname |
| `DEPLOY_SSH_KEY` | **private** key that can SSH in (contents of the `.pem`, or a dedicated deploy key) |
| `DEPLOY_SSH_USER` | *(optional)* SSH user, default `ubuntu` |
| `DEPLOY_PATH` | *(optional)* repo path on the box relative to home, default `mail-tracker` |

The SSH user needs passwordless `sudo` (the default `ubuntu` user on Ubuntu
images already has it). To create a dedicated key instead of reusing your `.pem`:

```bash
ssh-keygen -t ed25519 -f deploy_key -N ""
ssh-copy-id -i deploy_key.pub ubuntu@<host>   # or append deploy_key.pub to ~/.ssh/authorized_keys
# put the contents of `deploy_key` (the private one) into the DEPLOY_SSH_KEY secret
```

The `production` environment on the deploy job lets you add required reviewers or
branch restrictions under **Settings → Environments**.

## Operations

| Task | Command (on the box) |
| --- | --- |
| Status | `systemctl status mail-tracker` |
| Logs | `journalctl -u mail-tracker -f` |
| Restart | `sudo systemctl restart mail-tracker` |
| Deploy new code | `cd ~/mail-tracker && sudo bash deploy/update.sh` |
| Caddy / HTTPS logs | `journalctl -u caddy -f` |
| Backups | `~/mail-tracker/backups/` (hourly, newest 48 kept) |
| Change hostname later | re-run `sudo bash deploy/setup.sh <new-host>` |

### Enable the email digest

Edit `~/mail-tracker/.env` (`DIGEST_ENABLED=true`, `DIGEST_TO`, `SMTP_USER`,
`SMTP_PASS` = a Gmail App Password), then `sudo systemctl restart mail-tracker`.

### Logs & monitoring

Everything runs under systemd, so logs are in the journal.

```bash
# app
journalctl -u mail-tracker -f                 # live tail
journalctl -u mail-tracker -n 100 --no-pager  # last 100 lines
journalctl -u mail-tracker --since "1 hour ago"
journalctl -u mail-tracker -p warning         # warnings + errors only
journalctl -u mail-tracker | grep -i error

# caddy (HTTPS / cert / 502s)
journalctl -u caddy -f
journalctl -u caddy --since today | grep -iE "error|certificate|obtain"
```

The app logs one line per HTTP request (`--> GET /px/<id>.gif 200 1ms`) plus the
startup banner, `[digest] …`, and `[pixel] recordHit failed:` on errors.

Quick liveness check (works from anywhere): `curl -s https://<host>/healthz`.

From your laptop without an interactive session:

```bash
ssh -i <key>.pem ubuntu@<host> 'journalctl -u mail-tracker -n 50 --no-pager'
```

Deploy logs live in GitHub → repo → **Actions** tab.

Journal size is auto-capped. To inspect / tighten:

```bash
journalctl --disk-usage
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\n' | sudo tee /etc/systemd/journald.conf.d/cap.conf
sudo systemctl restart systemd-journald
```

## Cost

- **Lightsail:** flat $5/mo, first 3 months free.
- **EC2 t3.micro / t4g.micro:** free for 12 months (750 h/mo), then ~$6–9/mo.
- EBS/storage and a few GB of egress a month are covered by Free Tier.

## Notes / gotchas

- **Ports 80 + 443 must be open to the world.** 80 is required for Caddy's
  certificate challenge, not just a redirect.
- `sslip.io` shares a Let's Encrypt rate limit across all users. If cert issuance
  fails, switch to DuckDNS or a real domain and re-run `setup.sh`.
- The app binds `127.0.0.1:8787` (set by `setup.sh`); only Caddy is public.
- To move the box: copy `~/mail-tracker/.env` and the newest file from
  `~/mail-tracker/backups/` (restore it to `data/mailtrack.db`) to the new server
  before running `setup.sh`.
