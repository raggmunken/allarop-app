/** Upserts och frågor mot Postgres. */

import {
  NormalizedAuction,
  NormalizedBid,
  NormalizedItem,
  NormalizedMedia,
  NormalizedPart,
} from "../connectors/types.ts";
import { computeTotal, FeeModel } from "../fees/engine.ts";
import { feeModelForItem } from "../fees/rules.ts";
import { classify, classifyByText, Confidence } from "../categories/classify.ts";
import { detectConflict } from "../categories/conflict.ts";
import { houseCategoryKey } from "../categories/houseCategory.ts";
import { lexicon } from "../categories/learned.ts";
import { sekRates } from "../fx/rates.ts";
import { isComparable, ItemAttrs } from "./similar.ts";
import { cosine, decodeVec } from "../ai/embed.ts";
import type { QueryExpansion } from "../ai/search-expand.ts";
import { pool } from "./pool.ts";
import { addEnded, addInserted } from "../scheduler/indexnow.ts";

export async function upsertHouse(
  key: string,
  name: string,
  domain: string,
  feeModel: FeeModel,
): Promise<void> {
  await pool.query(
    `INSERT INTO auction_houses (key, name, domain, fee_model)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (key) DO UPDATE SET name=$2, domain=$3, fee_model=$4`,
    [key, name, domain, JSON.stringify(feeModel)],
  );
}

export async function upsertAuction(a: NormalizedAuction): Promise<void> {
  await pool.query(
    `INSERT INTO auctions (house, external_id, title, description, last_pay_date, contact, source_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (house, external_id) DO UPDATE
       SET title=$3, description=COALESCE($4, auctions.description),
           last_pay_date=$5, contact=$6, source_url=$7, last_seen=now()`,
    [a.house, a.externalId, a.title, a.description, a.lastPayDate, a.contact, a.sourceUrl],
  );
}

export async function upsertPart(p: NormalizedPart): Promise<void> {
  await pool.query(
    `INSERT INTO parts (house, external_id, auction_external_id, title, description,
                        location, category, starts_at, ends_at, status, source_url, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (house, external_id) DO UPDATE
       SET auction_external_id=$3, title=$4, description=$5, location=$6, category=$7,
           starts_at=$8, ends_at=$9, status=$10, source_url=$11, raw=$12, last_seen=now()`,
    [
      p.house, p.externalId, p.auctionExternalId, p.title, p.description,
      p.location, p.category, p.startsAt, p.endsAt, p.status, p.sourceUrl,
      p.raw ? JSON.stringify(p.raw) : null,
    ],
  );
  await upsertMedia(p.house, "part", p.externalId, p.media);
}

export async function upsertItem(
  it: NormalizedItem,
  _feeModel?: FeeModel, // löses per objekt ur (hus, valuta) nedan
): Promise<void> {
  // Avgiftsmodellen väljs per objekt: Auctionet per land via valutan.
  const feeModel = feeModelForItem(it.house, it.currency);
  // Saknas bud: basera totalen på utropspriset (minBid) så att "faktiskt
  // totalpris" alltid blir meningsfullt — inte bara avgifter på ett 0-bud.
  // Helt utan bud OCH utropspris (t.ex. Riksauktioner-objekt utan bud) → ingen
  // total (null), så vi aldrig visar avgifter på ett 0-pris.
  const bid = it.currentBid ?? it.minBid ?? 0;
  // External-hus markeras ALLTID "external" (UI: "avgift tillkommer") - även objekt helt
  // utan bud/utrop (t.ex. Budi-objekt som startar på 0 kr) → aldrig en fejkad "Att betala 0 kr".
  const total =
    bid > 0 || feeModel.kind === "external"
      ? computeTotal(
          { bid, sourceFeeValue: it.feeValue, sourceVatRate: it.vatRate },
          feeModel,
        )
      : { total: null as number | null, basis: null as string | null };
  // Normaliserad kategori: LLM-lärda lexikonet först (elev till LLM-klassaren, conf
  // 'learned'); annars nyckelord/hus-kategori som PRELIMINÄR etikett tills LLM-passet
  // hunnit ikapp. Rang-skyddet i SQL:en ser till att svagare aldrig skriver över starkare.
  await lexicon.ensureLoaded();
  const hit = it.title ? lexicon.classify(it.title) : null;
  const hc = houseCategoryKey(it.house, it.raw);
  const cat = hit
    ? { category: hit.category, confidence: "learned" }
    : classify(it.title, it.description, hc.key, hc.raw);
  const conflict = detectConflict(cat.category, cat.confidence as Confidence, hc.key);
  const res = await pool.query<{ inserted: boolean }>(
    `INSERT INTO items (house, external_id, part_external_id, auction_external_id, title,
                        description, location, status, ends_at, min_bid, current_bid,
                        bid_count, fee_value, vat_value, total_price, total_basis, source_url,
                        sort_no, showing_starts, showing_ends, showing_address,
                        collect_starts, collect_ends, collect_address,
                        freight_help, forklift_help, youtube_link, raw, currency, seller,
                        listed_at, reserve_status, reserve_price, leader_id, leader_name,
                        category, category_conf, category_conflict)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38)
     ON CONFLICT (house, external_id) DO UPDATE
       SET part_external_id=$3, auction_external_id=$4, title=$5,
           -- Beskrivning + slagavgift berikas gradvis ur objektsidan (Blinto/Klaravik
           -- m.fl.). Ett svep UTAN färsk detalj (null) får inte radera ett redan känt
           -- värde → COALESCE behåller det tills nästa berikning skriver över.
           description=COALESCE($6, items.description),
           location=$7, status=$8, ends_at=$9,
           -- Startbud/lägsta bud berikas ur objektsidan (Retrade lowestValidBid) →
           -- ett svep utan färsk detalj (null) får ej radera ett känt värde.
           min_bid=COALESCE($10, items.min_bid),
           -- Monotont: en re-upsert utan färska bud (t.ex. full refresh) får
           -- aldrig sänka ett känt bud/totalpris. Bud i en auktion går uppåt.
           current_bid=GREATEST(items.current_bid, EXCLUDED.current_bid),
           bid_count=GREATEST(items.bid_count, EXCLUDED.bid_count),
           fee_value=COALESCE($13, items.fee_value), vat_value=$14,
           total_price=GREATEST(items.total_price, EXCLUDED.total_price),
           -- Basis sticky: ett svep utan beräkningsbar total (null) får ej nolla
           -- ett känt "external" (Retrade) → behåll så UI:t fortsatt visar "avgift tillkommer".
           -- "external" är SVAGAST: ett avgiftslöst svep (t.ex. Junora utan färsk detalj →
           -- external-fallback) får INTE nedgradera en redan beräknad estimate/source/percentage.
           total_basis=CASE WHEN $16='external' THEN COALESCE(items.total_basis, $16) ELSE COALESCE($16, items.total_basis) END,
           source_url=$17,
           sort_no=$18, showing_starts=$19, showing_ends=$20, showing_address=$21,
           collect_starts=$22, collect_ends=$23, collect_address=$24,
           freight_help=$25, forklift_help=$26, youtube_link=$27, raw=$28,
           currency=$29, seller=COALESCE($30, items.seller),
           listed_at=COALESCE(EXCLUDED.listed_at, items.listed_at),
           -- Reserv-status/värde berikas ur detalj (Junora-värdet) → COALESCE behåller
           -- känt värde om ett svep saknar det.
           reserve_status=COALESCE($32, items.reserve_status),
           reserve_price=COALESCE($33, items.reserve_price),
           -- Budledare kan komma DIREKT på objektet (Pantbanken) eller via upsertBids
           -- (Tovek m.fl.). COALESCE så ett svep utan ledare (null) ej raderar en känd.
           leader_id=COALESCE($34, items.leader_id),
           leader_name=COALESCE($35, items.leader_name),
           -- Kategori räknas om vid varje upsert, MEN svagare konfidens får ALDRIG
           -- nedgradera starkare (cat_conf_rank: llm > learned > house > text > mixed >
           -- none). Skyddar både LLM-beslut och fallet där payload-beskrivningen är null
           -- i svep efter berikningen (loadEnriched-skip) → 'none' skrev annars över.
           category=CASE WHEN cat_conf_rank(items.category_conf) > cat_conf_rank($37)
                         THEN items.category ELSE $36 END,
           category_conf=CASE WHEN cat_conf_rank(items.category_conf) > cat_conf_rank($37)
                              THEN items.category_conf ELSE $37 END,
           category_conflict=CASE WHEN cat_conf_rank(items.category_conf) > cat_conf_rank($37)
                                   THEN items.category_conflict ELSE $38 END,
           last_seen=now()
     -- xmax=0-tricket: vid ON CONFLICT-update sätts radens xmax (låsmarkör),
     -- vid ren INSERT är den 0 → inserted=true bara när objektet är HELT nytt.
     RETURNING (xmax = 0) AS inserted`,
    [
      it.house, it.externalId, it.partExternalId, it.auctionExternalId, it.title,
      it.description, it.location, it.status, it.endsAt, it.minBid, it.currentBid,
      it.bidCount ?? null, it.feeValue, it.vatRate, total.total, total.basis, it.sourceUrl,
      it.sortNo ?? null, it.showingStarts, it.showingEnds, it.showingAddress,
      it.collectStarts, it.collectEnds, it.collectAddress,
      it.freightHelp, it.forkliftHelp, it.youtubeLink,
      it.raw ? JSON.stringify(it.raw) : null, it.currency ?? "SEK", it.seller ?? null,
      it.listedAt ?? null, it.reserveStatus ?? null, it.reservePrice ?? null,
      it.leaderId ?? null, it.leaderName ?? null,
      cat.category, cat.confidence, conflict,
    ],
  );
  // Riktig INSERT (inte en ON CONFLICT-update) → objektet är NYTT → buffra för
  // IndexNow-ping (samlade pingar skickas av flush() i slutet av ingest-svepet).
  if (res.rows[0]?.inserted) addInserted(it.house, it.externalId);
  await upsertMedia(it.house, "item", it.externalId, it.media);
}

export async function upsertMedia(
  house: string,
  ownerType: "part" | "item",
  ownerExternalId: string,
  media: NormalizedMedia[],
): Promise<void> {
  // Tomt = ingen ny info (t.ex. ett tillfälligt scrape-fel) - rör INTE befintliga rader.
  // Skulle annars kunna radera en redan sparad galleri om ett enskilt pollvarv misslyckas.
  if (!media.length) return;
  // Ta bort rader som inte längre finns i den nya listan - t.ex. en Typesense-s=list-
  // platshållare (Vaxxa) som ska ERSÄTTAS av s=full-galleriet vid berikning. UPSERT nedan
  // lägger bara till/uppdaterar, aldrig bort, så platshållaren låg annars kvar för alltid
  // och visades i detaljvyn som "samma bild" bredvid de riktiga (bekräftat 2026-07-29).
  await pool.query(
    `DELETE FROM media WHERE house=$1 AND owner_type=$2 AND owner_external_id=$3
       AND NOT (url = ANY($4::text[]))`,
    [house, ownerType, ownerExternalId, media.map((m) => m.url)],
  );
  for (const m of media) {
    await pool.query(
      `INSERT INTO media (house, owner_type, owner_external_id, kind, url, sort)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (house, owner_type, owner_external_id, url) DO UPDATE SET sort=$6`,
      [house, ownerType, ownerExternalId, m.kind, m.url, m.sort],
    );
  }
}

