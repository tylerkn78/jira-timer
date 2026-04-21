# Jira Timer

Self-hosted time tracking for Jira tickets. Node.js + Express, single-process, file-backed.

**Version 2.0** is a hardened release with CSRF protection, TLS-only access, persistent sessions, systemd sandboxing, and audit logging. See the **[Upgrade from 1.x](#upgrade-from-1x)** section below if you have a previous version running.

---

## Repository layout

```
jira-timer/
├── server.js                      Backend Node app
├── package.json                   Dependencies
├── package-lock.json              Pinned dep versions (commit this)
├── public/
│   └── index.html                 Frontend SPA
├── deploy/
│   ├── jira-timer.service         Hardened systemd unit
│   ├── nginx-jira-timer.conf      Sample nginx reverse proxy config
│   └── secrets_env.template       Template for /etc/jira-timer/secrets.env
├── .gitignore
└── README.md
```

The `data/` directory (user accounts, tickets, sessions, audit log) is created at runtime on the server and is **not** in the repo. Same with `node_modules/` and any `.env` files.

---

## Publishing this to GitHub (one-time, from your dev machine)

Skip this section if the repo already exists in GitHub.

```bash
cd /path/to/jira-timer
git init
git add .
git commit -m "Initial commit: Jira Timer v2.0.0"
git branch -M main
git remote add origin git@github.com:<your-github-org>/jira-timer.git
git push -u origin main

# Tag the release for clean version pinning on the server
git tag -a v2.0.0 -m "v2.0.0 - Hardened release"
git push origin v2.0.0
```

Going forward, cut a tag for every release (`v2.1.0`, `v2.1.1`, etc.). The server deploys against tags, not `main`, so you control exactly when it updates.

---

## Architecture

```
Browser ──HTTPS──▶ nginx (443) ──HTTP──▶ node (127.0.0.1:8081)
                                              │
                                              └─▶ /opt/jira-timer/data/
                                                    ├── users.json
                                                    ├── tickets-*.json
                                                    ├── sessions.db
                                                    └── audit.log
```

Node binds to `127.0.0.1` only. All external traffic goes through nginx with TLS. No plain-HTTP access.

---

## Server Requirements

- Ubuntu 22.04+ (any recent LTS)
- Node.js 18+
- nginx
- `build-essential` and `python3` (for `better-sqlite3` native compilation)
- `git`

---

## First-time Install (from GitHub)

### 1. Install prerequisites

```bash
sudo apt-get update
sudo apt-get install -y nginx build-essential python3 git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Set up GitHub access on the server

**If the repo is public**, skip to step 3.

**If the repo is private**, the cleanest option is a GitHub **deploy key** — an SSH key scoped to a single repo.

On the server:

```bash
# Generate a key owned by root (the user that will run git operations)
sudo ssh-keygen -t ed25519 -f /root/.ssh/github-jira-timer -N '' -C "jira-timer-deploy@$(hostname)"
sudo cat /root/.ssh/github-jira-timer.pub
```

Copy the printed public key. In GitHub: go to your repo → **Settings → Deploy keys → Add deploy key** → paste it, give it a name like "CoG server — jira-timer", leave "Allow write access" **unchecked** (this machine only needs to pull), and save.

Tell SSH to use this key for github.com:

```bash
sudo tee -a /root/.ssh/config <<'EOF'

Host github.com
  HostName github.com
  User git
  IdentityFile /root/.ssh/github-jira-timer
  IdentitiesOnly yes
EOF
sudo chmod 600 /root/.ssh/config /root/.ssh/github-jira-timer
sudo chmod 644 /root/.ssh/github-jira-timer.pub

# Accept GitHub's host key once, non-interactively
sudo ssh-keyscan github.com | sudo tee -a /root/.ssh/known_hosts

# Verify
sudo ssh -T git@github.com    # Should print: Hi <repo>! You've successfully authenticated...
```

### 3. Clone the repo

```bash
# For a public repo over HTTPS:
sudo git clone https://github.com/<your-github-org>/jira-timer.git /opt/jira-timer

# Or for a private repo via SSH (using the deploy key from step 2):
sudo git clone git@github.com:<your-github-org>/jira-timer.git /opt/jira-timer

# Check out a tagged release (recommended — don't deploy from HEAD)
cd /opt/jira-timer
sudo git checkout v2.0.0
```

### 4. Install dependencies

```bash
cd /opt/jira-timer
sudo npm ci --omit=dev
sudo mkdir -p data
```

> Native dependencies (`better-sqlite3`) will compile during `npm ci`. This takes 30–60 seconds.

### 5. Generate secrets

```bash
sudo mkdir -p /etc/jira-timer
sudo bash -c '
  SS=$(node -e "console.log(require(\"crypto\").randomBytes(48).toString(\"hex\"))")
  CS=$(node -e "console.log(require(\"crypto\").randomBytes(48).toString(\"hex\"))")
  cat > /etc/jira-timer/secrets.env <<EOF
SESSION_SECRET=$SS
CSRF_SECRET=$CS
EOF
'
sudo chmod 600 /etc/jira-timer/secrets.env
sudo chown root:root /etc/jira-timer/secrets.env
```

> **Important:** The app refuses to start without both secrets set (minimum 32 characters each). These never go in the repo — `.gitignore` blocks `*.env` files as a safety net.

### 6. Set file ownership

The app's own source stays owned by `root`; only the data directory is writable by `www-data`. This means a compromised process can't rewrite `server.js` for persistence, and `git pull` continues to work as root.

```bash
sudo chown -R root:root /opt/jira-timer
sudo chown -R www-data:www-data /opt/jira-timer/data
sudo chmod 755 /opt/jira-timer
sudo chmod 700 /opt/jira-timer/data
```

### 7. Install the systemd service

```bash
sudo cp /opt/jira-timer/deploy/jira-timer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable jira-timer
sudo systemctl start jira-timer
```

### 8. Capture the initial admin password

On first start, the app generates a random temp password for the admin account and writes it to the journal. Grab it immediately:

```bash
sudo journalctl -u jira-timer | grep -A 4 "FIRST-RUN"
```

You'll see something like:

```
FIRST-RUN: Initial admin account created.
  Username: admin
  Temporary password: xYz9...-_abc
  You MUST change this password on first login.
```

Write this down or copy it out — it is **not** stored anywhere else. The first login will force you to change it.

> To pick a different initial admin username, add `Environment=INITIAL_ADMIN_USERNAME=yourname` to the systemd unit *before* the first start, or include it in `/etc/jira-timer/secrets.env`.

### 9. Configure nginx with TLS

Generate a self-signed cert for internal use (use CoG's internal PKI if available):

```bash
sudo mkdir -p /etc/nginx/ssl
sudo openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/jira-timer.key \
    -out /etc/nginx/ssl/jira-timer.crt \
    -subj "/CN=jira-timer.internal"
sudo chmod 600 /etc/nginx/ssl/jira-timer.key
```

Install and enable the nginx config:

```bash
sudo cp /opt/jira-timer/deploy/nginx-jira-timer.conf /etc/nginx/sites-available/jira-timer
sudo ln -sf /etc/nginx/sites-available/jira-timer /etc/nginx/sites-enabled/jira-timer
sudo nginx -t
sudo systemctl reload nginx
```

### 10. Verify

```bash
sudo systemctl status jira-timer
sudo systemctl status nginx
curl -ksf https://localhost/api/me    # should return {"user":null}
```

Then open `https://<server-hostname>/` in a browser (accept the self-signed cert warning on first visit) and sign in with the initial credentials from step 8.

### 11. (Optional) Verify systemd hardening

```bash
sudo systemd-analyze security jira-timer
```

Should report an "exposure level" of "OK" or better.

---

## Updating to a new version (2.x → 2.y)

Once the v2 install is in place, ongoing updates are simple because everything lives in git:

```bash
cd /opt/jira-timer

# Pull the latest tags
sudo git fetch --tags

# See what's available
git tag -l | tail -5

# Switch to the target release
sudo git checkout v2.1.0

# If dependencies changed
sudo npm ci --omit=dev

# If the systemd unit changed
sudo cp /opt/jira-timer/deploy/jira-timer.service /etc/systemd/system/
sudo systemctl daemon-reload

# If the nginx config changed
sudo cp /opt/jira-timer/deploy/nginx-jira-timer.conf /etc/nginx/sites-available/jira-timer
sudo nginx -t && sudo systemctl reload nginx

# Restart the app
sudo systemctl restart jira-timer
sudo systemctl status jira-timer
```

### Rolling back a release

```bash
cd /opt/jira-timer
sudo git checkout v2.0.0          # the previous known-good tag
sudo npm ci --omit=dev
sudo systemctl restart jira-timer
```

Your `data/` directory is untouched by these operations — it's gitignored, so git leaves it alone. If a schema or data format changes between versions, the release notes will flag it.

### Inspecting what changed

```bash
cd /opt/jira-timer
git log --oneline v2.0.0..v2.1.0          # commits between two releases
git diff v2.0.0..v2.1.0 -- server.js      # changes to a specific file
git diff v2.0.0..v2.1.0 -- deploy/        # changes to deployment files
```

---

## Upgrade from 1.x

These steps take the 1.x install (plain HTTP, MemoryStore sessions, hardcoded password, www-data-writable source, not in git) and migrate it to 2.x from GitHub. Your ticket and history data is preserved.

### 1. Back up

```bash
sudo systemctl stop jira-timer
sudo cp -a /opt/jira-timer /opt/jira-timer.v1-backup.$(date +%Y%m%d)
sudo cp -a /etc/jira-timer /etc/jira-timer.v1-backup.$(date +%Y%m%d)
```

### 2. Install prerequisites for the new version

```bash
sudo apt-get update
sudo apt-get install -y nginx build-essential python3 git
```

### 3. Set up GitHub access

Follow **[First-time Install step 2](#2-set-up-github-access-on-the-server)** if the repo is private.

### 4. Save your existing data, wipe the old install, clone fresh

Your ticket data is in `/opt/jira-timer/data/`. Everything else gets replaced by the git checkout.

```bash
# Move the existing data aside
sudo mv /opt/jira-timer/data /tmp/jira-timer-data-migrating

# Wipe the old install (it's in the backup from step 1, so this is safe)
sudo rm -rf /opt/jira-timer

# Clone the new version
sudo git clone git@github.com:<your-github-org>/jira-timer.git /opt/jira-timer
cd /opt/jira-timer
sudo git checkout v2.0.0

# Restore the data directory into the fresh checkout
sudo mv /tmp/jira-timer-data-migrating /opt/jira-timer/data

# Install dependencies
sudo npm ci --omit=dev
```

### 5. Add the CSRF secret

The new version needs a second secret. Append it to the existing secrets file:

```bash
sudo bash -c '
  CS=$(node -e "console.log(require(\"crypto\").randomBytes(48).toString(\"hex\"))")
  echo "CSRF_SECRET=$CS" >> /etc/jira-timer/secrets.env
'
sudo chmod 600 /etc/jira-timer/secrets.env
```

### 6. Tighten ownership

The v1 README had the whole tree owned by `www-data`. Fix that now:

```bash
sudo chown -R root:root /opt/jira-timer
sudo chown -R www-data:www-data /opt/jira-timer/data
sudo chmod 755 /opt/jira-timer
sudo chmod 700 /opt/jira-timer/data
sudo chmod 600 /opt/jira-timer/data/users.json
sudo chmod 600 /opt/jira-timer/data/tickets-*.json 2>/dev/null || true
```

### 7. Replace the systemd unit

```bash
sudo cp /opt/jira-timer/deploy/jira-timer.service /etc/systemd/system/
sudo systemctl daemon-reload
```

### 8. Install nginx + TLS

Follow **[First-time Install step 9](#9-configure-nginx-with-tls)**. The app will no longer accept plain HTTP on port 8081 from outside the host.

### 9. About your existing admin account

Your existing `tyler` account will be migrated automatically:

- `isAdmin: true` is preserved
- `mustChangePassword` stays `false` (assuming you already changed it from `testpassword123!`)
- If you are **not** sure whether your current password is still the hardcoded one, reset it now by either logging in and using the **Change Password** button in the nav bar, or by deleting `/opt/jira-timer/data/users.json` before starting — the app will create a fresh `admin` account with a random temp password. All ticket data survives.

### 10. Start the new version

```bash
sudo systemctl start jira-timer
sudo systemctl status jira-timer
sudo journalctl -u jira-timer -n 50
```

Open `https://<server-hostname>/` and log in. **Existing sessions are invalidated** by the session store change — everyone will be prompted to log in again. That's expected.

### 11. Verify the upgrade

```bash
# App running
sudo systemctl is-active jira-timer
# Nginx proxying to it
curl -ksf https://localhost/api/me
# Data still there
sudo ls -la /opt/jira-timer/data/
# Audit log being written
sudo tail /opt/jira-timer/data/audit.log
# Confirm you're on the right tag
cd /opt/jira-timer && git describe --tags
```

If anything's wrong, roll back to the pre-upgrade snapshot:

```bash
sudo systemctl stop jira-timer
sudo rm -rf /opt/jira-timer
sudo mv /opt/jira-timer.v1-backup.<date> /opt/jira-timer
sudo cp /path/to/old/jira-timer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start jira-timer
```

---

## Day-to-day operation

### Access the app

```
https://<your-server-hostname>/
```

### Change a user's password

From the app: click the lock icon in the top-right nav bar.

### Forgot the admin password entirely

Stop the service, delete `users.json`, start the service. A new admin account will be seeded with a random password (journal will show it). All ticket data survives since it's in separate files.

```bash
sudo systemctl stop jira-timer
sudo rm /opt/jira-timer/data/users.json
sudo systemctl start jira-timer
sudo journalctl -u jira-timer | grep -A 4 "FIRST-RUN"
```

### Add a new user

Log in as admin, go to Admin → Add User. The user is forced to change their password on first login.

### Viewing logs

Application logs:
```bash
sudo journalctl -u jira-timer -f
```

Audit log (login attempts, ticket events, admin actions):
```bash
sudo tail -f /opt/jira-timer/data/audit.log
```

### Data location

- `/opt/jira-timer/data/users.json` — user accounts + bcrypt password hashes
- `/opt/jira-timer/data/tickets-<username>.json` — per-user ticket data
- `/opt/jira-timer/data/sessions.db` — SQLite session store
- `/opt/jira-timer/data/audit.log` — append-only audit trail (JSON lines)

### Backups

The whole `data/` directory is the state. Back it up on a schedule:

```bash
# Example: nightly cron entry
0 2 * * * tar czf /var/backups/jira-timer-$(date +\%F).tar.gz -C /opt/jira-timer data
```

---

## Security features (v2.0)

- TLS-only access via nginx reverse proxy
- CSRF protection (double-submit cookie pattern, HMAC-signed) on all state-changing endpoints
- Session cookies: `HttpOnly`, `Secure`, `SameSite=Strict`, 8-hour max age, rolling, regenerated on login
- Persistent SQLite-backed session store (survives restarts)
- Helmet security headers (CSP, X-Frame-Options, Referrer-Policy, etc.)
- Per-IP and per-account login rate limiting
- Forced password change on first login and after admin-initiated resets
- Minimum 12-character passwords, bcrypt cost factor 12
- Atomic JSON writes (temp file + rename) with per-file mutex
- Random UUIDs for ticket IDs
- Append-only JSON audit log
- Bound to `127.0.0.1` only — never reachable directly from the network
- systemd sandboxing: `ProtectSystem=strict`, `NoNewPrivileges`, restricted syscalls, read-only source, read-write `data/` only
- Source owned by `root`, not `www-data` — compromised process can't rewrite itself
- Secrets live in `/etc/jira-timer/secrets.env`, never in the repo; `.gitignore` blocks `*.env` as a safety net

---

## Troubleshooting

**Service won't start, journal says "SESSION_SECRET is not set":**
Check that `/etc/jira-timer/secrets.env` exists, is readable by root, and has both `SESSION_SECRET` and `CSRF_SECRET` populated with 32+ char values.

**`npm ci` fails on `better-sqlite3`:**
Make sure `build-essential` and `python3` are installed. Check Node version is 18+.

**`git pull` or `git clone` returns "Permission denied (publickey)":**
The deploy key isn't set up correctly. Re-run **[First-time Install step 2](#2-set-up-github-access-on-the-server)** and verify with `sudo ssh -T git@github.com`.

**Login works but every action returns "Invalid or missing CSRF token":**
Usually caused by a stale cached copy of `index.html`. Hard-refresh the browser (Ctrl+Shift+R). The client auto-fetches a token on first mutating request.

**"Too many login attempts" lockout:**
Either wait 15 minutes, or restart the service to clear the in-memory counter (`sudo systemctl restart jira-timer`).

**nginx returns 502:**
Check that Node is running (`sudo systemctl status jira-timer`) and bound to 127.0.0.1:8081 (`sudo ss -tlnp | grep 8081`).

**After a `git checkout`, the service doesn't pick up changes:**
You need to run `sudo systemctl restart jira-timer` after any update. If dependencies changed, run `sudo npm ci --omit=dev` first.
