# Jira Timer

Self-hosted time tracking for Jira tickets. Built with Node.js and Express.

---

## Repository layout

```
jira-timer/
├── server.js                   Backend Node app
├── package.json                Dependencies
├── package-lock.json           Pinned dep versions (commit this after first install)
├── public/
│   └── index.html              Frontend SPA
├── deploy/
│   ├── jira-timer.service      systemd unit
│   ├── nginx-jira-timer.conf   nginx reverse proxy config
│   └── secrets_env.template    Template for /etc/jira-timer/secrets.env
├── .gitignore
└── README.md
```

Runtime data (`data/`, `node_modules/`, secrets) is created on the server and is never committed to the repo.

---

## Architecture

```
Browser ──HTTPS──▶ nginx (port 443) ──HTTP──▶ Node (127.0.0.1:8081)
                                                    │
                                                    └─▶ /opt/jira-timer/data/
                                                          ├── users.json
                                                          ├── tickets-*.json
                                                          ├── sessions.db
                                                          └── audit.log
```

Node binds to `127.0.0.1` only — it is never directly reachable from the network. All traffic goes through nginx over TLS.

---

## First-time Install (Ubuntu 22.04+)

### 1. Install prerequisites

```bash
sudo apt-get update
sudo apt-get install -y nginx build-essential python3 git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Verify versions:

```bash
node --version    # should be v20.x or higher
npm --version
nginx -v
```

### 2. Set up GitHub access

**Public repo:** skip to step 3.

**Private repo:** create a deploy key so the server can pull from GitHub without a password.

```bash
# Generate a deploy key
sudo ssh-keygen -t ed25519 -f /root/.ssh/github-jira-timer -N '' -C "jira-timer-deploy@$(hostname)"

# Print the public key — you'll paste this into GitHub
sudo cat /root/.ssh/github-jira-timer.pub
```

In GitHub: go to your repo → **Settings → Deploy keys → Add deploy key**. Paste the public key, name it something like "CoG server", leave **Allow write access unchecked**, and save.

Configure SSH to use this key for GitHub:

```bash
sudo tee -a /root/.ssh/config << 'EOF'

Host github.com
  HostName github.com
  User git
  IdentityFile /root/.ssh/github-jira-timer
  IdentitiesOnly yes
EOF

sudo chmod 600 /root/.ssh/config /root/.ssh/github-jira-timer
sudo chmod 644 /root/.ssh/github-jira-timer.pub
sudo ssh-keyscan github.com | sudo tee -a /root/.ssh/known_hosts

# Verify — should print: Hi <repo>! You've successfully authenticated...
sudo ssh -T git@github.com
```

### 3. Clone the repo

```bash
# Public repo (HTTPS):
sudo git clone https://github.com/<your-org>/jira-timer.git /opt/jira-timer

# Private repo (SSH deploy key):
sudo git clone git@github.com:<your-org>/jira-timer.git /opt/jira-timer
```

### 4. Install dependencies

```bash
cd /opt/jira-timer
sudo npm install --omit=dev
sudo mkdir -p data
```

> `better-sqlite3` is a native module and will compile during install. This takes 30–60 seconds and requires `build-essential` and `python3` from step 1.

> **Note for future deploys:** After the first `npm install` completes, commit the generated `package-lock.json` to the repo. Future installs can then use `npm ci --omit=dev` instead, which is faster and reproducible.

### 5. Generate secrets

```bash
sudo mkdir -p /etc/jira-timer
sudo bash -c '
  SS=$(node -e "console.log(require(\"crypto\").randomBytes(48).toString(\"hex\"))")
  CS=$(node -e "console.log(require(\"crypto\").randomBytes(48).toString(\"hex\"))")
  cat > /etc/jira-timer/secrets.env << EOF
SESSION_SECRET=$SS
CSRF_SECRET=$CS
EOF
'
sudo chmod 600 /etc/jira-timer/secrets.env
sudo chown root:root /etc/jira-timer/secrets.env
```

The app will refuse to start if either secret is missing or shorter than 32 characters. These never go in the repo — `.gitignore` blocks `*.env` files.

### 6. Set file ownership

The app source is owned by `root` so the process can't modify its own code. Only the `data/` directory is writable by the app.

```bash
sudo chown -R root:root /opt/jira-timer
sudo chown -R www-data:www-data /opt/jira-timer/data
sudo chmod 755 /opt/jira-timer
sudo chmod 700 /opt/jira-timer/data
```

### 7. Install and start the systemd service

```bash
sudo cp /opt/jira-timer/deploy/jira-timer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable jira-timer
sudo systemctl start jira-timer
```

Check it started cleanly:

```bash
sudo systemctl status jira-timer
```

### 8. Get the initial admin password

On first start the app generates a random temporary password and prints it to the journal. Grab it now — it is not stored anywhere and will not be shown again:

```bash
sudo journalctl -u jira-timer | grep -A 4 "FIRST-RUN"
```

Output will look like:

```
FIRST-RUN: Initial admin account created.
  Username: admin
  Temporary password: abc123...
  You MUST change this password on first login.
```

You will be forced to change this password on first login.

> To use a different admin username, add `Environment=INITIAL_ADMIN_USERNAME=yourname` to the systemd unit before the first start, or add `INITIAL_ADMIN_USERNAME=yourname` to `/etc/jira-timer/secrets.env`.

### 9. Configure nginx with TLS

Generate a self-signed certificate (use your internal PKI if CoG has one):

```bash
sudo mkdir -p /etc/nginx/ssl
sudo openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/jira-timer.key \
    -out /etc/nginx/ssl/jira-timer.crt \
    -subj "/CN=jira-timer.internal"
