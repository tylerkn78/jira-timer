'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);
const { doubleCsrf } = require('csrf-csrf');

// ============================================================================
// CONFIG
// ============================================================================

const PORT = parseInt(process.env.PORT, 10) || 8081;
const BIND_ADDR = process.env.BIND_ADDR || '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_DB = path.join(DATA_DIR, 'sessions.db');
const AUDIT_LOG = path.join(DATA_DIR, 'audit.log');
const INITIAL_ADMIN_USERNAME = (process.env.INITIAL_ADMIN_USERNAME || 'admin').trim();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const BEHIND_PROXY = process.env.BEHIND_PROXY !== 'false'; // default true
const USERNAME_REGEX = /^[a-zA-Z0-9_]{2,32}$/;
const TICKET_REGEX = /^[A-Z]+-\d+$/;

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('FATAL: SESSION_SECRET environment variable is not set or is too short (minimum 32 chars). Refusing to start.');
  process.exit(1);
}

const CSRF_SECRET = process.env.CSRF_SECRET;
if (!CSRF_SECRET || CSRF_SECRET.length < 32) {
  console.error('FATAL: CSRF_SECRET environment variable is not set or is too short (minimum 32 chars). Refusing to start.');
  process.exit(1);
}

// ============================================================================
// STORAGE: atomic writes + per-file async mutex
// ============================================================================

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const fileLocks = new Map();
async function withFileLock(key, fn) {
  const prev = fileLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(res => { release = res; });
  fileLocks.set(key, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (fileLocks.get(key) === next) fileLocks.delete(key);
  }
}

async function atomicWriteJSON(filePath, obj) {
  const tmp = filePath + '.tmp.' + process.pid + '.' + Date.now();
  const data = JSON.stringify(obj, null, 2);
  await fsp.writeFile(tmp, data, { mode: 0o600 });
  await fsp.rename(tmp, filePath);
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// ============================================================================
// USERS
// ============================================================================

function readUsers() {
  return readJSON(USERS_FILE);
}

async function writeUsers(users) {
  await withFileLock(USERS_FILE, () => atomicWriteJSON(USERS_FILE, users));
}

// Seed users file if missing. Generate a random temp password and log it to
// stderr (which systemd captures in journald). First login requires a change.
if (!fs.existsSync(USERS_FILE)) {
  const tempPassword = crypto.randomBytes(12).toString('base64url');
  const hash = bcrypt.hashSync(tempPassword, 12);
  fs.writeFileSync(USERS_FILE, JSON.stringify([{
    username: INITIAL_ADMIN_USERNAME,
    password: hash,
    isAdmin: true,
    mustChangePassword: true,
    createdAt: new Date().toISOString()
  }], null, 2), { mode: 0o600 });
  console.error('================================================================');
  console.error('FIRST-RUN: Initial admin account created.');
  console.error('  Username: ' + INITIAL_ADMIN_USERNAME);
  console.error('  Temporary password: ' + tempPassword);
  console.error('  You MUST change this password on first login.');
  console.error('  This password will NOT be shown again.');
  console.error('================================================================');
} else {
  // Migrate: ensure every user record has required fields
  const users = readUsers();
  let changed = false;
  users.forEach(u => {
    if (u.isAdmin === undefined) { u.isAdmin = false; changed = true; }
    if (u.mustChangePassword === undefined) { u.mustChangePassword = false; changed = true; }
    if (!u.createdAt) { u.createdAt = new Date().toISOString(); changed = true; }
  });
  // Legacy: preserve tyler-as-admin from the prior version if still present and
  // no admin exists.
  if (!users.some(u => u.isAdmin)) {
    const tyler = users.find(u => u.username === 'tyler');
    if (tyler) { tyler.isAdmin = true; changed = true; }
  }
  if (changed) fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

// Tighten perms on existing data files on startup
try { fs.chmodSync(USERS_FILE, 0o600); } catch (_) {}

// ============================================================================
// PER-USER TICKET DATA
// ============================================================================

function getDataFile(username) {
  // Defense in depth: username is validated on creation, but sanitize again.
  if (!USERNAME_REGEX.test(username)) throw new Error('Invalid username');
  return path.join(DATA_DIR, `tickets-${username}.json`);
}

async function initDataFile(username) {
  const file = getDataFile(username);
  if (fs.existsSync(file)) return;
  await withFileLock(file, async () => {
    if (fs.existsSync(file)) return;
    const legacy = path.join(DATA_DIR, 'tickets.json');
    if (username === 'tyler' && fs.existsSync(legacy)) {
      await fsp.copyFile(legacy, file);
      await fsp.chmod(file, 0o600);
    } else {
      await atomicWriteJSON(file, { active: [], history: [] });
    }
  });
}

async function readData(username) {
  await initDataFile(username);
  return readJSON(getDataFile(username));
}

async function writeData(username, data) {
  const file = getDataFile(username);
  await withFileLock(file, () => atomicWriteJSON(file, data));
}

// Read-modify-write helper that holds the lock across the whole operation.
async function updateData(username, mutator) {
  const file = getDataFile(username);
  await initDataFile(username);
  return withFileLock(file, async () => {
    const data = readJSON(file);
    const result = await mutator(data);
    await atomicWriteJSON(file, data);
    return result;
  });
}

// ============================================================================
// AUDIT LOG
// ============================================================================

function audit(event, req, extra) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    user: (req && req.session && req.session.user) || null,
    ip: (req && (req.ip || req.connection.remoteAddress)) || null,
    ...(extra || {})
  };
  try {
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) {
    console.error('audit log write failed:', e.message);
  }
}

