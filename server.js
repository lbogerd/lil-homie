import http from 'node:http';
import { readFileSync, mkdirSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, ECDH } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import webpush from 'web-push';

const root = fileURLToPath(new URL('.', import.meta.url));
export const scenarios = {
  immediate: { title: 'Immediate test', delay: 0 },
  delayed: { title: '30-second test', delay: 30000 },
  open: { title: 'App open test', delay: 0 },
  closed: { title: 'App closed test', delay: 30000 },
  locked: { title: 'Locked phone test', delay: 30000 },
  tap: { title: 'Tap to open test', delay: 30000 },
};
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function validateSubscription(s) {
  if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 4096) fail('Invalid push subscription.');
  let u; try { u = new URL(s.endpoint); } catch { fail('Invalid push endpoint.'); }
  const trusted = u.hostname.endsWith('.push.apple.com') || u.hostname === 'fcm.googleapis.com' ||
    u.hostname === 'updates.push.services.mozilla.com' || u.hostname.endsWith('.push.services.mozilla.com');
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || !trusted) fail('Unsupported push provider.');
  for (const [key, size] of [['auth', 16], ['p256dh', 65]]) {
    const v = s.keys?.[key];
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(v) || Buffer.from(v, 'base64url').length !== size) fail('Invalid subscription keys.');
  }
  try { ECDH.convertKey(Buffer.from(s.keys.p256dh, 'base64url'), 'prime256v1'); } catch { fail('Invalid subscription public key.'); }
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