/** Spara bud och uppdatera objektets aktuella bud/antal. */
export async function upsertBids(
  itemExternalId: string,
  house: string,
  bids: NormalizedBid[],
): Promise<void> {
  for (const b of bids) {
    await pool.query(
      `INSERT INTO bids (house, external_id, item_external_id, value, type, bidder_id, bidder_name, created_at, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (house, external_id) DO UPDATE
         SET bidder_id=EXCLUDED.bidder_id, bidder_name=EXCLUDED.bidder_name, raw=EXCLUDED.raw`,
      [
        b.house, b.externalId, b.itemExternalId, b.value, b.type, b.bidderId, b.bidderName,
        b.createdAt, b.raw ? JSON.stringify(b.raw) : null,
      ],
    );
  }
  if (bids.length > 0) {
    const top = Math.max(...bids.map((b) => b.value));
    const leader = bids.find((b) => b.value === top);
    // Hämta lagrad avgift/moms och räkna om faktiskt totalpris med nya budet.
    const cur = await pool.query<{
      fee_value: string | null;
      vat_value: string | null;
      currency: string | null;
    }>(
      `SELECT fee_value, vat_value, currency FROM items WHERE house=$1 AND external_id=$2`,
      [house, itemExternalId],
    );
    const row = cur.rows[0];
    const total = computeTotal(
      {
        bid: top,
        sourceFeeValue: row?.fee_value != null ? Number(row.fee_value) : null,
        sourceVatRate: row?.vat_value != null ? Number(row.vat_value) : null,
      },
      feeModelForItem(house, row?.currency),
    );
    await pool.query(
      `UPDATE items SET current_bid=$1, bid_count=$2, total_price=$3, total_basis=$4,
              leader_id=$5, leader_name=$6, last_seen=now()
       WHERE house=$7 AND external_id=$8`,
      [
        top, bids.length, total.total, total.basis,
        leader?.bidderId ?? null, leader?.bidderName ?? null,
        house, itemExternalId,
      ],
    );
  }
}

export interface SearchRow {
  house: string;
  external_id: string;
  title: string;
  location: string | null;
  status: string | null;
  ends_at: Date | null;
  min_bid: string | null;
  current_bid: string | null;
  total_price: string | null;
  leader_name: string | null;
  source_url: string | null;
  image: string | null;
  currency: string | null;
  seller: string | null;
  last_seen: Date | null;
  reserve_status: string | null;
  reserve_price: string | null;
  est_value_sek: string | null;
  est_count: number | null;
  fynd_pct: string | null;
  lat: number | null;
  lon: number | null;
}

/** Gemensam SELECT med thumbnail (första bilden) för list-/sökvyer. */
/** Valuta → SEK-multiplikator (ungefärlig; räcker för sortering/fynd-tröskel). */
const FX_CASE = `CASE i.currency
    WHEN 'GBP' THEN 12.8 WHEN 'EUR' THEN 11.1 WHEN 'DKK' THEN 1.48
    WHEN 'USD' THEN 9.7 WHEN 'NOK' THEN 0.98 WHEN 'CHF' THEN 12 ELSE 1 END`;
/** Objektets nuvarande pris (bud, annars utrop/startbud) i SEK. */
const CUR_SEK = `(COALESCE(i.current_bid, i.min_bid) * ${FX_CASE})`;
/**
 * Fynd flaggas BARA nära avslut - annars är "nuvarande pris << värde" bara ett lågt
 * öppningsbud på en auktion som just startat (UK-smycken på 25 GBP → stiger garanterat).
 * Nära avslut ligger priset nära slutpriset → då är avvikelsen ett verkligt fynd.
 */
const FYND_WINDOW_H = Number(process.env.FYND_WINDOW_H ?? 48);
/** Max p75/p25 för att uppskattningen ska anses tillförlitlig. Hög spridning = comparables
 * är oeniga (smycken/konst/skrot varierar enormt inom samma titel) → uppskattningen går
 * inte att lita på → INGET fynd flaggas (hellre inget än fel). */
const FYND_MAX_SPREAD = Number(process.env.FYND_MAX_SPREAD ?? 2.5);
/**
 * FYND-procent: hur långt UNDER uppskattat slutvärde priset ligger. Krav (alla):
 *  - solid uppskattning (est_count >= 4) med TÄT spridning (p75/p25 <= FYND_MAX_SPREAD),
 *  - nuvarande pris under 25:e percentilen (billigare än ~75 % av jämförbara sålda),
 *  - slutar inom fönstret (priset nära sitt slutläge - inte ett lågt öppningsbud).
 * NULL = inte ett fynd. Procenten räknas mot medianen (för visning).
 */
const FYND_PCT = `CASE
    WHEN i.est_count >= 4 AND i.est_value_sek > 0 AND i.est_p25 > 0
      AND i.est_p75 <= i.est_p25 * ${FYND_MAX_SPREAD}
      AND ${CUR_SEK} > 0 AND ${CUR_SEK} < i.est_p25
      AND i.ends_at IS NOT NULL AND i.ends_at <= now() + interval '${FYND_WINDOW_H} hours'
    THEN round((i.est_value_sek - ${CUR_SEK})::numeric / i.est_value_sek * 100)
    ELSE NULL END`;

// Normaliserad ort (matchar geocode.query) - strippa postnr, del före komma, gemener.
const NORM_LOC = `lower(trim(split_part(regexp_replace(coalesce(i.location,''),'^[0-9 ]+',''),',',1)))`;
// Skick ur beskrivningen (badge på kortet): 'ny' = ny/oanvänd, 'otestad' = säljaren har ej
// testat. \M = ordslut (ARE) så "oanvändbar" INTE matchar "oanvänd". Bara för sidans rader
// (deferred projection) → regexen körs på ~48 beskrivningar, inte hela tabellen.
const COND_CASE = `CASE
    WHEN i.description ~* '(ny/oanvänd|oanvänd\\M|oanvänt\\M|oanvända\\M|ny i (kartong|förpackning|obruten)|nyskick)' THEN 'ny'
    WHEN i.description ~* '(ej testa[dt]|otestad|ej funktionstestad|ej provkörd)' THEN 'otestad'
    ELSE NULL END`;
export const ITEM_COLS = `i.house, i.external_id, i.title, i.location, i.status, i.ends_at,
         i.min_bid, i.current_bid, i.total_price, i.total_basis, i.leader_name, i.source_url,
         i.currency, i.seller, i.last_seen, i.reserve_status, i.reserve_price, i.category,
         i.est_value_sek, i.est_count, ${FYND_PCT} AS fynd_pct, i.bid_count,
         ${COND_CASE} AS cond,
         (SELECT m.url FROM media m
          WHERE m.house=i.house AND m.owner_type='item'
            AND m.owner_external_id=i.external_id AND m.kind='image'
          ORDER BY m.sort LIMIT 1) AS image,
         (SELECT g.lat FROM geocode g WHERE g.query=${NORM_LOC}) AS lat,
         (SELECT g.lon FROM geocode g WHERE g.query=${NORM_LOC}) AS lon`;
const ITEM_SELECT = `SELECT ${ITEM_COLS} FROM items i`;

/**
 * Enkel fuzzy-sök för v0: trigram-likhet på titel + ILIKE-fallback.
 * (Synonym/böjning/särskrivning kommer i Fas 2.)
 */
/** SQL-villkor: aktivt objekt (status active och inte passerat sluttiden). */
const ACTIVE_BASE = `(i.status='active' AND (i.ends_at IS NULL OR i.ends_at > now()))`;

/**
 * Hus-döljning (admin): hus i settings.hidden_houses (JSON-array) exkluderas från ALLA
 * aktiva frågor (listActive/search/houses/kategorier/orter) → de syns inte i UI:t men
 * datan ligger kvar (krypet fortsätter; döljningen är reversibel). ACTIVE_COND är en
 * let som refreshHiddenHouses() räknar om - alla frågor interpolerar den vid anropstillfället.
 */
let ACTIVE_COND = ACTIVE_BASE;
let hiddenCache: { keys: string[]; at: number } = { keys: [], at: 0 };
const HIDDEN_TTL_MS = 30_000;

