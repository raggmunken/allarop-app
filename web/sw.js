/* Allarop service worker - Web Push-notiser (levereras även när sidan/Chrome inte
 * är i fokus/öppet) + klick som markerar notisen läst och öppnar objektet.
 *
 * Fullskärm: OS:et (Windows Focus Assist) döljer notiser i fullskärm/spelläge - det
 * styrs av systeminställningen, inte av service workern. In-app-toasten döljs separat
 * av sidan när document.fullscreenElement är satt. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  const title = d.title || "Allarop";
  const body = d.body || "";
  const tag = d.notifId ? "allarop-" + d.notifId : undefined;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: "/favicon.png",
      badge: "/favicon.png",
      data: {
        notifId: d.notifId ?? null,
        house: d.house ?? null,
        externalId: d.externalId ?? null,
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // 1) Markera notisen läst automatiskt (fire-and-forget).
  const markRead = data.notifId
    ? fetch("/notifications/read?id=" + encodeURIComponent(data.notifId), { method: "POST" }).catch(() => {})
    : Promise.resolve();
  // 2) Öppna/fokusera appen på objektet.
  const params = new URLSearchParams();
  if (data.notifId) params.set("n", String(data.notifId));
  if (data.house) params.set("ahouse", String(data.house));
  if (data.externalId) params.set("aitem", String(data.externalId));
  const targetUrl = "/?" + params.toString();

  event.waitUntil(
    Promise.all([
      markRead,
      (async () => {
        const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const c of all) {
          if ("focus" in c) {
            c.postMessage({ type: "open-item", house: data.house, externalId: data.externalId, notifId: data.notifId });
            return c.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      })(),
    ]),
  );
});