export function createApp({ dataDir = process.env.DATA_DIR || './data', origin = process.env.APP_ORIGIN || 'https://lil-homie.tainer.run', allowedUser = process.env.ALLOWED_USER, send = webpush.sendNotification, now = Date.now } = {}) {
  if (!allowedUser) throw new Error('ALLOWED_USER is required.');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = join(dataDir, 'vapid.json');
  if (!existsSync(keyPath)) writeFileSync(keyPath, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600, flag: 'wx' });
  chmodSync(keyPath, 0o600);
  const keys = JSON.parse(readFileSync(keyPath, 'utf8'));
  const db = new DatabaseSync(join(dataDir, 'push.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS subscriptions (device TEXT PRIMARY KEY, owner TEXT NOT NULL, subscription TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, device TEXT NOT NULL, owner TEXT NOT NULL, scenario TEXT NOT NULL, created INTEGER NOT NULL, due INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, due);
    CREATE INDEX IF NOT EXISTS jobs_device ON jobs(device, created);
    UPDATE jobs SET status='uncertain', detail='Server restarted during sending. Check your phone before repeating.' WHERE status='sending';`);
  const statement = (sql, ...args) => db.prepare(sql).run(...args);
  const subscription = (device, owner) => db.prepare('SELECT * FROM subscriptions WHERE device=? AND owner=?').get(device, owner);
  function stop(device, owner) {
    statement('DELETE FROM subscriptions WHERE device=? AND owner=?', device, owner);
    statement("UPDATE jobs SET status='cancelled', detail='Subscription stopped.' WHERE device=? AND owner=? AND status='queued'", device, owner);
  }
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      statement('DELETE FROM jobs WHERE created < ? AND status != ?', now() - 7 * 86400000, 'sending');
      const jobs = db.prepare("SELECT * FROM jobs WHERE status='queued' AND due<=? ORDER BY due LIMIT 20").all(now());
      for (const job of jobs) {
        const sub = subscription(job.device, job.owner);
        if (!sub) { statement("UPDATE jobs SET status='cancelled',detail='Subscription stopped.' WHERE id=? AND status='queued'", job.id); continue; }
        if (!statement("UPDATE jobs SET status='sending' WHERE id=? AND status='queued'", job.id).changes) continue;
        if (now() - job.due > 5 * 60000) {
          statement("UPDATE jobs SET status='expired',detail='Server was unavailable too long. Please run another test.' WHERE id=?", job.id); continue;
        }
        try {
          await send(JSON.parse(sub.subscription), JSON.stringify({ title: 'Lil Homie', body: `${scenarios[job.scenario].title} · ${new Date(now()).toISOString().slice(11, 19)} UTC. Tap to open.`, id: job.id }), {
            TTL: 120, urgency: 'high', timeout: 10000,
            vapidDetails: { subject: origin, publicKey: keys.publicKey, privateKey: keys.privateKey },
          });
          statement("UPDATE jobs SET status='accepted',detail='Push service accepted this test. Confirm delivery on your phone.' WHERE id=?", job.id);
        } catch (e) {
          if ([404, 410].includes(e.statusCode)) {
            stop(job.device, job.owner);
            statement("UPDATE jobs SET status='invalid',detail='Subscription expired. Enable notifications again.' WHERE id=?", job.id);
          } else {
            statement("UPDATE jobs SET status='failed',detail=? WHERE id=?", e.statusCode ? `Push service returned ${Number(e.statusCode)}. Try again.` : 'Could not confirm sending. Check your phone before repeating.', job.id);
          }
        }
      }
    } finally { ticking = false; }
  }
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'], '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
    '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'],
    '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  };
  function deviceId(value) { if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value)) fail('Invalid installation identifier.'); return value; }
  async function body(req) {
    let data = ''; for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 12000) fail('Request too large.', 413); }
    try { return JSON.parse(data); } catch { fail('Invalid JSON.'); }
  }
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === '/health' && req.method === 'GET') return json(200, { ok: true });
      const user = req.headers['remote-user'];
      if (user !== allowedUser) return json(user ? 403 : 401, { error: 'Sign in with the authorized account to use Lil Homie.' });
      if (req.method === 'GET' && files[url.pathname]) {
        const [name, type] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': type }); return res.end(readFileSync(join(root, 'public', name)));
      }
      if (url.pathname === '/api/status' && req.method === 'GET') {
        const device = deviceId(url.searchParams.get('device'));
        const jobs = db.prepare('SELECT id,scenario,created,due,status,detail FROM jobs WHERE device=? AND owner=? ORDER BY created DESC,rowid DESC LIMIT 20').all(device, user);
        return json(200, { publicKey: keys.publicKey, subscribed: !!subscription(device, user), serverTime: now(), jobs });
      }
      if (req.method !== 'POST' || !['/api/subscribe', '/api/stop', '/api/test'].includes(url.pathname)) return json(404, { error: 'Not found.' });
      if (req.headers.origin !== origin || req.headers['x-lil-homie'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) fail('Request rejected. Reload the app and try again.', 403);
      const input = await body(req); const device = deviceId(input.device);
      if (url.pathname === '/api/subscribe') {
        const sub = validateSubscription(input.subscription);
        // A device identifier cannot be transferred between accounts.
        const existing = db.prepare('SELECT owner FROM subscriptions WHERE device=?').get(device);
        if (existing && existing.owner !== user) fail('Installation belongs to another account.', 403);
        statement('INSERT INTO subscriptions VALUES (?,?,?) ON CONFLICT(device) DO UPDATE SET subscription=excluded.subscription', device, user, JSON.stringify(sub));
        return json(200, { message: 'Notifications enabled for this installation.' });
      }
      if (url.pathname === '/api/stop') { stop(device, user); return json(200, { message: 'Server subscription removed and pending tests cancelled.' }); }
      if (!subscription(device, user)) fail('Enable notifications before sending a test.', 409);
      if (!Object.hasOwn(scenarios, input.scenario)) fail('Unknown test scenario.');
      const count = db.prepare('SELECT count(*) AS n FROM jobs WHERE owner=? AND created>?').get(user, now() - 60000).n;
      if (count >= 10) fail('Please wait a minute; limit is 10 tests per minute.', 429);
      const id = randomUUID(); const due = now() + scenarios[input.scenario].delay;
      statement('INSERT INTO jobs (id,device,owner,scenario,created,due,status) VALUES (?,?,?,?,?,?,?)', id, device, user, input.scenario, now(), due, 'queued');
      return json(202, { id, due, message: scenarios[input.scenario].delay ? 'Test scheduled on the server for 30 seconds from now.' : 'Test queued for sending.' });
    } catch (e) {
      if (!e.status) console.error('Request failed:', e.name);
      if (!res.headersSent) json(e.status || 500, { error: e.status ? e.message : 'Server error. Please try again.' }); else res.end();
    }
  });
  return { server, tick, db, publicKey: keys.publicKey, close: () => db.close() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const app = createApp();
  const timer = setInterval(() => app.tick().catch(e => console.error('Timer failed:', e.name)), 500);
  app.server.listen(Number(process.env.PORT || 3000), process.env.BIND_HOST || '127.0.0.1', () => console.log('Lil Homie listening'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { clearInterval(timer); app.server.close(() => process.exit(0)); });
}
