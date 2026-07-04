self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'feedling', body: '', url: '' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch (e) {
    try { data.body = event.data ? event.data.text() : ''; } catch {}
  }
  event.waitUntil(self.registration.showNotification(data.title || 'feedling', {
    body: data.body || '',
    tag: 'feedling',
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
    data: { url: data.url || '' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.url || '';
  const target = self.registration.scope + path.replace(/^\//, '');
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return self.clients.openWindow(target);
  }));
});
