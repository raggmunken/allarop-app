/**
 * Bevakning + notiser (enanvändar-app, ingen auth). Tre delar:
 *   - saved_searches: sparade sökningar. watchPass matchar NYA objekt (first_seen sedan
 *     senaste kollen) mot varje sökning → notis per träff (dedup via dedup_key).
 *   - watches: bevakade objekt. watchPass notifierar övergångar: slutar snart (<65 min),
 *     reservpris uppnått, avslutad (med slutbud).
 *   - notifications: in-app-klockan. Aldrig dubbletter (ON CONFLICT dedup_key DO NOTHING).
 *
 * Matchningen är MEDVETET konservativ (alla ord i titeln, ILIKE) - hellre en missad
 * kant-träff än notis-spam. Semantik/expansion används inte här.
 */

import { pool } from "./pool.ts";
import { ITEM_COLS, locationRegex } from "./repo.ts";
import { sendPushToAll } from "./push.ts";

export interface SearchParams {
  q?: string;
  house?: string[];
  category?: string;
  ort?: string;
  prisMin?: number;
  prisMax?: number;
  konkurs?: boolean;
}

export interface SavedSearch {
  id: number;
  name: string;
  params: SearchParams;
  created_at: string;
}

/* ---- Sparade sökningar ---- */

export async function listSearches(): Promise<SavedSearch[]> {
  const { rows } = await pool.query<SavedSearch>(
    `SELECT id, name, params, created_at::text FROM saved_searches ORDER BY created_at DESC`,
  );
  return rows;
}

export async function createSearch(name: string, params: SearchParams): Promise<SavedSearch> {
  const { rows } = await pool.query<SavedSearch>(
    `INSERT INTO saved_searches (name, params) VALUES ($1, $2) RETURNING id, name, params, created_at::text`,
    [name, JSON.stringify(params)],
  );
  return rows[0]!;
}

export async function deleteSearch(id: number): Promise<void> {
  await pool.query(`DELETE FROM saved_searches WHERE id=$1`, [id]);
}

/* ---- Bevakade objekt ---- */

/** Lägg till bevakning. Init-flaggor sätts efter NUVARANDE läge så man inte omedelbart
 * notifieras om något man redan ser (reserv redan uppnådd → ingen reserv-notis). */
export async function addWatch(house: string, externalId: string): Promise<void> {
  await pool.query(
    `INSERT INTO watches (house, external_id, notified_reserve, notified_ended)
     SELECT $1, $2,
            COALESCE(i.reserve_status = 'met', FALSE),
            COALESCE(i.status = 'ended', FALSE)
     FROM (SELECT 1) x
     LEFT JOIN items i ON i.house=$1 AND i.external_id=$2
     ON CONFLICT (house, external_id) DO NOTHING`,
    [house, externalId],
  );
}

export async function removeWatch(house: string, externalId: string): Promise<void> {
  await pool.query(`DELETE FROM watches WHERE house=$1 AND external_id=$2`, [house, externalId]);
}

/** Nycklar "house/external_id" för snabb stjärn-rendering i frontend. */
export async function watchedKeys(): Promise<string[]> {
  const { rows } = await pool.query<{ k: string }>(
    `SELECT house || '/' || external_id AS k FROM watches`,
  );
  return rows.map((r) => r.k);
}

/** Bevakade objekt med full kort-data (jämför-vyn). Avslutade sist, annars slutar-snart-först. */
export async function listWatchItems(): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    `SELECT ${ITEM_COLS}, w.created_at::text AS watched_at
     FROM watches w JOIN items i ON i.house=w.house AND i.external_id=w.external_id
     ORDER BY (i.status='ended'), i.ends_at ASC NULLS LAST`,
  );
  return rows;
}

/* ---- Notiser ---- */

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  house: string | null;
  external_id: string | null;
  created_at: string;
  read_at: string | null;
}

