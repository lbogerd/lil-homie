self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// No fetch handler or offline API queue. Never cache login responses or private API data.
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Even malformed pushes must be visible. */ }
  const id = typeof payload.id === 'string' && /^[0-9a-f-]{36}$/.test(payload.id) ? payload.id : '';
  event.waitUntil(self.registration.showNotification('Lil Homie', {
    body: typeof payload.body === 'string' ? payload.body : 'Test notification received. Tap to open Lil Homie.',
    icon: '/icon-192.png',
    tag: id || `test-${Date.now()}`,
    data: { url: id ? `/?test=${id}` : '/' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || '/', self.location.origin);
    if (target.origin !== self.location.origin) return;
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin === target.origin && 'navigate' in client) {
        const navigated = await client.navigate(target.href);
        if (navigated) { await navigated.focus(); return; }
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
