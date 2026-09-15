/*
 * Nomi's service worker — reminders, and nothing else (NOTES §45).
 *
 * It shows a reminder when one arrives and opens Nomi when it is tapped. It has
 * no fetch handler and caches nothing, on purpose: the app loads exactly as it
 * did before this file existed, and there is still no offline mode (spec §5).
 *
 * Registered by src/data/reminders.ts when someone turns reminders on. An
 * iPhone delivers a push only to a Home Screen web app with a service worker,
 * and only while every push shows a notification — so every one does.
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch (e) {
    message = {};
  }
  event.waitUntil(
    self.registration.showNotification(message.title || 'Nomi', {
      body: message.body || 'Studied yet today?',
      icon: '/icon-192.png',
      // One reminder on the lock screen at a time: the evening's replaces the morning's.
      tag: 'nomi-reminder',
      data: { url: message.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