sudo chmod 600 /etc/nginx/ssl/jira-timer.key
```

Install the nginx config and disable the default site:

```bash
sudo cp /opt/jira-timer/deploy/nginx-jira-timer.conf /etc/nginx/sites-available/jira-timer
sudo ln -s /etc/nginx/sites-available/jira-timer /etc/nginx/sites-enabled/jira-timer
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 10. Verify everything is working

```bash
# Services are running
sudo systemctl is-active jira-timer
sudo systemctl is-active nginx

# App responds through nginx
curl -sk https://localhost/api/me      # should return {"user":null}
curl -sk https://localhost/api/csrf    # should return {"csrfToken":"..."}
```

### 11. Log in

Open `https://<your-server-ip>/` in a browser. Your browser will show a certificate warning for the self-signed cert — click **Advanced → Proceed** to continue.

Sign in with the credentials from step 8. You will be prompted to set a new password before you can do anything else.

---

## Updating to a new version

```bash
cd /opt/jira-timer

# Pull latest
sudo git fetch --tags
sudo git checkout v2.1.0        # or whatever the target tag is

# If package.json changed
sudo npm ci --omit=dev

# If the systemd unit changed
sudo cp deploy/jira-timer.service /etc/systemd/system/
sudo systemctl daemon-reload

# If the nginx config changed
sudo cp deploy/nginx-jira-timer.conf /etc/nginx/sites-available/jira-timer
sudo nginx -t && sudo systemctl reload nginx

# Always restart the app after an update
sudo systemctl restart jira-timer
sudo systemctl status jira-timer
```

### Rolling back

```bash
cd /opt/jira-timer
sudo git checkout v2.0.0
sudo npm ci --omit=dev
sudo systemctl restart jira-timer
```

The `data/` directory is gitignored and is never touched by git operations.

---

## Day-to-day operation

### Change your password

Click the lock icon in the top-right nav bar while logged in.

### Add a user

Log in as admin → Admin tab → Add User. New users are forced to change their password on first login.

### Forgot the admin password

```bash
sudo systemctl stop jira-timer
sudo rm /opt/jira-timer/data/users.json
sudo systemctl start jira-timer
sudo journalctl -u jira-timer | grep -A 4 "FIRST-RUN"
```

All ticket data is in separate files and survives this.

### Logs

```bash
# App and error logs
sudo journalctl -u jira-timer -f

# Audit log (logins, ticket actions, admin operations)
sudo tail -f /opt/jira-timer/data/audit.log
```

### Backups

All state lives in `/opt/jira-timer/data/`. Back it up on a schedule:

```bash
# Add to crontab: nightly backup at 2am
0 2 * * * tar czf /var/backups/jira-timer-$(date +\%F).tar.gz -C /opt/jira-timer data
```

---

## Security features

- TLS-only via nginx — Node never exposes a public port
- CSRF protection (HMAC double-submit cookie) on all state-changing endpoints
- Session cookies: `HttpOnly`, `Secure`, `SameSite=Strict`, 8-hour rolling expiry, regenerated on login
- Persistent SQLite session store — sessions survive service restarts
- Helmet security headers: CSP, `X-Frame-Options`, `Referrer-Policy`, HSTS
- Per-IP and per-account login rate limiting
- Forced password change on first login and after admin resets
- Passwords: bcrypt cost factor 12, minimum 12 characters
- Atomic file writes with per-file mutex — no data corruption on concurrent requests or crashes
- Random UUIDs for all ticket IDs
- Append-only JSON audit log
- systemd sandboxing: `ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`, restricted address families, read-only source tree
- App source owned by `root` — a compromised process cannot modify its own code

---

## Troubleshooting

**Service won't start: "SESSION_SECRET is not set"**
Check `/etc/jira-timer/secrets.env` exists, is owned by root, and has both `SESSION_SECRET` and `CSRF_SECRET` set to values of 32+ characters.

**`npm install` fails on `better-sqlite3`**
Ensure `build-essential` and `python3` are installed (`sudo apt-get install -y build-essential python3`) and that Node is version 18 or higher.

**`git clone` fails: "Permission denied (publickey)"**
The deploy key isn't set up correctly. Re-run step 2 and verify with `sudo ssh -T git@github.com`.

**Browser shows "Could not fetch CSRF token" on the login page**
The app is reachable but returning an error on `/api/csrf`. Check the service is running (`sudo systemctl status jira-timer`) and that nginx is proxying correctly (`curl -sk https://localhost/api/csrf`).

**nginx returns 502 Bad Gateway**
Node is not running or not listening on port 8081. Check `sudo systemctl status jira-timer` and `sudo ss -tlnp | grep 8081`.

**nginx -t fails: "unknown directive http2"**
Your nginx version is older than 1.25.1. The config uses `listen 443 ssl http2` (single line), which is correct for older versions. If you see this error, your copy of the config has the wrong syntax — re-copy from `deploy/nginx-jira-timer.conf`.

**Buttons and links don't respond after login**
Hard-refresh the browser with Ctrl+Shift+R to clear a cached old version of `index.html`.

**After `git checkout`, changes aren't live**
Always run `sudo systemctl restart jira-timer` after updating. If `package.json` changed, run `sudo npm ci --omit=dev` first.
