import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { createApp, validateSubscription } from '../server.js';
const origin = 'https://lil-homie.tainer.run';
function sub() { const key = createECDH('prime256v1'); key.generateKeys(); return { endpoint: 'https://web.push.apple.com/test', keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }; }
async function fixture(t, send = async () => {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'lh-test-'));
  let time = 1800000000000;
  let app;
  async function start() { app = createApp({ dataDir, origin, allowedUser: 'lucas', send, now: () => time }); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); }
  await start();
  const device = randomUUID();
  t.after(async () => { await new Promise(r => app.server.close(r)); app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return {
    device, get app() { return app; }, advance(ms) { time += ms; },
    async restart() { await new Promise(r => app.server.close(r)); app.close(); await start(); },
    async req(path, data, headers = {}) {
      const r = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: data ? 'POST' : 'GET', headers: { 'Remote-User': 'lucas', Origin: origin, 'X-Lil-Homie': '1', 'Content-Type': 'application/json', ...headers }, body: data ? JSON.stringify({ device, ...data }) : undefined });
      return { status: r.status, body: await r.json() };
    },
    async status() { return (await this.req(`/api/status?device=${device}`)).body; },
    async subscribe() { return this.req('/api/subscribe', { subscription: sub() }); },
  };
}
test('authentication, CSRF and subscription validation deny unsafe requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.req(`/api/status?device=${f.device}`, null, { 'Remote-User': '' })).status, 401);
  assert.equal((await f.req(`/api/status?device=${f.device}`, null, { 'Remote-User': 'veerle' })).status, 403);
  assert.equal((await f.req('/api/subscribe', { subscription: sub() }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.req('/api/subscribe', { subscription: sub() }, { 'X-Lil-Homie': '' })).status, 403);
  assert.throws(() => validateSubscription({ ...sub(), endpoint: 'https://127.0.0.1/private' }));
  assert.throws(() => validateSubscription({ ...sub(), endpoint: 'https://web.push.apple.com.evil.example/x' }));
  assert.throws(() => validateSubscription({ ...sub(), keys: { auth: 'bad', p256dh: 'bad' } }));
  assert.equal((await f.req('/api/test', { scenario: 'immediate' })).status, 409);
});
test('subscription, signing keys and 30-second server job survive restart; one visible payload sent', async t => {
  const sent = []; const f = await fixture(t, async (...args) => sent.push(args));
  assert.equal((await f.subscribe()).status, 200);
  const key = f.app.publicKey;
  const scheduled = await f.req('/api/test', { scenario: 'locked' }); assert.equal(scheduled.status, 202);
  await f.app.tick(); assert.equal(sent.length, 0);
  f.advance(29000); await f.app.tick(); assert.equal(sent.length, 0);
  await f.restart(); assert.equal(f.app.publicKey, key); assert.equal((await f.status()).subscribed, true);
  f.advance(1000); await f.app.tick(); assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0][1]); assert.match(payload.body, /Locked phone/); assert.equal(payload.id, scheduled.body.id);
  assert.equal(sent[0][2].vapidDetails.publicKey, key); assert.equal(sent[0][2].TTL, 120);
  assert.equal((await f.status()).jobs[0].status, 'accepted');
  await f.app.tick(); assert.equal(sent.length, 1);
});
test('stop cancels queued jobs; re-enable permits a fresh immediate test', async t => {
  let sent = 0; const f = await fixture(t, async () => sent++);
  await f.subscribe(); await f.req('/api/test', { scenario: 'delayed' });
  assert.equal((await f.req('/api/stop', {})).status, 200);
  f.advance(30000); await f.app.tick(); assert.equal(sent, 0);
  assert.equal((await f.status()).jobs[0].status, 'cancelled'); assert.equal((await f.status()).subscribed, false);
  await f.subscribe(); await f.req('/api/test', { scenario: 'immediate' }); await f.app.tick(); assert.equal(sent, 1);
});
for (const code of [404, 410]) test(`${code} removes stale subscription and cancels other queued tests`, async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; throw { statusCode: code }; });
  await f.subscribe(); await f.req('/api/test', { scenario: 'immediate' }); await f.req('/api/test', { scenario: 'immediate' });
  await f.app.tick(); assert.equal(calls, 1);
  const s = await f.status(); assert.equal(s.subscribed, false); assert.deepEqual(s.jobs.map(j => j.status).sort(), ['cancelled', 'invalid']);
});
test('transient failure preserves subscription, and rate limit applies', async t => {
  const f = await fixture(t, async () => { throw { statusCode: 503 }; }); await f.subscribe();
  await f.req('/api/test', { scenario: 'immediate' }); await f.app.tick();
  const s = await f.status(); assert.equal(s.subscribed, true); assert.equal(s.jobs[0].status, 'failed');
  for (let i = 0; i < 9; i++) assert.equal((await f.req('/api/test', { scenario: 'delayed' })).status, 202);
  assert.equal((await f.req('/api/test', { scenario: 'delayed' })).status, 429);
});
test('interrupted send is reported as uncertain and never silently repeated', async t => {
  let sends = 0; const f = await fixture(t, async () => sends++); await f.subscribe();
  await f.req('/api/test', { scenario: 'immediate' }); f.app.db.exec("UPDATE jobs SET status='sending'");
  await f.restart(); await f.app.tick(); assert.equal(sends, 0); assert.equal((await f.status()).jobs[0].status, 'uncertain');
});
test('service worker shows valid and malformed pushes and opens or focuses the app', async () => {
  const handlers = {}, notifications = [], opened = []; let windows = [];
  const self = { location: { origin }, addEventListener: (n, h) => handlers[n] = h, registration: { showNotification: async (...args) => notifications.push(args) }, clients: { matchAll: async () => windows, openWindow: async url => opened.push(url) } };
  vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, URL, Date });
  let completion; const id = randomUUID();
  handlers.push({ data: { json: () => ({ id, body: 'Test' }) }, waitUntil: p => completion = p }); await completion;
  handlers.push({ data: { json: () => { throw Error(); } }, waitUntil: p => completion = p }); await completion;
  assert.equal(notifications.length, 2); assert.equal(notifications[0][1].data.url, `/?test=${id}`);
  let closed = false;
  const notification = { data: { url: `/?test=${id}` }, close: () => closed = true };
  handlers.notificationclick({ notification, waitUntil: p => completion = p }); await completion;
  assert.equal(closed, true); assert.deepEqual(opened, [`${origin}/?test=${id}`]);
  let focused = false, navigated;
  windows = [{ url: origin, navigate: async url => { navigated = url; return { focus: async () => focused = true }; } }];
  handlers.notificationclick({ notification, waitUntil: p => completion = p }); await completion;
  assert.equal(navigated, `${origin}/?test=${id}`); assert.equal(focused, true); assert.equal(opened.length, 1);
});