// ============================================================================
// TIMER HELPERS
// ============================================================================

function getElapsed(ticket) {
  let elapsed = ticket.elapsed || 0;
  if (ticket.running && ticket.startedAt) {
    elapsed += (Date.now() - new Date(ticket.startedAt).getTime()) / 1000;
  }
  return Math.floor(elapsed);
}

function enrichTicket(ticket) {
  return { ...ticket, liveElapsed: getElapsed(ticket), serverTime: Date.now() };
}

async function archiveOldTickets(username) {
  await updateData(username, data => {
    const today = new Date().toDateString();
    const toArchive = data.active.filter(t => t.completed && new Date(t.completedAt).toDateString() !== today);
    if (toArchive.length > 0) {
      data.history = [...data.history, ...toArchive];
      data.active = data.active.filter(t => !(t.completed && new Date(t.completedAt).toDateString() !== today));
    }
  });
}

// ============================================================================
// APP SETUP
// ============================================================================

const app = express();

// Behind an nginx reverse proxy terminating TLS on the same host.
if (BEHIND_PROXY) app.set('trust proxy', 1);

app.disable('x-powered-by');

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // The UI uses inline <script> and <style>. A future refactor could move
      // these to separate files and drop 'unsafe-inline'.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false, // Google Fonts compatibility
  hsts: IS_PRODUCTION ? { maxAge: 15552000, includeSubDomains: true } : false
}));

app.use(express.json({ limit: '10kb' }));

// Session store: persistent, survives restarts.
const sessionDb = new Database(SESSIONS_DB);
try { fs.chmodSync(SESSIONS_DB, 0o600); } catch (_) {}

app.use(session({
  name: 'jiratimer.sid',
  store: new SqliteStore({
    client: sessionDb,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 }
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PRODUCTION,
    path: '/'
  }
}));

// cookie-parser must be registered before doubleCsrfProtection. Per csrf-csrf
// docs, when using express-session, register it AFTER session.
app.use(cookieParser(SESSION_SECRET));

// Serve the SPA (index.html etc.) from ./public
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
}));

// ============================================================================
// CSRF
// ============================================================================

const { generateToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => CSRF_SECRET,
  getSessionIdentifier: (req) => (req.session && req.session.id) || req.ip || 'anon',
  cookieName: 'jiratimer.csrf',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PRODUCTION,
    path: '/'
  },
  getTokenFromRequest: (req) => req.headers['x-csrf-token']
});

// Endpoint to fetch a CSRF token. Safe because only same-site + authed
// callers can read the response (CORS not enabled; sameSite=strict on cookie).
app.get('/api/csrf', (req, res) => {
  try {
    const token = generateToken(req, res, true);
    res.json({ csrfToken: token });
  } catch (e) {
    const token = generateToken(req, res, true);
    res.json({ csrfToken: token });
  }
});