/** Dolda hus (cache 30 s; ogiltigförklaras direkt vid admin-ändring via invalidateHidden). */
export async function getHiddenHouses(): Promise<string[]> {
  if (Date.now() - hiddenCache.at < HIDDEN_TTL_MS) return hiddenCache.keys;
  try {
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM settings WHERE key='hidden_houses'`,
    );
    const v = rows[0]?.value;
    hiddenCache = { keys: v ? (JSON.parse(v) as string[]) : [], at: Date.now() };
  } catch {
    hiddenCache = { keys: [], at: Date.now() }; // settings saknas/gammal DB → dölj inget
  }
  applyHidden(hiddenCache.keys);
  return hiddenCache.keys;
}

function applyHidden(keys: string[]): void {
  if (!keys.length) { ACTIVE_COND = ACTIVE_BASE; return; }
  const quoted = keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(",");
  ACTIVE_COND = `${ACTIVE_BASE} AND i.house NOT IN (${quoted})`;
}

/** Anropas av admin-endpointen efter ändring → slår igenom direkt (inte efter TTL). */
export function invalidateHidden(): void {
  hiddenCache.at = 0;
}

/** Sätt dolda hus (admin). Skriver settings + uppdaterar ACTIVE_COND direkt. */
export async function setHiddenHouses(keys: string[]): Promise<void> {
  const clean = [...new Set(keys.map((k) => String(k).trim()).filter((k) => /^[a-z0-9]+$/.test(k)))];
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('hidden_houses',$1,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify(clean)],
  );
  hiddenCache = { keys: clean, at: Date.now() };
  applyHidden(clean);
}

/**
 * Totalpris normaliserat till SEK för korrekt prissortering över valutor.
 * Ungefärliga kurser räcker för SORTERING (ordningen ändras inte av småfel).
 */
const SEK_NORM = `(i.total_price * CASE i.currency
    WHEN 'GBP' THEN 12.8 WHEN 'EUR' THEN 11.1 WHEN 'DKK' THEN 1.48
    WHEN 'USD' THEN 9.7 WHEN 'NOK' THEN 0.98 WHEN 'CHF' THEN 12 ELSE 1 END)`;

export type SortKey =
  | "ending"
  | "newest"
  | "price_high"
  | "price_low"
  | "bids"
  | "fewest"
  | "fynd";

/** ORDER BY-uttryck per sorteringsval (relevans hanteras separat i searchItems). */
function orderByClause(sort: SortKey | undefined, includeEnded: boolean): string {
  switch (sort) {
    case "newest":
      // listed_at är timestamp UTAN tz; tolka som UTC (fast zon = immutable → indexerbart,
      // matchar items_active_newest_idx). first_seen är redan timestamptz.
      return "COALESCE(i.listed_at AT TIME ZONE 'UTC', i.first_seen) DESC NULLS LAST";
    case "price_high":
      return `${SEK_NORM} DESC NULLS LAST`;
    case "price_low":
      return `${SEK_NORM} ASC NULLS LAST`;
    case "bids":
      return "i.bid_count DESC NULLS LAST, i.ends_at ASC NULLS LAST";
    case "fewest":
      // Minst bud först (minst konkurrens) — 0-bud överst, sedan slutar-snart.
      return "i.bid_count ASC NULLS LAST, i.ends_at ASC NULLS LAST";
    case "fynd":
      // Störst rabatt mot uppskattat slutvärde först; vid lika, slutar-snart (mest akut).
      return "fynd_pct DESC NULLS LAST, i.ends_at ASC NULLS LAST";
    case "ending":
    default:
      return includeEnded ? "i.ends_at DESC NULLS LAST" : "i.ends_at ASC NULLS LAST";
  }
}

export interface ListOpts {
  limit?: number;
  offset?: number;
  /** Ett hus, flera hus (fler-val) eller utelämnat (alla). */
  house?: string | string[];
  seller?: string;
  includeEnded?: boolean;
  sort?: SortKey;
  /** Filtrera på reservationspris-status: "met"/"not_met"/"none" (eller utelämnat = alla). */
  reserve?: "met" | "not_met" | "none";
  /** Kategori: huvudnyckel ("fordon") = alla underkategorier, eller "huvud/under" exakt. */
  category?: string;
  /** Prisintervall (kr) på total/bud/utrop. */
  priceMin?: number;
  priceMax?: number;
  /** Slutar före denna tidpunkt (ISO) - för "slutar snart". */
  endsBefore?: string;
  /** Ort/plats (delsträng). */
  location?: string;
  /** Bara fynd: objekt vars nuvarande pris ligger minst så här många % under uppskattat värde. */
  fyndMin?: number;
  /** Bara konkurs-/likvidationsauktioner (items.is_konkurs). */
  konkurs?: boolean;
  /** Skick-filter ur beskrivningen: "ny" (ny/oanvänd) eller "otestad" (säljaren ej testat). */
  skick?: "ny" | "otestad";
  /** Geografiskt polygon-filter: [[lon,lat],...] - bara objekt inom polygonen (punkt-i-polygon). */
  polygon?: [number, number][];
}

/** SQL-villkor för konkurs-filtret (härlett ur boolean → ingen injektionsrisk, inget param). */
function konkursCond(o: ListOpts): string {
  return o.konkurs ? "i.is_konkurs" : "TRUE";
}

/** Skick-filter (härlett ur enum-vitlista → ingen injektionsrisk). ILIKE-delen träffar
 * trigram-indexet (items_desc_trgm) som kandidat-gate; regexen förfinar (\M-ordslut så
 * "oanvändbar" inte matchar). Samma mönster som COND_CASE-badgen. */
function skickCond(o: ListOpts): string {
  if (o.skick === "ny") {
    return `((i.description ILIKE '%oanvänd%' OR i.description ILIKE '%ny i kartong%' OR i.description ILIKE '%ny i förpackning%' OR i.description ILIKE '%nyskick%')
      AND i.description ~* '(ny/oanvänd|oanvänd\\M|oanvänt\\M|oanvända\\M|ny i (kartong|förpackning|obruten)|nyskick)')`;
  }
  if (o.skick === "otestad") {
    return `((i.description ILIKE '%testa%' OR i.description ILIKE '%otestad%' OR i.description ILIKE '%provkörd%')
      AND i.description ~* '(ej testa[dt]|otestad|ej funktionstestad|ej provkörd)')`;
  }
  return "TRUE";
}

/** WHERE-fragment för kategori/pris/sluttid/ort, delat av båda queries. `p` = startparam-nr. */
function extraFilters(p: number): string {
  return `AND ($${p}::text IS NULL OR i.category = $${p} OR i.category LIKE $${p} || '/%')
       AND ($${p + 1}::bigint IS NULL OR COALESCE(i.total_price, i.current_bid, i.min_bid) >= $${p + 1})
       AND ($${p + 2}::bigint IS NULL OR COALESCE(i.total_price, i.current_bid, i.min_bid) <= $${p + 2})
       AND ($${p + 3}::timestamptz IS NULL OR i.ends_at <= $${p + 3})
       AND ($${p + 4}::text IS NULL OR i.location ~* $${p + 4})
       AND ($${p + 5}::int IS NULL OR ${FYND_PCT} >= $${p + 5})`;
}
function extraParams(o: ListOpts): unknown[] {
  return [o.category ?? null, o.priceMin ?? null, o.priceMax ?? null, o.endsBefore ?? null, locationRegex(o.location), o.fyndMin ?? null];
}

/** Normalisera house-filtret till en text[]-array eller null (= alla hus). */
function houseArray(house?: string | string[]): string[] | null {
  if (house == null) return null;
  const arr = (Array.isArray(house) ? house : [house]).filter(Boolean);
  return arr.length ? arr : null;
}

/** Term-lista → PG-regex med ordstart-gräns: "\m(?:ho|vask)" (specialtecken escapade). */
function termsRegex(terms: string[] | undefined): string | null {
  const esc = (terms ?? [])
    .map((t) => t.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter((t) => t.length >= 2);
  return esc.length ? `\\m(?:${esc.join("|")})` : null;
}

/**
 * Sök med SMART NIVÅRANKNING (opts.expansion från LLM-sökexpansionen):
 *   nivå 1 = ordet finns i titeln (exakt delsträng - även i sammansättningar)
 *   nivå 2 = ordet finns i BESKRIVNINGEN, synonym ("diskho" → ho/vask/diskbänk)
 *            ELLER fuzzy/stavfel (trigram).
 *            OBS STRICT_word_similarity: vanliga word_similarity är suffix-kär på
 *            svenska ("dykning" ≈ "förpackning" 0,625!) - strict jämför hela ord och
 *            skiljer äkta (böjning 0,6/stavfel 0,45/sammansättning 0,4) från brus (0,25).
 *   nivå 3 = relaterade föremål ("dykning" → våtdräkt, cyklop, regulator)
 * Expansionens KATEGORIER matchar medvetet INTE (hela Kläder för "dykning" pga våtdräkt
 * = översvämning) - de exponeras i API-svaret som klickbara filterförslag i stället.
 * Utan expansion → nivå 1+2 (= gamla beteendet, med stramare fuzzy).
 */
export async function searchItems(
  q: string,
  opts: ListOpts & { expansion?: QueryExpansion | null } = {},
): Promise<SearchRow[]> {
  await getHiddenHouses(); // färsk ACTIVE_COND (dolda hus slås ut här)
  const { limit = 50, offset = 0, house, seller, includeEnded = false, sort, reserve } = opts;
  const synRe = termsRegex(opts.expansion?.synonyms);
  const relRe = termsRegex(opts.expansion?.related);
  // Flerords-fråga → kräv ALLA ord i titeln för hög rank ("ram minne" ska ge RAM-minne,
  // inte minnestallrikar/tavelramar som bara har ETT av orden). Enordsfråga → null (nivå
  // sammanfaller med exakt-fras). $16 = ordlistan, null om ≤1 ord.
  // Ord ur frågan, regex-escapade för ordgräns-matchning (\m = ordstart). ORDGRÄNS, inte
  // delsträng: "ram" ska matcha "RAM-minne" men INTE "framför"/"program"/"keramik".
  const words = q.toLowerCase().replace(/\s+/g, " ").trim().split(" ")
    .filter((w) => w.length >= 2)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const wordsParam = words.length > 1 ? words : null;
  // Råa (ILIKE-säkra) ord för INDEX-vänligt kandidaturval av flerords-frågor: `title ILIKE
  // '%guld%' AND title ILIKE '%ring%'` använder trigram-GIN per ord (BitmapAnd). tierAllWords
  // (NOT EXISTS-regex, ordgräns) besegrar index → seq scan över 57k → sekunder för multi-word.
  // ILIKE-versionen i URVALET (delsträng, snabb), ordgräns-versionen i RANK (precis tier 2).
  const rawWords = wordsParam
    ? q.toLowerCase().replace(/\s+/g, " ").trim().split(" ").filter((x) => x.length >= 2).map((w) => w.replace(/[%_\\]/g, "\\$&"))
    : [];
  const allWordsWhere = rawWords.length > 1
    ? "(" + rawWords.map((_, i) => `i.title ILIKE '%'||$${17 + i}||'%'`).join(" AND ") + ")"
    : "FALSE";
  const tier1 = `i.title ILIKE '%'||$1||'%'`;
  // ALLA sökord finns i titeln som ORD (ordstart-gräns) - stark relevans strax under
  // exakt-fras, ovanför beskrivnings-/luddträffar. Fixar "ram minne" → RAM-minne (inte
  // minnestallrikar/tavelramar som bara har ETT ord, eller "framför" som har "ram" inbäddat).
  const tierAllWords = `($16::text[] IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unnest($16::text[]) w WHERE i.title !~* ('\\m'||w)))`;
  // Exakt textträff i beskrivning ELLER bild-OCR: söktermen står bokstavligen på/om
  // objektet (t.ex. modellkod "TF-16" avläst på verktyget) → starkare än luddig
  // titellikhet, egen nivå OVANFÖR den (annars begravs OCR-träffar med olik titel).
  const tierText = `(i.description ILIKE '%'||$1||'%' OR i.ocr_text ILIKE '%'||$1||'%')`;
  // Luddmatchning: enordsfråga → trigram/stavfel-tolerans (böjning/stavfel av DET ordet).
  // Flerordsfråga → BARA synonymer, INTE trigram - annars belönar strict_word_similarity
  // en match på ETT av orden ("minne" i minnestallrik) fast det andra ("ram") saknas
  // ("ram minne" → minnestallrikar). Flerords-relevans sköts av fras + alla-ord + synonymer.
  // PRESTANDA: candidate-URVAL + rank/order får INTE innehålla similarity()/strict_word_
  // similarity() - de kan ej använda trigram-index och tvingar Filter/sort över ~57k rader
  // (~4s). Bara index-vänligt (ILIKE + regex ~* via trigram-GIN på title/desc/ocr). Nivåerna
  // + slutar-snart ger ordningen. Fuzzy-tier = synonym-regex (böjning fångas av ILIKE-delsträng).
  const tierFuzzyWhere = `($8::text IS NOT NULL AND i.title ~* $8)`;
  const rank = `CASE WHEN ${tier1} THEN 1 WHEN ${tierAllWords} THEN 2 WHEN ${tierText} THEN 3 WHEN ${tierFuzzyWhere} THEN 4 ELSE 5 END`;
  // Nivå först alltid; inom nivån vald sortering, annars slutar-snart. Deferred projection
  // (se hybridSearch): ranka lätt → LIMIT → ITEM_COLS bara för sidan (annars bild-subquery
  // per kandidat).
  const orderTop = sort
    ? `rk, ${orderByClause(sort, includeEnded)}`
    : `rk, i.ends_at ASC NULLS LAST`;
  const orderOuter = sort
    ? `t.rk, ${orderByClause(sort, includeEnded)}`
    : `t.rk, i.ends_at ASC NULLS LAST`;
  const res = await pool.query<SearchRow>(
    `WITH top AS (
       SELECT i.house, i.external_id, ${rank} AS rk, ${FYND_PCT} AS fynd_pct
       FROM items i
       -- Relaterat-expansionen ($9) matchar EJ i resultaten längre: för brett (drog in hela
       -- kategorier, t.ex. "guld ring" → alla smycken/klockor, 2299 rader/2s) och numera
       -- överflödig - semantiken (e5) gör "relaterat via mening" precist. Relaterat visas
       -- i stället som KLICKBARA förslags-chips. Kvar i urvalet: fras/alla-ord/text/synonym.
       WHERE (${tier1}
          OR ${allWordsWhere}
          OR ${tierText}
          OR ${tierFuzzyWhere}
          OR ($9::text IS NOT NULL AND false)) -- relaterat avstängt; typar bara $9 (relRe)
         AND ($3::text[] IS NULL OR i.house = ANY($3))
         AND ($4::bool OR ${ACTIVE_COND})
         AND ($5::text IS NULL OR i.seller = $5)
         AND ($7::text IS NULL OR i.reserve_status = $7)
         AND ${konkursCond(opts)}
       AND ${skickCond(opts)}
         ${extraFilters(10)}
       ORDER BY ${orderTop}
       LIMIT $2 OFFSET $6
     )
     SELECT ${ITEM_COLS}
     FROM top t JOIN items i ON i.house = t.house AND i.external_id = t.external_id
     ORDER BY ${orderOuter}`,
    [
      q, limit, houseArray(house), includeEnded, seller ?? null, offset, reserve ?? null,
      synRe, relRe, ...extraParams(opts), wordsParam, ...rawWords,
    ],
  );
  return res.rows;
}

// RRF-fusion (Reciprocal Rank Fusion, Cormack 2009): score = Σ vikt/(K0 + rank) över
// varje rankningslista. K0 dämpar toppens dominans. Lexikal väger tyngre än semantisk så
// exakta ord-/frasträffar behåller överläget; semantiken lyfter mening + fyller på recall.
const RRF_K0 = Number(process.env.SEARCH_RRF_K0 ?? 60);
const RRF_LEX_W = Number(process.env.SEARCH_LEX_WEIGHT ?? 1.0);
const RRF_SEM_W = Number(process.env.SEARCH_SEM_WEIGHT ?? 0.5);

/**
 * HYBRID-sök: fuserar den lexikala nivårankningen (trigram/ord/OCR, se searchItems) med
 * SEMANTISK likhet (e5-text-embeddings via text-index.ts, skickas in som `semantic` =
 * objekt sorterade mest-lika-först) med RRF. Vinsten: söken förstår MENING - "ram minne"
 * hittar "arbetsminne DDR4" fast orden skiljer - och semantiska träffar som lexikalt
 * missas kommer med (recall). Utan semantiska träffar (sidecar nere/tomt index) blir det
 * exakt den lexikala söken. Vald sortering respekteras; annars RRF-relevans.
 */
export async function hybridSearch(
  q: string,
  opts: ListOpts & {
    expansion?: QueryExpansion | null;
    semantic?: { house: string; external_id: string }[];
  } = {},
): Promise<SearchRow[]> {
  await getHiddenHouses(); // färsk ACTIVE_COND (dolda hus slås ut här)
  const { limit = 50, offset = 0, house, seller, includeEnded = false, sort, reserve } = opts;
  const sem = opts.semantic ?? [];
  // Ingen semantik → kör den beprövade lexikala söken oförändrad (ren fallback).
  if (sem.length === 0) return searchItems(q, opts);

  const synRe = termsRegex(opts.expansion?.synonyms);
  const relRe = termsRegex(opts.expansion?.related);
  const words = q.toLowerCase().replace(/\s+/g, " ").trim().split(" ")
    .filter((w) => w.length >= 2)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const wordsParam = words.length > 1 ? words : null;
  // Råa ILIKE-säkra ord för INDEX-vänligt flerords-urval (se searchItems); rawWords blir
  // $20+ (efter lexCand=$19). tierAllWords (ordgräns) behålls i RANK för precis tier 2.
  const rawWords = wordsParam
    ? q.toLowerCase().replace(/\s+/g, " ").trim().split(" ").filter((x) => x.length >= 2).map((w) => w.replace(/[%_\\]/g, "\\$&"))
    : [];
  const allWordsWhere = rawWords.length > 1
    ? "(" + rawWords.map((_, i) => `i.title ILIKE '%'||$${20 + i}||'%'`).join(" AND ") + ")"
    : "FALSE";
  // Lexikala nivåer - IDENTISKA med searchItems (param-nr omnumrerade): fras > alla-ord >
  // text/OCR > ludd > relaterat. $1=q, $8=synonym-regex, $9=relaterat-regex, $10=ordlista.
  const tier1 = `i.title ILIKE '%'||$1||'%'`;
  const tierAllWords = `($10::text[] IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unnest($10::text[]) w WHERE i.title !~* ('\\m'||w)))`;
  const tierText = `(i.description ILIKE '%'||$1||'%' OR i.ocr_text ILIKE '%'||$1||'%')`;
  // PRESTANDA (se searchItems): candidate-URVAL + rank/order får INTE innehålla similarity()
  // - tvingar Filter/sort över ~57k rader (~4s). Bara index-vänligt (ILIKE + regex ~* via
  // trigram-GIN). Fuzzy-tier = synonym-regex; böjning fångas av ILIKE-delsträng.
  const tierFuzzyWhere = `($8::text IS NOT NULL AND i.title ~* $8)`;
  // Relaterat-expansionen ($9) matchar EJ längre i resultaten (för brett + överflödig pga
  // semantiken) - visas som klickbara förslags-chips. $9 (relRe) passas men refereras ej.
  // Rank + ordning använder tierFuzzyWhere (regex, ej similarity) → INGEN similarity() i
  // hot-path. Similarity-tiebreakern slopad: den beräknades över hela kandidatmängden (~21k
  // rader för breda expansioner) → sekunder. Nivåer + RRF + semantik ger relevansen ändå.
  const rank = `CASE WHEN ${tier1} THEN 1 WHEN ${tierAllWords} THEN 2 WHEN ${tierText} THEN 3 WHEN ${tierFuzzyWhere} THEN 4 ELSE 5 END`;
  const relOrder = `${rank}, i.ends_at ASC NULLS LAST`;
  // Filter (hus/aktiv/säljare/reserv + kategori/pris/sluttid/ort/fynd) - delas av lex-CTE
  // och slutfiltret (så semantiska-bara-träffar också måste passera användarens filter).
  const filterBlock = `($4::text[] IS NULL OR i.house = ANY($4))
       AND ($5::bool OR ${ACTIVE_COND})
       AND ($6::text IS NULL OR i.seller = $6)
       AND ($7::text IS NULL OR i.reserve_status = $7)
       AND ${konkursCond(opts)}
       AND ${skickCond(opts)}
       ${extraFilters(13)}`;
  // Lexikalt kandidatdjup: räcker för att täcka den begärda sidan (djup paginering =
  // lexikal); semantiken påverkar främst huvudet.
  const lexCand = offset + limit + 400;
  // KRITISKT: vald sortering (t.ex. "slutar snart") får INTE dränka relevansen. Grov
  // relevans-bucket FÖRST (direkta titelträffar > text/ludd/semantik > enbart relaterad-
  // expansion), sen användarens sortering INOM nivån. Annars: sök "tintin" + slutar-snart
  // sorterar hela kandidatuppsättningen (inkl. relaterade "spel"/"leksaker") på sluttid →
  // Nintendo-spel som slutar snart flödar över Tintin-träffarna. Utan sortering = ren RRF.
  const relBucket = `CASE WHEN ${tier1} OR ${tierAllWords} THEN 0
       WHEN ${tierText} OR ${tierFuzzyWhere} OR f.sem_hit THEN 1 ELSE 2 END`;
  // Deferred projection: ranka på LÄTTA kolumner (relbkt/fynd_pct/rrf + item-kolumner) och
  // LIMIT:a FÖRST, hämta sen dyra ITEM_COLS (bild-subquery) bara för sidans rader. Annars
  // beräknades bild-subqueryn för TUSENTALS kandidater (breda expansioner) före LIMIT → sek.
  const rankedOrder = sort ? `relbkt, ${orderByClause(sort, includeEnded)}, rrf DESC` : `rrf DESC`;
  const outerOrder = sort ? `r.relbkt, ${orderByClause(sort, includeEnded)}, r.rrf DESC` : `r.rrf DESC`;

  const res = await pool.query<SearchRow>(
    `WITH lex AS (
       SELECT i.house, i.external_id,
              ROW_NUMBER() OVER (ORDER BY ${relOrder}) AS lrank
       FROM items i
       WHERE (${tier1} OR ${allWordsWhere} OR ${tierText} OR ${tierFuzzyWhere}
          OR ($9::text IS NOT NULL AND false)) -- relaterat avstängt; typar bara $9 (relRe)
         AND ${filterBlock}
       ORDER BY lrank
       LIMIT $19
     ),
     sem AS (
       SELECT house, external_id, ordinality::int AS srank
       FROM unnest($11::text[], $12::text[]) WITH ORDINALITY AS s(house, external_id, ordinality)
     ),
     fused AS (
       SELECT COALESCE(l.house, s.house) AS house,
              COALESCE(l.external_id, s.external_id) AS external_id,
              (s.srank IS NOT NULL) AS sem_hit,
              COALESCE(${RRF_LEX_W}::float / (${RRF_K0} + l.lrank), 0)
                + COALESCE(${RRF_SEM_W}::float / (${RRF_K0} + s.srank), 0) AS score
       FROM lex l
       FULL OUTER JOIN sem s ON l.house = s.house AND l.external_id = s.external_id
     ),
     ranked AS (
       SELECT f.house, f.external_id, f.score AS rrf,
              (${relBucket}) AS relbkt, ${FYND_PCT} AS fynd_pct
       FROM fused f
       JOIN items i ON i.house = f.house AND i.external_id = f.external_id
       WHERE ${filterBlock}
       ORDER BY ${rankedOrder}
       LIMIT $2 OFFSET $3
     )
     SELECT ${ITEM_COLS}, r.rrf
     FROM ranked r
     JOIN items i ON i.house = r.house AND i.external_id = r.external_id
     ORDER BY ${outerOrder}`,
    [
      q, limit, offset, houseArray(house), includeEnded, seller ?? null, reserve ?? null,
      synRe, relRe, wordsParam,
      sem.map((s) => s.house), sem.map((s) => s.external_id),
      ...extraParams(opts), lexCand, ...rawWords,
    ],
  );
  return res.rows;
}

/** Startvy/lista (utan sökterm) med sortering + paginering. */
export async function listActive(opts: ListOpts = {}): Promise<SearchRow[]> {
  await getHiddenHouses(); // färsk ACTIVE_COND (dolda hus slås ut här)
  const { limit = 60, offset = 0, house, seller, includeEnded = false, sort, reserve } = opts;
  const res = await pool.query<SearchRow>(
    `${ITEM_SELECT}
     WHERE ($2::text[] IS NULL OR i.house = ANY($2))
       AND ($3::bool OR ${ACTIVE_COND})
       AND ($4::text IS NULL OR i.seller = $4)
       AND ($6::text IS NULL OR i.reserve_status = $6)
       AND ${konkursCond(opts)}
       AND ${skickCond(opts)}
       ${extraFilters(7)}
     ORDER BY ${orderByClause(sort, includeEnded)}
     LIMIT $1 OFFSET $5`,
    [limit, houseArray(house), includeEnded, seller ?? null, offset, reserve ?? null, ...extraParams(opts)],
  );
  return res.rows;
}

/** Engelska/utländska stadsnamn → svenska exonymer (Auctionets internationella objekt). */
const CITY_SV: Record<string, string> = {
  gothenburg: "Göteborg", copenhagen: "Köpenhamn", malmoe: "Malmö", stockholm: "Stockholm",
  munich: "München", vienna: "Wien", prague: "Prag", brussels: "Bryssel", cologne: "Köln",
  warsaw: "Warszawa", moscow: "Moskva", athens: "Aten", rome: "Rom", lisbon: "Lissabon",
  florence: "Florens", venice: "Venedig", zurich: "Zürich", geneva: "Genève", milan: "Milano",
  naples: "Neapel", helsinki: "Helsingfors", "the hague": "Haag", gutenburg: "Göteborg",
};
const svCity = (loc: string): string => CITY_SV[loc.toLowerCase().trim()] ?? loc;

// Omvänd: svensk stad → alla stavningar (för ort-filter så "Göteborg" fångar "Gothenburg").
const EN_VARIANTS = new Map<string, string[]>();
for (const [en, sv] of Object.entries(CITY_SV)) {
  const arr = EN_VARIANTS.get(sv) ?? [sv];
  arr.push(en);
  EN_VARIANTS.set(sv, arr);
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Ort-filter → regex som matchar svenska namnet OCH ev. engelska varianter. */
export function locationRegex(loc?: string): string | null {
  if (!loc) return null;
  const variants = EN_VARIANTS.get(loc) ?? [loc];
  return [...new Set(variants)].map(escapeRe).join("|");
}

/** Ort-facetter: vanligaste orterna (postnr bortstädade, engelska namn → svenska), med antal. */
export async function locationFacets(limit = 40): Promise<{ location: string; count: number }[]> {
  const res = await pool.query<{ loc: string; n: string }>(
    `SELECT trim(split_part(regexp_replace(location, '^[0-9 ]+', ''), ',', 1)) loc, count(*) n
     FROM items i
     WHERE ${ACTIVE_COND} AND location IS NOT NULL AND length(trim(location)) > 1
     GROUP BY loc HAVING trim(split_part(regexp_replace(location, '^[0-9 ]+', ''), ',', 1)) <> ''
     ORDER BY n DESC LIMIT 150`,
  );
  // Översätt + slå ihop dubbletter (Gothenburg + Göteborg → Göteborg).
  const merged = new Map<string, number>();
  for (const r of res.rows) {
    const sv = svCity(r.loc);
    merged.set(sv, (merged.get(sv) ?? 0) + Number(r.n));
  }
  return [...merged.entries()]
    .map(([location, count]) => ({ location, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export interface PriceStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  median: number;
  /** 25:e/75:e percentilen (SEK) - fynd-motorns tillförlitlighetsmått: tät spridning
   * (p75/p25 lågt) = comparables är eniga → uppskattningen går att lita på. */
  p25: number;
  p75: number;
  current: number | null; // objektets eget bud/utrop (för markör i baren)
  /** True = modellkravet släpptes (strikta passet gav <3) → bredare matchning; AI-bild-
   * granskningen verifierar träffarna i stället. UI visar en liten not. */
  loose: boolean;
  /** De faktiska sålda objekten (mest lika först) som statistiken bygger på - för granskning. */
  samples: {
    id: string; // item_external_id (för AI-verdikt-cache + länkning)
    title: string;
    price: number;
    endedAt: string | null;
    house: string;
    match: number;
    image: string | null; // första bilden (miniatyr för förhandsvisning + AI-jämförelse)
    desc: string | null; // kort innehållstext (för förhandsvisning)
    /** Ursprungsvaluta när priset räknats om till SEK (EUR/DKK...) - UI visar "≈". */
    fx: string | null;
  }[];
}

/** Huvudkategori ur taxonominyckel; null för okänt/Övrigt (kan ej användas som gate). */
function mainCategory(key: string | null | undefined): string | null {
  if (!key) return null;
  const main = key.split("/")[0]!;
  return main === "ovrigt" ? null : main;
}

/**
 * "Vad har liknande gått för?" - hittar SÅLDA objekt i prishistoriken med liknande titel
 * (trigram-likhet ≥ 0.45) och räknar min/snitt/median/max. Null om för få jämförbara (< 3).
 * `current` = objektets eget aktuella bud/utrop för markering. Exkluderar objektet självt.
 *
 * VERIFIERAT SÅLT: joinar till items för reservationspris och exkluderar objekt som INTE
 * nådde reserv (reserve_status='not_met' ELLER slutbud < reserve_price). Så statistiken
 * bygger bara på faktiska avslut - inte "priset 100 kr men reserv låg på 10 000". Hämtar
 * även första bilden (miniatyr) för förhandsvisning av de jämförbara objekten.
 *
 * VALUTA: Auctionets utländska objekt har slutpris i EUR/DKK/GBP - blandat rakt av med
 * SEK blev statistiken fel (400 EUR såg ut som 400 kr). Priserna räknas om till SEK med
 * dagskurs (sekRates; approximation för äldre avslut - rätt storleksordning slår fel
 * valuta varje gång). Okänd valuta utan kurs → raden utesluts. Omräknade markeras fx.
 *
 * SAMMA OBJEKT: trigram räcker inte - antal ("4 st" vs "ett par" vs enstaka) och variant
 * (citerade modellnamn, t.ex. "Lilla Åland") måste också stämma → isComparable() filtrerar
 * (src/db/similar.ts). KATEGORI-GATE: generiska titlar ("Tillbehör") trigram-matchar helt
 * olika saker (NES-tillbehör vs svetstillbehör) → när målets huvudkategori är känd MÅSTE
 * jämförelsens stämma (items.category när den finns, annars klassning av titel+beskrivning
 * i realtid; okänd → bort). Hellre ingen statistik än fel statistik.
 */
export async function priceStats(
  title: string,
  opts: {
    exclHouse?: string;
    exclId?: string;
    current?: number | null;
    category?: string | null;
    /** Målets AI-räknade antal i lotten (items.lot_count) - styr antal-matchningen. */
    lotCount?: number | null;
    /** Målets AI-extraherade attribut (items.attrs) - gatar märke/modell/typ/epok lokalt. */
    attrs?: ItemAttrs | null;
    /** Målets bild-embedding (DINOv2) - visuell jämförbarhetsgate mot varje kandidat. */
    targetEmbedding?: Float32Array | null;
  } = {},
): Promise<PriceStats | null> {
  if (!title || title.trim().length < 3) return null;
  // Distinkta ord ur måltiteln (≥4 tecken, ej rena tal; längst först = mest särskiljande).
  // ORDÖVERLAPP: comps där minst `need` av dessa ord finns (ordgräns) blir kandidater UTÖVER
  // trigram. Trigram (lexikalt) missar Tradera-comps med annorlunda formulerade titlar
  // ("Herrarmbandsur Seiko..." matchar ej kort auktionstitel) - de 155k Tradera-comps var
  // därför nästan oåtkomliga. Kategori-/attribut-/bild-gaten nedan tar precisionen.
  const distinct: string[] = [];
  for (const w of title.toLowerCase().split(/[^a-z0-9åäöéü]+/)
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w))
    .sort((a, b) => b.length - a.length)) {
    if (!distinct.includes(w)) distinct.push(w);
    if (distinct.length >= 5) break;
  }
  const params: unknown[] = [title, opts.exclHouse ?? "", opts.exclId ?? ""];
  let overlapClause = "";
  if (distinct.length >= 1) {
    // ETT index-vänligt ~*-villkor på det mest särskiljande (längsta) ordet → GIN-trigram-
    // indexet kan användas (INTE en summa av regexar → seq-scan, ~10s). Fler-ords-precisionen
    // görs i JS (overlapOk) på ≤250 kandidater = billigt.
    params.push(distinct[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    overlapClause = ` OR ph.item_title ~* ('\\m' || $4)`;
  }
  const res = await pool.query<{
    item_external_id: string;
    final_bid: string;
    item_title: string;
    ended_at: string | null;
    house: string;
    sim: string;
    image: string | null;
    description: string | null;
    item_category: string | null;
    item_category_conf: string | null;
    currency: string | null;
    item_lot_count: number | null;
    item_attrs: ItemAttrs | null;
    emb: Buffer | null;
  }>(
    `SELECT ph.item_external_id, ph.final_bid, ph.item_title, ph.ended_at, ph.house,
            similarity(ph.item_title, $1) sim, i.description, i.currency,
            i.lot_count AS item_lot_count, i.attrs AS item_attrs,
            i.category AS item_category, i.category_conf AS item_category_conf,
            (SELECT m.url FROM media m
             WHERE m.house = ph.house AND m.owner_type = 'item'
               AND m.owner_external_id = ph.item_external_id AND m.kind = 'image'
             ORDER BY m.sort NULLS LAST LIMIT 1) image,
            NULL::bytea emb
     FROM price_history ph
     LEFT JOIN items i ON i.house = ph.house AND i.external_id = ph.item_external_id
     WHERE ph.sold AND ph.final_bid > 0
       AND ((ph.item_title % $1 AND similarity(ph.item_title, $1) >= 0.45)${overlapClause})
       AND NOT (ph.house = $2 AND ph.item_external_id = $3)
       -- verifierat sålt: uteslut objekt som bevisligen inte nådde reserv
       AND (i.reserve_status IS NULL OR i.reserve_status <> 'not_met')
       AND (i.reserve_price IS NULL OR ph.final_bid >= i.reserve_price)
     ORDER BY sim DESC
     LIMIT 250`,
    params,
  );
  // Kategori-gate: målets huvudkategori känd → jämförelsens måste matcha (okänd → bort).
  // Källordning per historikrad: LLM-facit/learned på items-raden → facit-tränade
  // lexikonet på titeln → äldre lagrad nyckelordskategori → nyckelord i realtid.
  const tMain = mainCategory(opts.category);
  if (tMain != null) await lexicon.ensureLoaded();
  const sameCategory = (r: {
    item_title: string;
    description: string | null;
    item_category: string | null;
    item_category_conf: string | null;
  }): boolean => {
    if (tMain == null) return true; // målet oklassat → kan ej gata
    const trusted =
      r.item_category_conf === "human" || r.item_category_conf === "llm" || r.item_category_conf === "learned";
    const sMain =
      (trusted ? mainCategory(r.item_category) : null) ??
      mainCategory(lexicon.classify(r.item_title)?.category) ??
      mainCategory(r.item_category) ??
      mainCategory(classifyByText(`${r.item_title} ${r.description ?? ""}`));
    return sMain === tMain;
  };
  // SEK-omräkning: dagskurs per rad; okänd valuta utan kurs → uteslut (hellre färre än fel).
  const rates = await sekRates();
  const inSek = (r: { final_bid: string; currency: string | null }): number | null => {
    const cur = (r.currency ?? "SEK").toUpperCase();
    const rate = rates[cur];
    return rate != null ? Math.round(Number(r.final_bid) * rate) : null;
  };
  const candidates = res.rows.map((r) => ({ ...r, priceSek: inSek(r) }));
  // Mänskliga underkännanden (swipe-granskning, match_verdicts.source='human', same=false)
  // utesluts PERMANENT ur jämförelseunderlaget - både den interaktiva /price-stats-vyn och
  // det periodiska fynd-passet (estimatePass) går via priceStats, så en swipe-vänster på ett
  // jämförelsepar slår igenom överallt, inte bara i admin-granskningsvyn. AI-underkännanden
  // (source='ai') gatar INTE här (de var redan bara en visnings-omräkning i /price-stats,
  // ändras inte av denna omskrivning - se aiStats i server.ts).
  let rejected = new Set<string>();
  if (opts.exclHouse && opts.exclId) {
    const rv = await pool.query<{ cmp_house: string; cmp_external_id: string }>(
      `SELECT cmp_house, cmp_external_id FROM match_verdicts
       WHERE house=$1 AND item_external_id=$2 AND same=false AND source='human'`,
      [opts.exclHouse, opts.exclId],
    );
    rejected = new Set(rv.rows.map((r) => `${r.cmp_house}/${r.cmp_external_id}`));
  }
  // VISUELL GATE: kandidatens bild måste vara visuellt lik målets (DINOv2-cosinus över
  // tröskel). MISSING-SAFE (rätt riktning av "hellre inget än fel"): gata ENDAST när
  // BÅDA sidor har embedding - saknas endera, BEHÅLL kandidaten (annars skulle den långa
  // CPU-backfillen tyst krympa jämförelseunderlaget och REGRESSERA giltiga uppskattningar).
  // Tröskeln är LÅG med flit. Kalibrering (DINOv2-base på auktionsthumbnails): äkta
  // jämförbara ligger ~0.21-0.73, olika KATEGORI (ring↔matta) ~0-0.05. Men samma-kategori-
  // varians är INTRINSISK (guld-ringar varierar i karat/kvalitet som bilden ej visar) och
  // DINOv3 ViT-L (2026-07-07): kalibrerat på real data - samma kategori 0,45-0,78, olika
  // kategori 0,03-0,04 (i princip ortogonalt, enormt rent gap - vida bättre än DINOv2:s
  // hoptryckta 0,23-0,25). 0,30 ligger tryggt under allt äkta jämförbart och långt över
  // kategori-bruset → gaten tar grova fel-kategori-outliers utan att röra äkta jämförbara.
  const VISUAL_MIN = Number(process.env.VISUAL_MIN ?? 0.3);
  const target = opts.targetEmbedding ?? null;
  const visualOk = (emb: Buffer | null): boolean => {
    if (target == null || emb == null) return true;
    const v = decodeVec(emb);
    return v == null ? true : cosine(target, v) >= VISUAL_MIN;
  };
  // Ordöverlapp-precision: en kandidat som kom in via ETT-ords-villkoret (ej trigram) måste
  // dela minst 2 särskiljande ord med målet (annars bara det generiska typ-ordet, t.ex.
  // "armbandsur") → filtrerar bort svaga comps utan att seq-scanna i SQL.
  const overlapOk = (r: { item_title: string; sim: string }): boolean => {
    if (distinct.length < 2 || Number(r.sim) >= 0.45) return true;
    const cw = r.item_title.toLowerCase().split(/[^a-z0-9åäöéü]+/);
    let n = 0;
    for (const w of distinct) if (cw.some((c) => c.startsWith(w))) n++;
    return n >= 2;
  };
  const pass = (requireModel: boolean) =>
    candidates.filter(
      (r): r is typeof r & { priceSek: number } =>
        r.priceSek != null &&
        r.priceSek > 0 &&
        !rejected.has(`${r.house}/${r.item_external_id}`) &&
        overlapOk(r) &&
        isComparable(
          title,
          r.item_title,
          { t: opts.lotCount, s: r.item_lot_count },
          { requireModel, attrs: { t: opts.attrs, s: r.item_attrs } },
        ) &&
        sameCategory(r) &&
        visualOk(r.emb),
    );
  // Strikt först (modellkrav); svälter den (<3) → bredare pass utan modellkravet -
  // kategori/antal/valuta gäller fortfarande och AI-bildgranskningen tar varianterna.
  let rows = pass(true);
  let loose = false;
  if (rows.length < 3) {
    const wide = pass(false);
    if (wide.length >= 3) {
      rows = wide;
      loose = true;
    }
  }
  if (rows.length < 3) return null;
  const prices = rows.map((r) => r.priceSek).sort((a, b) => a - b);
  const sum = prices.reduce((a, b) => a + b, 0);
  const pct = (q: number) => prices[Math.min(prices.length - 1, Math.floor(q * prices.length))]!;
  return {
    count: prices.length,
    min: prices[0]!,
    max: prices[prices.length - 1]!,
    avg: Math.round(sum / prices.length),
    median: prices[Math.floor(prices.length / 2)]!,
    p25: pct(0.25),
    p75: pct(0.75),
    current: opts.current ?? null,
    loose,
    // De faktiska objekten, mest lika först (för granskning i UI:t).
    samples: rows.slice(0, 15).map((r) => ({
      id: r.item_external_id,
      title: r.item_title,
      price: r.priceSek,
      endedAt: r.ended_at,
      house: r.house,
      match: Math.round(Number(r.sim) * 100),
      image: r.image,
      desc: r.description ? r.description.replace(/\s+/g, " ").trim().slice(0, 160) : null,
      fx: r.currency != null && r.currency.toUpperCase() !== "SEK" ? r.currency.toUpperCase() : null,
    })),
  };
}

/** Cachade AI-verdikt för (mål, jämförelse)-par → Map "cmpHouse/cmpId" → verdikt. */
export async function loadMatchVerdicts(
  house: string,
  itemId: string,
  pairs: { house: string; id: string }[],
): Promise<Map<string, { same: boolean; reason: string | null }>> {
  const out = new Map<string, { same: boolean; reason: string | null }>();
  if (pairs.length === 0) return out;
  const res = await pool.query<{ cmp_house: string; cmp_external_id: string; same: boolean; reason: string | null }>(
    `SELECT cmp_house, cmp_external_id, same, reason FROM match_verdicts
     WHERE house=$1 AND item_external_id=$2
       AND (cmp_house, cmp_external_id) IN (
         SELECT unnest($3::text[]), unnest($4::text[]))`,
    [house, itemId, pairs.map((p) => p.house), pairs.map((p) => p.id)],
  );
  for (const r of res.rows) out.set(`${r.cmp_house}/${r.cmp_external_id}`, { same: r.same, reason: r.reason });
  return out;
}

/** Spara ett verdikt (idempotent - senaste vinner, MEN ett 'human'-facit
 * skrivs aldrig över av ett senare 'ai'-facit). */
export async function saveMatchVerdict(
  house: string,
  itemId: string,
  cmpHouse: string,
  cmpId: string,
  verdict: { same: boolean; reason: string; model: string },
  source: "ai" | "human" = "ai",
): Promise<void> {
  await pool.query(
    `INSERT INTO match_verdicts (house, item_external_id, cmp_house, cmp_external_id, same, reason, model, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (house, item_external_id, cmp_house, cmp_external_id)
       DO UPDATE SET same=EXCLUDED.same, reason=EXCLUDED.reason, model=EXCLUDED.model,
                      source=EXCLUDED.source, created_at=now()
       WHERE match_verdicts.source <> 'human' OR EXCLUDED.source = 'human'`,
    [house, itemId, cmpHouse, cmpId, verdict.same, verdict.reason, verdict.model, source],
  );
}

/** Finns redan ett facit (AI eller mänskligt) för paret? Används för att
 * hoppa AI-verifiering när ett facit redan finns. */
export async function hasMatchVerdict(house: string, itemId: string, cmpHouse: string, cmpId: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM match_verdicts WHERE house=$1 AND item_external_id=$2 AND cmp_house=$3 AND cmp_external_id=$4`,
    [house, itemId, cmpHouse, cmpId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Kategori-facetter: antal AKTIVA objekt per taxonomi-nyckel (för filter-räknare). */
export async function categoryFacets(): Promise<Record<string, number>> {
  const res = await pool.query<{ category: string; n: string }>(
    `SELECT category, count(*) n FROM items i WHERE ${ACTIVE_COND} AND category IS NOT NULL GROUP BY category`,
  );
  const out: Record<string, number> = {};
  for (const r of res.rows) out[r.category] = Number(r.n);
  return out;
}

export interface HouseRow {
  house: string;
  item_count: number;
}

/**
 * Källor (auktionshus) med antal aktiva objekt — för datadrivna källfilter i UI.
 * Returnerar plattformsnyckeln (house) sorterad på antal, flest först.
 */
export async function listHouses(): Promise<HouseRow[]> {
  await getHiddenHouses(); // dolda hus försvinner även ur källfiltret
  const res = await pool.query<{ house: string; item_count: string }>(
    `SELECT i.house, count(*) AS item_count
     FROM items i
     WHERE ${ACTIVE_COND}
     GROUP BY i.house
     ORDER BY count(*) DESC`,
  );
  return res.rows.map((r) => ({ house: r.house, item_count: Number(r.item_count) }));
}

/**
 * Underliggande hus (seller) inom en plattform — för drill-down-filter, t.ex.
 * Auctionets medlemshus (Crafoord, Sajab …). Flest aktiva objekt först.
 */
export async function listSellers(house?: string): Promise<{ seller: string; item_count: number }[]> {
  const res = await pool.query<{ seller: string; item_count: string }>(
    `SELECT i.seller, count(*) AS item_count
     FROM items i
     WHERE ${ACTIVE_COND} AND i.seller IS NOT NULL
       AND ($1::text IS NULL OR i.house = $1)
     GROUP BY i.seller
     ORDER BY count(*) DESC`,
    [house ?? null],
  );
  return res.rows.map((r) => ({ seller: r.seller, item_count: Number(r.item_count) }));
}

/** Uppdatera ett objekts (ev. förlängda) sluttid — soft close. */
/**
 * external_id för objekt som redan har en beskrivning i DB (proxy för "objektsidan
 * är redan berikad"). Låter connectorer hoppa över dyr om-berikning efter omstart
 * (in-memory-cachen är tom då) i stället för att hämta om det vi redan har.
 */
export async function enrichedItemIds(house: string): Promise<Set<string>> {
  const res = await pool.query<{ external_id: string }>(
    `SELECT external_id FROM items WHERE house=$1 AND description IS NOT NULL`,
    [house],
  );
  return new Set(res.rows.map((r) => r.external_id));
}

/**
 * Seed ur items.raw: plocka en JSON-undernyckel per objekt (t.ex. Budis avgifts-
 * parametrar raw->item->feeParams eller Vaxxas raw->item->isTaxable) så att berikad
 * metadata överlever omstarter utan om-hämtning av objektsidor.
 */
export async function rawFieldSeed<T>(house: string, path: string[]): Promise<Map<string, T>> {
  if (!path.every((p) => /^[a-zA-Z_]+$/.test(p))) throw new Error(`ogiltig raw-path: ${path.join(".")}`);
  const expr = "raw->" + path.map((p) => `'${p}'`).join("->");
  const res = await pool.query<{ external_id: string; v: T }>(
    `SELECT external_id, ${expr} AS v FROM items
     WHERE house=$1 AND ${expr} IS NOT NULL`,
    [house],
  );
  const out = new Map<string, T>();
  for (const r of res.rows) if (r.v != null) out.set(r.external_id, r.v);
  return out;
}

/**
 * external_id för objekt som redan har ETT GALLERI i DB (>1 bild). Proxy för
 * "objektsidan är redan galleri-berikad" (källor utan beskrivning, t.ex. Klaravik)
 * → hoppa över om-hämtning av galleriet efter omstart.
 */
export async function galleryEnrichedItemIds(house: string): Promise<Set<string>> {
  const res = await pool.query<{ owner_external_id: string }>(
    `SELECT owner_external_id FROM media
     WHERE house=$1 AND owner_type='item'
     GROUP BY owner_external_id HAVING count(*) > 1`,
    [house],
  );
  return new Set(res.rows.map((r) => r.owner_external_id));
}

/**
 * Connectorns list-/kort-objekt (ur kolumnen `raw`) för alla AKTIVA objekt i ett
 * hus. Låter connectorer återskapa sin in-memory-cache (t.ex. PS Auctions itemId→
 * liveId-mappning eller Klaraviks id→url-mappning) från DB efter omstart, så hett-
 * pollen når objekt vars listsida inte svepts än. KRITISKT för hus med fler sidor än
 * FLAT_SWEEP_PAGES (PS Auction ~197, Klaravik ~50) - annars fryser objekt på osvepta
 * sidor i "inaktuell" status trots att de avslutas inom någon minut.
 *
 * `key` = JSON-nyckeln i `raw` där list-objektet ligger (t.ex. "item" för PS Auction
 * där raw={item,live,detail}); utan key är HELA `raw` list-objektet (t.ex. Klaravik
 * där raw=KlaravikItem direkt).
 */
export async function loadRawItems(house: string, key?: string): Promise<unknown[]> {
  if (key != null && !/^[a-z_]+$/i.test(key)) throw new Error(`ogiltig raw-nyckel: ${key}`);
  const expr = key != null ? `raw->'${key}'` : "raw";
  const res = await pool.query<{ item: unknown }>(
    `SELECT ${expr} AS item FROM items
     WHERE house=$1 AND status='active' AND ${expr} IS NOT NULL`,
    [house],
  );
  return res.rows.map((r) => r.item).filter((x) => x != null);
}

export async function updateItemEndsAt(
  house: string,
  externalId: string,
  endsAt: string | null,
): Promise<void> {
  if (!endsAt) return;
  await pool.query(
    `UPDATE items SET ends_at=$1, last_seen=now() WHERE house=$2 AND external_id=$3`,
    [endsAt, house, externalId],
  );
}

/**
 * Finalisera ett verkligt avslutat objekt: sätt status=ended och skriv en
 * prishistorik-rad (slutbud, totalpris, vinnare, kategori). Idempotent.
 */
export async function finalizeEndedItem(
  house: string,
  externalId: string,
): Promise<void> {
  // Vägra finalisera objekt vars sluttid ligger klart i framtiden (soft-close-marginal
  // 15 min). Skyddar mot källor som råkar returnera pågående/kommande objekt i "ended"-
  // flödet (t.ex. GAK) och därmed förgiftar prishistoriken med start-bud som "slutpris".
  const FUTURE_GUARD = "(i.ends_at IS NULL OR i.ends_at <= now() + interval '15 minutes')";
  // Status-flip till 'ended' bara om raden inte redan var avslutad (IS DISTINCT FROM)
  // → RETURNING träffar exakt de NYAVSLUTADE objekten (idempotent omkörning = ingen
  // träff = ingen dubbel IndexNow-ping).
  const flipped = await pool.query(
    `UPDATE items SET status='ended', last_seen=now()
     WHERE house=$1 AND external_id=$2
       AND status IS DISTINCT FROM 'ended'
       AND (ends_at IS NULL OR ends_at <= now() + interval '15 minutes')
     RETURNING external_id`,
    [house, externalId],
  );
  if ((flipped.rowCount ?? 0) > 0) addEnded(house, externalId);
  await pool.query(
    `INSERT INTO price_history (house, item_external_id, item_title, category,
                               final_bid, final_total, winner_name, sold, ended_at, raw)
     SELECT i.house, i.external_id, i.title, p.category,
            COALESCE(i.current_bid,0), i.total_price, i.leader_name,
            (COALESCE(i.current_bid,0) > 0
             AND i.reserve_status IS DISTINCT FROM 'not_met'
             AND (i.reserve_price IS NULL OR i.current_bid >= i.reserve_price)),
            i.ends_at, i.raw
     FROM items i
     LEFT JOIN parts p ON p.house=i.house AND p.external_id=i.part_external_id
     WHERE i.house=$1 AND i.external_id=$2 AND ${FUTURE_GUARD}
     ON CONFLICT (house, item_external_id) DO UPDATE
       SET final_bid=EXCLUDED.final_bid, final_total=EXCLUDED.final_total,
           winner_name=EXCLUDED.winner_name, sold=EXCLUDED.sold,
           ended_at=EXCLUDED.ended_at, category=EXCLUDED.category,
           raw=COALESCE(EXCLUDED.raw, price_history.raw)`,
    [house, externalId],
  );
}

/**
 * Backstop: finalisera aktiva objekt vars sluttid passerat med marginal
 * (graceMs) — fångar objekt som inte längre returneras av live-pollen.
 * Marginalen skyddar mot soft-close (max 2 min förlängning).
 */
export async function finalizePastDue(
  house: string,
  graceMs = 600_000,
): Promise<number> {
  const res = await pool.query<{ house: string; item_external_id: string }>(
    `WITH due AS (
       UPDATE items SET status='ended', last_seen=now()
       WHERE house=$1 AND status='active'
         AND ends_at IS NOT NULL
         AND ends_at < now() - ($2 || ' milliseconds')::interval
       RETURNING house, external_id, title, part_external_id,
                 current_bid, total_price, leader_name, ends_at, raw,
                 reserve_status, reserve_price
     )
     INSERT INTO price_history (house, item_external_id, item_title, category,
                               final_bid, final_total, winner_name, sold, ended_at, raw)
     SELECT d.house, d.external_id, d.title, p.category,
            COALESCE(d.current_bid,0), d.total_price, d.leader_name,
            (COALESCE(d.current_bid,0) > 0
             AND d.reserve_status IS DISTINCT FROM 'not_met'
             AND (d.reserve_price IS NULL OR d.current_bid >= d.reserve_price)),
            d.ends_at, d.raw
     FROM due d
     LEFT JOIN parts p ON p.house=d.house AND p.external_id=d.part_external_id
     ON CONFLICT (house, item_external_id) DO UPDATE
       SET final_bid=EXCLUDED.final_bid, final_total=EXCLUDED.final_total,
           winner_name=EXCLUDED.winner_name, sold=EXCLUDED.sold,
           ended_at=EXCLUDED.ended_at, category=EXCLUDED.category,
           raw=COALESCE(EXCLUDED.raw, price_history.raw)
     RETURNING house, item_external_id`,
    [house, String(graceMs)],
  );
  // Raderna kommer ur `due`-CTE:n (WHERE status='active') → status bytte till
  // 'ended' i just detta anrop → NYAVSLUTADE → buffra för IndexNow-ping.
  for (const r of res.rows) addEnded(r.house, r.item_external_id);
  return res.rowCount ?? 0;
}

/** Skriv prishistorik direkt från ett normaliserat (avslutat) objekt — backfill. */
export async function upsertPriceHistory(
  it: NormalizedItem,
  _feeModel: FeeModel | undefined, // löses per objekt ur (hus, valuta) nedan
  winnerName: string | null,
  category: string | null,
): Promise<void> {
  const finalBid = it.currentBid ?? 0;
  const total = computeTotal(
    { bid: finalBid, sourceFeeValue: it.feeValue, sourceVatRate: it.vatRate },
    feeModelForItem(it.house, it.currency),
  );
  // Verifierat sålt: bud > 0 OCH reserv inte bevisligen omissad (nådd/okänd/ingen),
  // och om värdet är känt (Junora) att slutbudet faktiskt når det.
  const sold =
    finalBid > 0 &&
    it.reserveStatus !== "not_met" &&
    (it.reservePrice == null || finalBid >= it.reservePrice);
  await pool.query(
    `INSERT INTO price_history (house, item_external_id, item_title, category,
                               final_bid, final_total, winner_name, sold, ended_at, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (house, item_external_id) DO UPDATE
       SET item_title=EXCLUDED.item_title, category=EXCLUDED.category,
           final_bid=EXCLUDED.final_bid, final_total=EXCLUDED.final_total,
           winner_name=EXCLUDED.winner_name, sold=EXCLUDED.sold,
           ended_at=EXCLUDED.ended_at, raw=COALESCE(EXCLUDED.raw, price_history.raw)`,
    [
      it.house, it.externalId, it.title, category,
      finalBid, total.total, winnerName, sold, it.endsAt,
      it.raw ? JSON.stringify(it.raw) : null,
    ],
  );
}

export interface PriceHistoryRow {
  house: string;
  item_external_id: string;
  item_title: string | null;
  category: string | null;
  final_bid: string | null;
  final_total: string | null;
  winner_name: string | null;
  sold: boolean | null;
  ended_at: Date | null;
}

/** Sök i prishistoriken (fuzzy på titel); utan sökterm: senast avslutade. */
export async function priceHistory(
  q: string,
  limit = 25,
): Promise<PriceHistoryRow[]> {
  if (q) {
    const res = await pool.query<PriceHistoryRow>(
      `SELECT * FROM price_history
       WHERE item_title % $1 OR item_title ILIKE '%'||$1||'%'
       ORDER BY ended_at DESC NULLS LAST LIMIT $2`,
      [q, limit],
    );
    return res.rows;
  }
  const res = await pool.query<PriceHistoryRow>(
    `SELECT * FROM price_history ORDER BY ended_at DESC NULLS LAST LIMIT $1`,
    [limit],
  );
  return res.rows;
}

/* ---- Prisuppslag: "vad går X för?" över hela price_history ---- */

export interface PriceLookupStats {
  count: number;
  min: number;
  p25: number;
  median: number;
  avg: number;
  p75: number;
  max: number;
}

export interface PriceLookupRow {
  house: string;
  item_external_id: string;
  item_title: string;
  category: string | null;
  final_bid: number;
  final_total: number | null;
  ended_at: string | null;
  image: string | null;
}

export interface PriceLookupOpts {
  limit?: number;
  months?: number; // bara sålt de senaste N månaderna (0/undefined = all tid)
  house?: string;
}

/**
 * Prisuppslag som eget verktyg (aggregatorns fördel: hela svenska andrahandsmarknaden på
 * tvärs). Statistiken + grafen bygger på FAKTISK TOTALKOSTNAD (final_total = klubbat bud +
 * slagavgift + moms per hus) - det man verkligen betalade. final_total är fullt täckt.
 *
 * RELEVANS: varje ord måste finnas som ORDBÖRJAN i titeln (regex `\m`, ej delsträng) → "iphone"
 * matchar INTE "epiphone", och "kosta" inte "akustad". Trigram-index (items_ph_title_trgm om
 * det finns, annars seq) gatar grovt, regexen förfinar. Filter: months (färska comps) + house.
 */
export async function priceLookup(
  q: string,
  opts: PriceLookupOpts = {},
): Promise<{ stats: PriceLookupStats | null; rows: PriceLookupRow[]; series: { t: string; v: number }[] }> {
  const { limit = 40, months = 0, house } = opts;
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\%_]/g, "\\$&")); // regex- OCH like-metatecken
  if (words.length === 0) return { stats: null, rows: [], series: [] };
  // Ordbörjan-ankrad regex per ord (\m). Grov trigram-gate via ILIKE så indexet kan användas.
  const conds = words.map((_, i) =>
    `ph.item_title ILIKE '%' || $${i + 1} || '%' AND ph.item_title ~* ('\\m' || $${i + 1})`).join(" AND ");
  let p = words.length;
  let extra = "";
  const params: unknown[] = [...words];
  if (months > 0) { extra += ` AND ph.ended_at >= now() - ($${++p} || ' months')::interval`; params.push(String(months)); }
  if (house) { extra += ` AND ph.house = $${++p}`; params.push(house); }
  // Skydda premium-datat: ett SÅLT objekt kan aldrig ha sluttid i framtiden. Filtrera bort
  // ev. för tidigt finaliserade rader (behåll NULL = arkiv-backfill utan sluttid).
  const base = `FROM price_history ph WHERE ph.sold AND ph.final_bid > 0
    AND (ph.ended_at IS NULL OR ph.ended_at <= now()) AND ${conds}${extra}`;
  const PRICE = `COALESCE(ph.final_total, ph.final_bid)`; // total inkl. avgifter+moms
  const [agg, list, ser] = await Promise.all([
    pool.query<{ count: string; min: string; p25: string; median: string; avg: string; p75: string; max: string }>(
      `SELECT count(*) AS count, min(${PRICE}) AS min,
              percentile_cont(0.25) WITHIN GROUP (ORDER BY ${PRICE}) AS p25,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY ${PRICE}) AS median,
              round(avg(${PRICE})) AS avg,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY ${PRICE}) AS p75,
              max(${PRICE}) AS max
       ${base}`,
      params,
    ),
    pool.query<PriceLookupRow>(
      `SELECT ph.house, ph.item_external_id, ph.item_title, ph.category,
              ph.final_bid, ph.final_total, ph.ended_at::text,
              (SELECT m.url FROM media m
               WHERE m.house=ph.house AND m.owner_type='item'
                 AND m.owner_external_id=ph.item_external_id AND m.kind='image'
               ORDER BY m.sort LIMIT 1) AS image
       ${base}
       ORDER BY ph.ended_at DESC NULLS LAST LIMIT $${++p}`,
      [...params, limit],
    ),
    pool.query<{ t: string; v: number }>(
      `SELECT ph.ended_at::text AS t, ${PRICE} AS v
       ${base} AND ph.ended_at IS NOT NULL ORDER BY ph.ended_at ASC LIMIT 800`,
      params,
    ),
  ]);
  const a = agg.rows[0];
  const stats = a && Number(a.count) > 0
    ? {
        count: Number(a.count), min: Number(a.min),
        p25: Math.round(Number(a.p25)), median: Math.round(Number(a.median)),
        avg: Number(a.avg), p75: Math.round(Number(a.p75)), max: Number(a.max),
      }
    : null;
  return { stats, rows: list.rows, series: ser.rows.map((r) => ({ t: r.t, v: Number(r.v) })) };
}

/* ---- Job-cursor (återupptagbar backfill) ---- */

export interface JobState {
  cursor_offset: number;
  total: number | null;
  done: boolean;
}

export async function getJobState(job: string): Promise<JobState> {
  const res = await pool.query<JobState>(
    `SELECT cursor_offset, total, done FROM job_state WHERE job=$1`,
    [job],
  );
  return res.rows[0] ?? { cursor_offset: 0, total: null, done: false };
}

export async function setJobState(
  job: string,
  cursorOffset: number,
  total: number | null,
  done: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO job_state (job, cursor_offset, total, done, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (job) DO UPDATE
       SET cursor_offset=$2, total=$3, done=$4, updated_at=now()`,
    [job, cursorOffset, total, done],
  );
}

/* ---- /swipe: mänsklig granskning ---- */

/**
 * Beslutslogik för categorization-läget. 'approve': nuvarande kategori
 * behålls (category=null → SQL:en rör inte kolumnen), conf blir 'human'
 * (rank-guarden gör den permanent). 'reject': kategori/conf nollas helt
 * och konflikt-flaggan sätts → objektet hamnar överst i BÅDA
 * klassnings-köerna igen (samma prioritering som Task 4).
 */
export function categorizationDecisionPatch(
  decision: "approve" | "reject",
): { category: string | null; category_conf: "human" | null; category_conflict: boolean } {
  return decision === "approve"
    ? { category: null, category_conf: "human", category_conflict: false }
    : { category: null, category_conf: null, category_conflict: true };
}

export interface SwipeCategorizationCard {
  house: string;
  external_id: string;
  title: string;
  image: string | null;
  category: string | null;
  category_conf: string | null;
  houseCategoryLabel: string | null;
  /** Husets kategori mappad till VÅR taxonomi (null = ingen mappning för huset) -
   * det är detta värdet, inte houseCategoryLabel (som kan vara en oanvändbar rå-etikett),
   * som "use_house"-beslutet skriver till items.category. */
  houseCategoryKey: string | null;
}

/** Nästa kort: konflikt-flaggade FÖRST, annars lägst konfidens (samma prioritering
 * som klassnings-köerna) - så verktyget alltid har något att visa. `exclude` hoppar
 * över nyligen BESVARADE objekt: ett nyss avvisat kort får conflict=true + conf=null
 * och sorterar därmed först igen. En enda uteslutning räckte inte - vid två snabba
 * avslag i rad (A avvisas → B visas → B avvisas → A är inte längre uteslutet →
 * A visas igen) fastnar granskaren i en oändlig pingpong mellan just de två korten,
 * även om ett bakgrundspass hunnit klassificera om dem under tiden (2026-08-01,
 * observerat live: "Chinese Kangxi..." + "GUNNAR HANSSON..." - båda redan omklassade
 * i databasen, men swipe visade dem växelvis pga den enda-platsen-uteslutningen).
 * Klienten skickar därför en KORT LISTA av senast besvarade nycklar, inte bara en. */
export async function nextCategorizationCard(
  exclude: { house: string; externalId: string }[] = [],
): Promise<SwipeCategorizationCard | null> {
  const houses = exclude.map((e) => e.house);
  const ids = exclude.map((e) => e.externalId);
  const { rows } = await pool.query<{
    house: string; external_id: string; title: string; category: string | null;
    category_conf: string | null; raw: Record<string, unknown> | null;
    image: string | null;
  }>(
    `SELECT i.house, i.external_id, i.title, i.category, i.category_conf, i.raw,
            (SELECT m.url FROM media m WHERE m.house=i.house AND m.owner_type='item'
               AND m.owner_external_id=i.external_id AND m.kind='image'
             ORDER BY m.sort NULLS LAST LIMIT 1) AS image
     FROM items i
     WHERE i.status='active' AND i.title IS NOT NULL
       AND (i.category_conf IS NULL OR i.category_conf <> 'human')
       AND NOT EXISTS (
         SELECT 1 FROM unnest($1::text[], $2::text[]) AS ex(house, external_id)
         WHERE ex.house = i.house AND ex.external_id = i.external_id
       )
     ORDER BY i.category_conflict DESC, cat_conf_rank(i.category_conf) ASC, i.ends_at ASC NULLS LAST
     LIMIT 1`,
    [houses, ids],
  );
  const r = rows[0];
  if (!r) return null;
  const hc = houseCategoryKey(r.house, r.raw);
  // Vissa hus (Auctionet) har bara en numerisk category_id, ingen läsbar etikett i
  // rådatan - hc.raw blir då en bar siffra ("13"), oanvändbar för en människa. Visa
  // hellre vår egen mappade taxonominyckel (läsbar), med rå-värdet inom parentes för
  // spårbarhet när de skiljer sig åt. Hus utan mappning (key=null) faller tillbaka på raw.
  const houseCategoryLabel =
    hc.key && hc.key !== hc.raw ? `${hc.key}${hc.raw ? ` (${hc.raw})` : ""}` : hc.key ?? hc.raw;
  return {
    house: r.house, external_id: r.external_id, title: r.title, image: r.image,
    category: r.category, category_conf: r.category_conf, houseCategoryLabel,
    houseCategoryKey: hc.key,
  };
}

export async function decideCategorization(
  house: string, externalId: string, decision: "approve" | "reject" | "use_house",
): Promise<void> {
  if (decision === "use_house") {
    // Husets kategori har rätt men VÅR gissning inte (motsatsen till "approve") -
    // slå upp husets mappade kategori på nytt server-sidan (aldrig ur klientens
    // ord - houseCategoryKey() härleds ur den lagrade rådatan, inte betrodd input)
    // och skriv den som facit. Ingen mappning (key=null) → no-op, inget att sätta.
    const r = await pool.query<{ raw: Record<string, unknown> | null }>(
      `SELECT raw FROM items WHERE house=$1 AND external_id=$2`,
      [house, externalId],
    );
    const hc = houseCategoryKey(house, r.rows[0]?.raw ?? null);
    if (!hc.key) return;
    await pool.query(
      `UPDATE items SET category=$3, category_conf='human', category_conflict=false
       WHERE house=$1 AND external_id=$2`,
      [house, externalId, hc.key],
    );
    return;
  }
  const patch = categorizationDecisionPatch(decision);
  if (decision === "approve") {
    await pool.query(
      // category IS NOT NULL: att godkänna ett kort UTAN kategori skulle låsa det på
      // 'human' med category=null - permanent osynligt för både klassning och kön.
      `UPDATE items SET category_conf=$3, category_conflict=$4
       WHERE house=$1 AND external_id=$2 AND category IS NOT NULL`,
      [house, externalId, patch.category_conf, patch.category_conflict],
    );
  } else {
    await pool.query(
      `UPDATE items SET category=$3, category_conf=$4, category_conflict=$5
       WHERE house=$1 AND external_id=$2`,
      [house, externalId, patch.category, patch.category_conf, patch.category_conflict],
    );
  }
}

export interface SwipeComparisonCard {
  house: string; externalId: string; title: string; image: string | null;
  cmpHouse: string; cmpExternalId: string; cmpTitle: string; cmpImage: string | null; cmpPrice: number | null;
  /** Cosine-likhet mellan huvudbildernas DINOv3-embedding, 0-100 (samma konvention som
   * /similar-visual). Null om endera bildens embedding inte beräknats än (bakgrundspass). */
  visualMatch: number | null;
}

/** Nästa jämförelsepar UTAN facit ännu (varken AI eller människa) - hämtar
 * ur den AI-driven prisjämförelsens senaste kandidatpar (est_at nyligen satt). */
export async function nextComparisonCard(): Promise<SwipeComparisonCard | null> {
  // NÖDBROMS (2026-08-01 incident, se not vid frågan nedan): även efter LATERAL-fixet kan
  // frågan bli dyr när MÅNGA aktiva objekt saknar en matchande såld jämförelse (måste prövas
  // en efter en tills en träff hittas). Egen anslutning med hård statement_timeout - en trög
  // sökning ger ETT tomt swipe-kort (hellre inget än en hängande sida/pinnad db-CPU), stör
  // aldrig resten av sajten. Kortlivad koppling avslutas (ej pool.release) - ingen risk att
  // en kvarglömd session-timeout läcker till en annan konsument av den delade poolen.
  const client = await pool.connect();
  let rows: {
    house: string; external_id: string; title: string; image: string | null; image_emb: Buffer | null;
    cmp_house: string; cmp_external_id: string; cmp_title: string; cmp_image: string | null;
    cmp_image_emb: Buffer | null; cmp_price: number | null;
  }[];
  try {
    await client.query(`SET statement_timeout = '4000'`);
    const res = await client.query<{
      house: string; external_id: string; title: string; image: string | null; image_emb: Buffer | null;
      cmp_house: string; cmp_external_id: string; cmp_title: string; cmp_image: string | null;
      cmp_image_emb: Buffer | null; cmp_price: number | null;
    }>(
    // PERF (2026-08-01 incident): "JOIN price_history ph ON ph.item_title % i.title" är en
    // korstabell-join på TVÅ kolumner - pg_trgm:s GIN-index kan INTE stödja det direkt (bara
    // "kolumn % konstant"), så planeraren föll tillbaka på Seq Scan + Nested Loop över HELA
    // price_history (miljontals rader) x items (tiotusentals) → kostnad i miljardklassen,
    // pinnade db-CPU:n på ~96 % och svalt ut resten av sajten. Fix: LATERAL - i.title blir då
    // en KORRELERAD parameter per items-rad (samma form som priceStats() redan använder
    // framgångsrikt), så GIN-indexet används per items-rad istället för en blind korsjoin.
    // Samma grundvillkor som priceStats: bara SÅLDA rader med riktigt slutpris och
    // similarity >= 0.45, redan avgjorda par uteslutna. Bilderna hämtas via JOIN LATERAL
    // (inte SELECT-subquery) så att avsaknad av bild FILTRERAR BORT paret - AI-verifieringen
    // tittar ändå bara på par där båda sidor har bild. Embeddingen (om beräknad - bakgrunds-
    // pass, kan ligga efter) hämtas med för bildlikhets-badgen, gatar INTE bort paret.
    `SELECT i.house, i.external_id, i.title, im.url AS image, im.embedding AS image_emb,
            ph.house AS cmp_house, ph.item_external_id AS cmp_external_id, ph.item_title AS cmp_title,
            cim.url AS cmp_image, cim.embedding AS cmp_image_emb,
            COALESCE(ph.final_total, ph.final_bid) AS cmp_price
     FROM items i
     JOIN LATERAL (
       SELECT ph2.house, ph2.item_external_id, ph2.item_title, ph2.final_total, ph2.final_bid
       FROM price_history ph2
       WHERE ph2.item_title % i.title AND ph2.sold AND ph2.final_bid > 0
         AND similarity(ph2.item_title, i.title) >= 0.45
         AND NOT EXISTS (SELECT 1 FROM match_verdicts v
                          WHERE v.house=i.house AND v.item_external_id=i.external_id
                            AND v.cmp_house=ph2.house AND v.cmp_external_id=ph2.item_external_id)
       ORDER BY similarity(ph2.item_title, i.title) DESC
       LIMIT 1
     ) ph ON true
     JOIN LATERAL (SELECT m.url, m.embedding FROM media m WHERE m.house=i.house AND m.owner_type='item'
                     AND m.owner_external_id=i.external_id AND m.kind='image'
                   ORDER BY m.sort NULLS LAST LIMIT 1) im ON true
     JOIN LATERAL (SELECT m.url, m.embedding FROM media m WHERE m.house=ph.house AND m.owner_type='item'
                     AND m.owner_external_id=ph.item_external_id AND m.kind='image'
                   ORDER BY m.sort NULLS LAST LIMIT 1) cim ON true
     WHERE i.status='active' AND i.est_count >= 1
     ORDER BY i.ends_at ASC NULLS LAST
     LIMIT 1`,
    );
    rows = res.rows;
  } catch (e) {
    if ((e as { code?: string }).code === "57014") { rows = []; } // statement_timeout - inget kort denna gång
    else throw e;
  } finally {
    client.release(true); // true = förstör anslutningen (bär SET statement_timeout) - läcker aldrig till poolen
  }
  const r = rows[0];
  if (!r) return null;
  const vecA = decodeVec(r.image_emb);
  const vecB = decodeVec(r.cmp_image_emb);
  const visualMatch = vecA && vecB ? Math.round(cosine(vecA, vecB) * 100) : null;
  return {
    house: r.house, externalId: r.external_id, title: r.title, image: r.image,
    cmpHouse: r.cmp_house, cmpExternalId: r.cmp_external_id, cmpTitle: r.cmp_title,
    cmpImage: r.cmp_image, cmpPrice: r.cmp_price, visualMatch,
  };
}

export async function decideComparison(
  house: string, externalId: string, cmpHouse: string, cmpExternalId: string, decision: "approve" | "reject",
): Promise<void> {
  await saveMatchVerdict(
    house, externalId, cmpHouse, cmpExternalId,
    { same: decision === "approve", reason: "manuell granskning", model: "human" },
    "human",
  );
}
