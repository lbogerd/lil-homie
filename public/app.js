'use strict';
const $ = id => document.getElementById(id);
const titles = { immediate: 'Immediate', delayed: '30-second delay', open: 'App open', closed: 'App closed', locked: 'Phone locked', tap: 'Tap to reopen' };
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let device, registration, state, localSub, busy = false, refreshing = false;
let observations = {};
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function controls() {
  $('permission').textContent = 'Notification' in window ? Notification.permission : 'Not supported';
  $('subscription').textContent = !state ? 'Server unavailable' : state.subscribed && localSub ? 'Enabled' : state.subscribed ? 'Device disconnected' : localSub ? 'Enable to reconnect' : 'Stopped';
  $('enable').disabled = busy || !registration || !state || (iphone && !standalone);
  $('stop').disabled = busy || !registration || !state;
  $('refresh').disabled = busy;
  document.querySelectorAll('[data-scenario]').forEach(b => { b.disabled = busy || !state?.subscribed || !localSub || Notification.permission !== 'granted'; });
}
async function api(path, data) {
  const response = await fetch(path, data ? { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Lil-Homie': '1' }, body: JSON.stringify({ device, ...data }) } : { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
  if ([401, 403].includes(response.status)) $('login').hidden = false;
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Your login may have expired. Sign in / reload the app.');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  $('login').hidden = true;
  return result;
}
function renderResults() {
  const list = $('results'); list.replaceChildren();
  if (!state?.jobs.length) { const li = document.createElement('li'); li.textContent = 'No tests yet.'; list.append(li); return; }
  for (const job of state.jobs) {
    const li = document.createElement('li'), title = document.createElement('strong'), detail = document.createElement('small');
    title.textContent = `${titles[job.scenario]} · ${job.status}`;
    detail.textContent = `${new Date(job.created).toLocaleTimeString()} · ${job.id.slice(0, 8)} · ${job.status === 'queued' ? `Due ${new Date(job.due).toLocaleTimeString()}. Safe to leave the app.` : job.detail}`;
    li.append(title, detail);
    if (observations[job.id]) { const seen = document.createElement('small'); seen.textContent = `You reported seeing this notification at ${new Date(observations[job.id]).toLocaleTimeString()}.`; li.append(seen); }
    else if (['accepted', 'uncertain', 'failed'].includes(job.status)) {
      const seen = document.createElement('button'); seen.textContent = 'I saw it';
      seen.addEventListener('click', () => { observations[job.id] = Date.now(); const active = new Set(state.jobs.map(j => j.id)); observations = Object.fromEntries(Object.entries(observations).filter(([id]) => active.has(id))); localStorage.setItem('lh-observations', JSON.stringify(observations)); renderResults(); });
      li.append(seen);
    }
    list.append(li);
  }
}
async function refresh() {
  if (refreshing || !device) return;
  refreshing = true;
  try {
    const next = await api(`/api/status?device=${encodeURIComponent(device)}`);
    localSub = registration ? await registration.pushManager.getSubscription() : null;
    state = next; renderResults();
  } catch (error) { state = null; $('login').hidden = false; throw error; }
  finally { refreshing = false; controls(); }
}
async function action(work) {
  if (busy) return;
  busy = true; controls();
  try { await work(); await refresh(); }
  catch (error) { message(error.message === 'Failed to fetch' ? 'Could not reach the server. Check your connection, then sign in / reload if needed.' : error.message, true); }
  finally { busy = false; controls(); }
}
function publicKey(value) { const bytes = atob(value.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(bytes, c => c.charCodeAt(0)); }
$('enable').addEventListener('click', () => {
  // Request synchronously from the click, before any network await (required on iOS).
  if (Notification.permission === 'denied') { message('Permission is denied. In iPhone Settings → Notifications → Lil Homie, allow notifications, then return and enable again.', true); return; }
  const permission = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
  action(async () => {
    if (await permission !== 'granted') { message('Notifications were not allowed. No subscription was created. Use Test denial for recovery steps.', true); return; }
    let sub = await registration.pushManager.getSubscription();
    if (sub && !state.subscribed) { await sub.unsubscribe(); sub = null; }
    sub ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey(state.publicKey) });
    await api('/api/subscribe', { subscription: sub.toJSON() });
    message('Notifications enabled. Send a test when you’re ready.');
  });
});
$('stop').addEventListener('click', () => action(async () => {
  await api('/api/stop', {});
  const sub = await registration.pushManager.getSubscription();
  if (sub && !await sub.unsubscribe()) throw new Error('Server stopped and queued tests cancelled, but device unsubscribe did not finish. Press Stop again.');
  message('Stopped. Pending tests are cancelled. Permission stays unchanged; Enable notifications reconnects. A push already sent may still arrive.');
}));
$('refresh').addEventListener('click', () => action(async () => { await refresh(); message(`Status refreshed. Permission: ${Notification.permission}.`); }));
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => action(async () => {
  const scenario = button.dataset.scenario;
  const job = await api('/api/test', { scenario });
  const instructions = { open: ' Keep the app open.', closed: ' Close the app now and wait for the notification.', locked: ' Lock your phone now and wait for the notification.', tap: ' Leave the app now. Tap the notification to reopen it.' };
  message(job.message + (instructions[scenario] || '') + ` Test ${job.id.slice(0, 8)}.`);
})));
function guide(text) { $('guide').hidden = false; $('guide').textContent = text; $('guide').focus(); }
$('denial').addEventListener('click', () => guide('Permission denial test\n\nIf permission is “default”: press Enable notifications, then choose Don’t Allow. Confirm the page shows “denied” and test buttons are disabled.\n\nIf you already allowed it: open iPhone Settings → Notifications → Lil Homie and turn Allow Notifications off. Return and press Refresh status. This tests revocation; it is different from denying the first prompt. A fresh install may be needed for the first-prompt test.\n\nRecovery: turn Allow Notifications on in Settings, return, refresh, then press Enable notifications. The app cannot reset iOS permission or open this Settings screen for you.'));
$('stop-guide').addEventListener('click', () => guide('Stop and enable test\n\n1. Press Send in 30s.\n2. Immediately press Stop notifications.\n3. Check that the queued test says “cancelled”, then wait past its due time. It should not arrive. A test already sent cannot be recalled.\n4. Press Enable notifications again.\n5. Press Send test and confirm a new notification appears.\n\nStopping removes the subscription, not the iOS permission.'));
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) refresh().catch(e => message(e.message, true)); });
async function init() {
  $('install-status').textContent = standalone ? 'Opened as a Home Screen app.' : 'Open the installed Home Screen icon to test iPhone push.';
  try {
    device = localStorage.getItem('lh-device') || crypto.randomUUID(); localStorage.setItem('lh-device', device);
    try { observations = JSON.parse(localStorage.getItem('lh-observations') || '{}'); } catch { observations = {}; }
    if (supported && (!iphone || standalone)) {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
    }
    await refresh();
    const clicked = new URL(location.href).searchParams.get('test');
    if (clicked && /^[0-9a-f-]{36}$/.test(clicked)) message(`Notification link opened for test ${clicked.slice(0, 8)}. If you arrived by tapping it, the reopen check worked.`);
    else message(!supported ? 'Install on your iPhone Home Screen to use Web Push, or use a supported browser.' : iphone && !standalone ? 'Install first, then open the Home Screen icon.' : 'Ready. Enable notifications, then choose a test.');
  } catch (error) { message(error.message, true); }
  controls();
  setInterval(() => { if (!document.hidden && !busy) refresh().catch(e => message(e.message, true)); }, 3000);
}
init();