// ============================================================================
// MIDDLEWARE
// ============================================================================

function authRequired(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function adminRequired(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  const user = readUsers().find(u => u.username === req.session.user);
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Block all access except /api/password while mustChangePassword is true.
function passwordChangeGate(req, res, next) {
  if (!req.session.user) return next();
  const user = readUsers().find(u => u.username === req.session.user);
  if (user && user.mustChangePassword
      && req.path !== '/api/password'
      && req.path !== '/api/me'
      && req.path !== '/api/logout'
      && req.path !== '/api/csrf') {
    return res.status(403).json({ error: 'Password change required', mustChangePassword: true });
  }
  next();
}

// ============================================================================
// RATE LIMITING
// ============================================================================

// Per-IP limiter on login attempts.
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts from this IP. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Per-account limiter: 5 failures per username per 15 minutes.
const accountFailures = new Map();
function recordLoginFailure(username) {
  const now = Date.now();
  const rec = accountFailures.get(username) || { count: 0, firstAt: now };
  if (now - rec.firstAt > 15 * 60 * 1000) { rec.count = 0; rec.firstAt = now; }
  rec.count += 1;
  accountFailures.set(username, rec);
  return rec.count;
}
function isAccountLocked(username) {
  const rec = accountFailures.get(username);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > 15 * 60 * 1000) { accountFailures.delete(username); return false; }
  return rec.count >= 5;
}
function clearAccountFailures(username) { accountFailures.delete(username); }

// General write-endpoint limiter (ticket creation/update/delete abuse protection)
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

// ============================================================================
// AUTH ROUTES
// ============================================================================

app.post('/api/login', loginIpLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (isAccountLocked(username)) {
    audit('login.locked', req, { username });
    return res.status(429).json({ error: 'Account temporarily locked due to repeated failed attempts. Try again in 15 minutes.' });
  }
  const users = readUsers();
  const user = users.find(u => u.username === username);
  const ok = user && bcrypt.compareSync(password, user.password);
  if (!ok) {
    if (user) recordLoginFailure(username);
    audit('login.fail', req, { username });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  clearAccountFailures(username);

  // Regenerate session ID to prevent fixation.
  req.session.regenerate((err) => {
    if (err) {
      audit('login.session_error', req, { username, err: err.message });
      return res.status(500).json({ error: 'Session error' });
    }
    req.session.user = username;
    req.session.save((err2) => {
      if (err2) return res.status(500).json({ error: 'Session error' });
      audit('login.success', req, { username });
      res.json({
        success: true,
        username,
        isAdmin: !!user.isAdmin,
        mustChangePassword: !!user.mustChangePassword
      });
    });
  });
});

app.post('/api/logout', (req, res) => {
  const username = req.session.user;
  req.session.destroy(() => {
    res.clearCookie('jiratimer.sid');
    if (username) audit('logout', { session: { user: username }, ip: req.ip });
    res.json({ success: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const user = readUsers().find(u => u.username === req.session.user);
  res.json({
    user: req.session.user,
    isAdmin: !!(user && user.isAdmin),
    mustChangePassword: !!(user && user.mustChangePassword)
  });
});

// Change own password. Allowed even when mustChangePassword is true.
app.post('/api/password', authRequired, doubleCsrfProtection, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (newPassword.length < 12) {
    return res.status(400).json({ error: 'New password must be at least 12 characters' });
  }
  if (newPassword.length > 200) {
    return res.status(400).json({ error: 'New password too long' });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'New password must differ from current password' });
  }
  const users = readUsers();
  const idx = users.findIndex(u => u.username === req.session.user);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  if (!bcrypt.compareSync(currentPassword, users[idx].password)) {
    audit('password.change_fail', req);
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  users[idx].password = bcrypt.hashSync(newPassword, 12);
  users[idx].mustChangePassword = false;
  users[idx].passwordChangedAt = new Date().toISOString();
  await writeUsers(users);
  audit('password.change_success', req);
  res.json({ success: true });
});

// All remaining routes require CSRF protection on non-GET requests + password
// change gate.
app.use(passwordChangeGate);

// ============================================================================
// TICKET ROUTES
// ============================================================================

app.get('/api/tickets', authRequired, async (req, res) => {
  await archiveOldTickets(req.session.user);
  const data = await readData(req.session.user);
  res.json(data.active.map(enrichTicket));
});

app.post('/api/tickets', authRequired, doubleCsrfProtection, writeLimiter, async (req, res) => {
  const { ticketNumber } = req.body || {};
  if (typeof ticketNumber !== 'string' || ticketNumber.length > 32) {
    return res.status(400).json({ error: 'Invalid ticket number' });
  }
  const normalized = ticketNumber.toUpperCase();
  if (!TICKET_REGEX.test(normalized)) {
    return res.status(400).json({ error: 'Invalid ticket number format (e.g. IT-12345)' });
  }
  try {
    const ticket = await updateData(req.session.user, (data) => {
      if (data.active.find(t => t.ticketNumber === normalized)) {
        const e = new Error('Ticket already being tracked');
        e.status = 400; throw e;
      }
      if (data.active.length >= 500) {
        const e = new Error('Too many active tickets'); e.status = 400; throw e;
      }
      const t = {
        id: crypto.randomUUID(),
        ticketNumber: normalized,
        createdAt: new Date().toISOString(),
        running: true,
        startedAt: new Date().toISOString(),
        elapsed: 0,
        completed: false,
        completedAt: null,
        totalTime: 0
      };
      data.active.push(t);
      return t;
    });
    audit('ticket.create', req, { ticketNumber: normalized });
    res.json(enrichTicket(ticket));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Server error' });
  }
});

app.patch('/api/tickets/:id', authRequired, doubleCsrfProtection, writeLimiter, async (req, res) => {
  const { action } = req.body || {};
  if (!['start', 'stop', 'complete'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  try {
    const ticket = await updateData(req.session.user, (data) => {
      const idx = data.active.findIndex(t => t.id === req.params.id);
      if (idx === -1) { const e = new Error('Ticket not found'); e.status = 404; throw e; }
      const t = data.active[idx];
      const currentElapsed = getElapsed(t);
      if (action === 'start') {
        t.elapsed = currentElapsed; t.running = true; t.startedAt = new Date().toISOString();
      } else if (action === 'stop') {
        t.elapsed = currentElapsed; t.running = false; t.startedAt = null;
      } else if (action === 'complete') {
        t.elapsed = currentElapsed; t.running = false; t.completed = true;
        t.completedAt = new Date().toISOString(); t.totalTime = currentElapsed; t.startedAt = null;
      }
      data.active[idx] = t;
      return t;
    });
    audit('ticket.' + action, req, { id: req.params.id, ticketNumber: ticket.ticketNumber });
    res.json(enrichTicket(ticket));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Server error' });
  }
});

app.delete('/api/tickets/:id', authRequired, doubleCsrfProtection, writeLimiter, async (req, res) => {
  await updateData(req.session.user, (data) => {
    data.active = data.active.filter(t => t.id !== req.params.id);
  });
  audit('ticket.delete', req, { id: req.params.id });
  res.json({ success: true });
});

// ============================================================================
// HISTORY ROUTES
// ============================================================================

app.get('/api/history', authRequired, async (req, res) => {
  await archiveOldTickets(req.session.user);
  const data = await readData(req.session.user);
  const todayCompleted = data.active.filter(t => t.completed);
  const allHistory = [...todayCompleted, ...data.history];
  allHistory.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  res.json(allHistory);
});

app.delete('/api/history/:id', authRequired, doubleCsrfProtection, writeLimiter, async (req, res) => {
  await updateData(req.session.user, (data) => {
    data.history = data.history.filter(t => t.id !== req.params.id);
    data.active = data.active.filter(t => t.id !== req.params.id);
  });
  audit('history.delete', req, { id: req.params.id });
  res.json({ success: true });
});

// ============================================================================
// ADMIN ROUTES
// ============================================================================

app.get('/api/admin/users', adminRequired, (req, res) => {
  const users = readUsers();
  res.json(users.map(u => ({
    username: u.username,
    isAdmin: !!u.isAdmin,
    mustChangePassword: !!u.mustChangePassword,
    createdAt: u.createdAt || null
  })));
});

app.post('/api/admin/users', adminRequired, doubleCsrfProtection, async (req, res) => {
  const { username, password, isAdmin } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (!USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: 'Username must be 2-32 chars, letters/numbers/underscore only' });
  }
  if (password.length < 12) {
    return res.status(400).json({ error: 'Password must be at least 12 characters' });
  }
  if (password.length > 200) {
    return res.status(400).json({ error: 'Password too long' });
  }
  const users = readUsers();
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }
  users.push({
    username,
    password: bcrypt.hashSync(password, 12),
    isAdmin: !!isAdmin,
    mustChangePassword: true, // force user to change the admin-set password
    createdAt: new Date().toISOString()
  });
  await writeUsers(users);
  await initDataFile(username);
  audit('admin.user_create', req, { targetUser: username, isAdmin: !!isAdmin });
  res.json({ success: true, username });
});

app.delete('/api/admin/users/:username', adminRequired, doubleCsrfProtection, async (req, res) => {
  const target = req.params.username;
  if (target === req.session.user) return res.status(400).json({ error: "You can't delete your own account" });
  if (!USERNAME_REGEX.test(target)) return res.status(400).json({ error: 'Invalid username' });
  const users = readUsers();
  const filtered = users.filter(u => u.username !== target);
  if (filtered.length === users.length) return res.status(404).json({ error: 'User not found' });
  // Safety: don't allow removing the last admin.
  if (!filtered.some(u => u.isAdmin)) return res.status(400).json({ error: 'Cannot remove the last admin' });
  await writeUsers(filtered);
  audit('admin.user_delete', req, { targetUser: target });
  res.json({ success: true });
});

// Admin-initiated password reset: sets a new password and forces change on next login.
app.post('/api/admin/users/:username/reset-password', adminRequired, doubleCsrfProtection, async (req, res) => {
  const target = req.params.username;
  const { newPassword } = req.body || {};
  if (!USERNAME_REGEX.test(target)) return res.status(400).json({ error: 'Invalid username' });
  if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 200) {
    return res.status(400).json({ error: 'Password must be 12-200 characters' });
  }
  const users = readUsers();
  const idx = users.findIndex(u => u.username === target);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  users[idx].password = bcrypt.hashSync(newPassword, 12);
  users[idx].mustChangePassword = true;
  users[idx].passwordChangedAt = new Date().toISOString();
  await writeUsers(users);
  clearAccountFailures(target);
  audit('admin.password_reset', req, { targetUser: target });
  res.json({ success: true });
});

app.get('/api/admin/tickets/:username', adminRequired, async (req, res) => {
  const target = req.params.username;
  if (!USERNAME_REGEX.test(target)) return res.status(400).json({ error: 'Invalid username' });
  if (!readUsers().find(u => u.username === target)) return res.status(404).json({ error: 'User not found' });
  await archiveOldTickets(target);
  const data = await readData(target);
  audit('admin.view_active', req, { targetUser: target });
  res.json(data.active.map(enrichTicket));
});

app.get('/api/admin/history/:username', adminRequired, async (req, res) => {
  const target = req.params.username;
  if (!USERNAME_REGEX.test(target)) return res.status(400).json({ error: 'Invalid username' });
  if (!readUsers().find(u => u.username === target)) return res.status(404).json({ error: 'User not found' });
  await archiveOldTickets(target);
  const data = await readData(target);
  const todayCompleted = data.active.filter(t => t.completed);
  const allHistory = [...todayCompleted, ...data.history];
  allHistory.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  audit('admin.view_history', req, { targetUser: target });
  res.json(allHistory);
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

// CSRF error handler: surface a friendly JSON response.
app.use((err, req, res, next) => {
  if (err && err.code === 'EBADCSRFTOKEN') {
    audit('csrf.fail', req, { path: req.path });
    return res.status(403).json({ error: 'Invalid or missing CSRF token. Reload the page and try again.' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// START
// ============================================================================

app.listen(PORT, BIND_ADDR, () => {
  console.log(`Jira Timer listening on ${BIND_ADDR}:${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
});