export async function listNotifications(limit = 60): Promise<{ unread: number; notifications: Notification[] }> {
  const [list, cnt] = await Promise.all([
    pool.query<Notification>(
      `SELECT id::text, kind, title, body, house, external_id, created_at::text, read_at::text
       FROM notifications ORDER BY created_at DESC LIMIT $1`,
      [limit],
    ),
    pool.query<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE read_at IS NULL`),
  ]);
  return { unread: Number(cnt.rows[0]?.n ?? 0), notifications: list.rows };
}

export async function unreadCount(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM notifications WHERE read_at IS NULL`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function markAllRead(): Promise<void> {
  await pool.query(`UPDATE notifications SET read_at=now() WHERE read_at IS NULL`);
}

/** Markera EN notis läst (klick på notis/toast). Idempotent. */
export async function markRead(id: number): Promise<void> {
  await pool.query(`UPDATE notifications SET read_at=now() WHERE id=$1 AND read_at IS NULL`, [id]);
}

async function notify(
  kind: string, title: string, body: string | null,
  house: string | null, externalId: string | null, dedupKey: string,
): Promise<boolean> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO notifications (kind, title, body, house, external_id, dedup_key)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedup_key) DO NOTHING RETURNING id::text`,
    [kind, title, body, house, externalId, dedupKey],
  );
  const fresh = (res.rowCount ?? 0) > 0;
  // Ny notis → skicka Web Push (levereras även när sidan/Chrome inte är i fokus).
  // Fel sväljs i push-lagret; ska aldrig stoppa watchPass.
  if (fresh) {
    void sendPushToAll({
      title, body, house, externalId, notifId: res.rows[0]?.id ?? null,
    }).catch(() => {});
  }
  return fresh;
}

/* ---- watchPass: körs av schemaläggaren ---- */

const escLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");

export interface WatchPassResult {
  searchMatches: number;
  itemEvents: number;
}

export async function watchPass(): Promise<WatchPassResult> {
  let searchMatches = 0;
  let itemEvents = 0;

  // 1) Sparade sökningar mot NYA objekt. Tidsfönstret [last_checked_at, nu] är exakt
  //    (nu fångas FÖRE frågan) så inget objekt hamnar mellan två pass.
  const searches = await listSearches();
  for (const s of searches) {
    const { rows: nowRow } = await pool.query<{ ts: string }>(`SELECT now()::text AS ts`);
    const upTo = nowRow[0]!.ts;
    const conds: string[] = [
      `i.status='active'`,
      `i.first_seen > ss.last_checked_at`,
      `i.first_seen <= $1`,
    ];
    const params: unknown[] = [upTo, s.id];
    let p = 3;
    const words = (s.params.q ?? "").toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    for (const w of words) { conds.push(`i.title ILIKE '%' || $${p} || '%'`); params.push(escLike(w)); p++; }
    if (s.params.house?.length) { conds.push(`i.house = ANY($${p})`); params.push(s.params.house); p++; }
    if (s.params.category) { conds.push(`(i.category = $${p} OR i.category LIKE $${p} || '/%')`); params.push(s.params.category); p++; }
    const locRe = locationRegex(s.params.ort);
    if (locRe) { conds.push(`i.location ~* $${p}`); params.push(locRe); p++; }
    if (s.params.prisMin != null) { conds.push(`COALESCE(i.total_price, i.current_bid, i.min_bid) >= $${p}`); params.push(s.params.prisMin); p++; }
    if (s.params.prisMax != null) { conds.push(`COALESCE(i.total_price, i.current_bid, i.min_bid) <= $${p}`); params.push(s.params.prisMax); p++; }
    if (s.params.konkurs) conds.push(`i.is_konkurs`);

    const { rows } = await pool.query<{ house: string; external_id: string; title: string; location: string | null }>(
      `SELECT i.house, i.external_id, i.title, i.location
       FROM items i, saved_searches ss
       WHERE ss.id = $2 AND ${conds.join(" AND ")}
       LIMIT 30`,
      params,
    );
    for (const r of rows) {
      const fresh = await notify(
        "search_match",
        `Ny träff: ${s.name}`,
        `${r.title}${r.location ? " - " + r.location : ""}`,
        r.house, r.external_id,
        `search:${s.id}:${r.house}:${r.external_id}`,
      );
      if (fresh) searchMatches++;
    }
    await pool.query(`UPDATE saved_searches SET last_checked_at=$1 WHERE id=$2`, [upTo, s.id]);
  }

  // 2) Bevakade objekt: slutar snart (<65 min).
  const ending = await pool.query<{ house: string; external_id: string; title: string; ends_at: string; bid: string | null }>(
    `SELECT w.house, w.external_id, i.title, i.ends_at::text,
            COALESCE(i.current_bid, i.min_bid)::text AS bid
     FROM watches w JOIN items i ON i.house=w.house AND i.external_id=w.external_id
     WHERE NOT w.notified_ending AND i.status='active'
       AND i.ends_at BETWEEN now() AND now() + interval '65 minutes'`,
  );
  for (const r of ending.rows) {
    if (await notify("ending_soon", `Slutar snart: ${r.title}`,
      r.bid ? `Bud just nu: ${Number(r.bid).toLocaleString("sv-SE")} kr` : null,
      r.house, r.external_id, `ending:${r.house}:${r.external_id}`)) itemEvents++;
    await pool.query(`UPDATE watches SET notified_ending=TRUE WHERE house=$1 AND external_id=$2`, [r.house, r.external_id]);
  }

  // 3) Reservpris uppnått.
  const reserve = await pool.query<{ house: string; external_id: string; title: string }>(
    `SELECT w.house, w.external_id, i.title
     FROM watches w JOIN items i ON i.house=w.house AND i.external_id=w.external_id
     WHERE NOT w.notified_reserve AND i.reserve_status = 'met'`,
  );
  for (const r of reserve.rows) {
    if (await notify("reserve_met", `Reservpris uppnått: ${r.title}`, null,
      r.house, r.external_id, `reserve:${r.house}:${r.external_id}`)) itemEvents++;
    await pool.query(`UPDATE watches SET notified_reserve=TRUE WHERE house=$1 AND external_id=$2`, [r.house, r.external_id]);
  }

  // 4) Avslutad (med slutbud).
  const ended = await pool.query<{ house: string; external_id: string; title: string; bid: string | null }>(
    `SELECT w.house, w.external_id, i.title, i.current_bid::text AS bid
     FROM watches w JOIN items i ON i.house=w.house AND i.external_id=w.external_id
     WHERE NOT w.notified_ended AND i.status = 'ended'`,
  );
  for (const r of ended.rows) {
    if (await notify("ended", `Avslutad: ${r.title}`,
      r.bid ? `Slutbud: ${Number(r.bid).toLocaleString("sv-SE")} kr` : "Inga bud",
      r.house, r.external_id, `ended:${r.house}:${r.external_id}`)) itemEvents++;
    await pool.query(`UPDATE watches SET notified_ended=TRUE WHERE house=$1 AND external_id=$2`, [r.house, r.external_id]);
  }

  return { searchMatches, itemEvents };
}
