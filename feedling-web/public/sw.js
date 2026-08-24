self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'feedling', body: '', url: '', image: '', actions: [], variant: '' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch (e) {
    try { data.body = event.data ? event.data.text() : ''; } catch {}
  }
  const opts = {
    body: data.body || '',
    tag: 'feedling',
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
    data: { url: data.url || '', variant: data.variant || '' },
  };
  if (data.image) opts.image = data.image;
  // Chrome Android caps at Notification.maxActions (2). Extra entries are dropped by the UA.
  if (data.actions && data.actions.length) opts.actions = data.actions;
  event.waitUntil(self.registration.showNotification(data.title || 'feedling', opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};

  // An action button answers in place — record it and stay out of the way.
  if (event.action) {
    event.waitUntil(fetch(self.registration.scope + 'api/notif-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: event.action, variant: d.variant || '', probeId: d.probeId || '', at: Date.now() }),
    }));
    return;
  }

  const target = self.registration.scope + String(d.url || '').replace(/^\//, '');
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return self.clients.openWindow(target);
  }));
});
