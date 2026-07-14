/**
 * Web Push (VAPID) - notiser levereras av webbläsarens push-tjänst även när sidan
 * eller Chrome inte är i fokus/öppet. Enanvändar-app men flera enheter kan
 * prenumerera; en subscription per endpoint sparas i push_subscriptions.
 *
 * VAPID-nycklar läses ur env (VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT). Saknas de är
 * push AVSTÄNGT (isPushEnabled() = false) - in-app-toasten funkar ändå. Generera
 * nycklar med `node -e "console.log(require('web-push').generateVAPIDKeys())"`.
 */

import webpush from "web-push";
import { pool } from "./pool.ts";

const PUBLIC = process.env.VAPID_PUBLIC_KEY ?? "";
const PRIVATE = process.env.VAPID_PRIVATE_KEY ?? "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@allarop.local";

let configured = false;
if (PUBLIC && PRIVATE) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
    configured = true;
  } catch (e) {
    console.error("[push] ogiltiga VAPID-nycklar:", (e as Error).message);
  }
}

export function isPushEnabled(): boolean {
  return configured;
}

export function vapidPublicKey(): string {
  return PUBLIC;
}

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function saveSubscription(sub: PushSub): Promise<void> {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("ogiltig subscription");
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ($1,$2,$3)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth],
  );
}

export async function deleteSubscription(endpoint: string): Promise<void> {
  await pool.query(`DELETE FROM push_subscriptions WHERE endpoint=$1`, [endpoint]);
}

export interface PushPayload {
  title: string;
  body?: string | null;
  notifId?: string | number | null;
  house?: string | null;
  externalId?: string | null;
}

/**
 * Skicka en push till ALLA sparade prenumerationer. Döda endpoints (410/404) rensas.
 * Fel sväljs per prenumeration (en trasig enhet får inte stoppa de andra).
 */
export async function sendPushToAll(payload: PushPayload): Promise<number> {
  if (!configured) return 0;
  const { rows } = await pool.query<{ endpoint: string; p256dh: string; auth: string }>(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions`,
  );
  if (rows.length === 0) return 0;
  const data = JSON.stringify({
    title: payload.title,
    body: payload.body ?? "",
    notifId: payload.notifId ?? null,
    house: payload.house ?? null,
    externalId: payload.externalId ?? null,
  });
  let sent = 0;
  await Promise.all(
    rows.map(async (r) => {
      try {
        await webpush.sendNotification(
          { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
          data,
          { TTL: 3600 },
        );
        sent++;
      } catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) await deleteSubscription(r.endpoint).catch(() => {});
      }
    }),
  );
  return sent;
}
