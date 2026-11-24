// ปักไป service worker: push notifications only (no offline cache, so the app is never stale)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil((async () => {
    // already looking at this trip → the in-app toast is enough
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (d.tag !== "hello" && open.some((c) => c.visibilityState === "visible" && d.url && c.url.includes(d.url))) return;
    await self.registration.showNotification(d.title || "ปักไป", { body: d.body || "", tag: d.tag, renotify: true, icon: "/icon-192.png", badge: "/icon-192.png", data: { url: d.url || "/" } });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const hit = open.find((c) => c.url.includes(url));
    if (hit) return hit.focus();
    return self.clients.openWindow(url);
  })());
});
