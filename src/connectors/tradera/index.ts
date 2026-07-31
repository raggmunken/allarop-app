/**
 * Tradera-crawler (ENBART sålt, för prishistorik). Hämtar sajtens egna
 * kategori-/söksidor via CloakBrowser (SSR-flight) med filtret itemStatus=Sold,
 * sorterat på sluttid fallande, och skriver slutpriserna till price_history
 * (+ media). Adaptiv djupgång via kategorifasetten: en nod som överstiger
 * sökningens 500-tak delas upp i sina underkategorier tills varje del ryms.
 *
 * GDPR: mapSoldItem sparar ALDRIG säljarens identitet (alias/memberId).
 *
 * Sålt-datat ackumuleras över körningar (ON CONFLICT DO UPDATE på
 * (house,item_external_id)), så återkommande pass fyller på i takt med nya sålda.
 * Återupptagbar cursor (job_state "tradera-sold") pekar på nästa rot-kategori.
 */

import { browserFetch } from "../../browser/cloak.ts";
import { parseSoldSearch } from "./flight.ts";
import { mapActiveItem, mapSoldItem, HOUSE } from "./map.ts";
import { TRADERA_ROOTS } from "./categories.ts";
import {
  upsertItem,
  upsertPriceHistory,
  upsertMedia,
  getJobState,
  setJobState,
} from "../../db/repo.ts";
import { feeModelForItem } from "../../fees/rules.ts";
import { traderaCategoryToKey } from "../../categories/tradera-map.ts";
import { lexicon } from "../../categories/learned.ts";

const CAP = 500; // Traderas sök-tak per fråga (itemsMatchedWithCap)
const PAGE_SIZE = 80;
const BASE = "https://www.tradera.com";
const JOB = "tradera-sold";
const FRESH_JOB = "tradera-fresh";

export interface CrawlStats {
  fetches: number;
  stored: number;
  categories: number;
}

export interface CrawlOptions {
  /** Bara en rot-kategori (id). Utelämna = alla rötter (med återupptagbar cursor). */
  rootId?: number;
  /** Max djup i kategoriträdet innan vi skördar det vi kan (default 4). */
  maxDepth?: number;
  /** Sätt false för att ignorera sparad cursor och börja från rot 0. */
  resume?: boolean;
  /** Stanna efter så här många sidhämtningar (skydd/politeness). 0 = obegränsat. */
  maxFetches?: number;
  log?: (msg: string) => void;
}

interface PriceBand { lo: number; hi: number }
// Slice = en (kategori, pris, län, objekttyp, säljartyp)-fråga. Fler dimensioner läggs på
// BARA när en slice ändå överstiger 500-taket → kringgår golvet (t.ex. hundratals serier på
// exakt samma pris) och når ALLA objekt. Dimensionerna appliceras lat (billigt: bara vid tak).
interface SoldSlice { price?: PriceBand; county?: string; itemType?: string; sellerType?: string }

// Traderas exakta fasettvärden (recon 2026-07-08).
const COUNTIES = [
  "Blekinge", "Dalarna", "Gavleborg", "Gotland", "Halland", "Jamtland", "Jonkoping",
  "Kalmar", "Kronoberg", "Norrbotten", "Skane", "Sodermanland", "Stockholm", "Uppsala",
  "Varmland", "Vasterbotten", "Vasternorrland", "Vastmanland", "VastraGotaland", "Orebro", "Ostergotland",
];
const ITEM_TYPES = ["Auction", "FixedPrice", "ContactOnly"];
const SELLER_TYPES = ["Private", "Company"];

function soldUrl(
  categoryId: number,
  page: number,
  sp: SoldSlice = {},
  status = "Sold",
  sortBy = "EndDateDescending",
): string {
  const p = new URLSearchParams({ itemStatus: status, sortBy });
  if (page > 1) p.set("paging", String(page));
  if (sp.price) { p.set("fromPrice", String(sp.price.lo)); p.set("toPrice", String(sp.price.hi)); }
  if (sp.county) p.set("county", sp.county);
  if (sp.itemType) p.set("itemType", sp.itemType);
  if (sp.sellerType) p.set("sellerType", sp.sellerType);
  return `${BASE}/category/${categoryId}?${p.toString()}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchSold(
  categoryId: number,
  page: number,
  sp: SoldSlice = {},
  status = "Sold",
  sortBy = "EndDateDescending",
) {
  const html = await browserFetch(soldUrl(categoryId, page, sp, status, sortBy), {
    waitUntil: "networkidle",
    dwellMs: 1200,
    timeoutMs: 60_000,
  });
  return parseSoldSearch(html);
}

// Seed-band för pris-slicing (SEK). Skevt (mest billigt) → täta låga band, glesa höga.
const PRICE_SEEDS = [0, 100, 200, 300, 500, 1000, 2500, 10000, 100000, 5_000_000];

/** Skörda en slices ALLA sidor (upp till taket). Returnerar antal lagrade. */
async function harvestAllPages(
  catId: number, name: string, sp: SoldSlice, first: Awaited<ReturnType<typeof fetchSold>>,
  req: Required<Pick<CrawlOptions, "maxFetches">>, stats: CrawlStats,
): Promise<void> {
  let stored = await harvestItems(first.items, name);
  const accessible = Math.min(first.totalItemCount, first.itemsMatchedWithCap || CAP);
  const pages = Math.ceil(accessible / PAGE_SIZE);
  for (let p = 2; p <= pages; p++) {
    if (req.maxFetches && stats.fetches >= req.maxFetches) break;
    await sleep(300);
    let r;
    try { r = await fetchSold(catId, p, sp); } catch { break; }
    stats.fetches++;
    if (!r.items.length) break;
    stored += await harvestItems(r.items, name);
  }
  stats.stored += stored;
}

/**
 * Skörda en slice HELT. Under taket → skörda alla sidor. Över taket → dela på NÄSTA lediga
 * dimension: pris (bisekt) → län (21) → objekttyp (3) → säljartyp (2). Varje dimension
 * multiplicerar kapaciteten (500 → 500×21×3×2 ≈ 63k per prisband) → bryter pris-golvet och
 * fångar allt. Escalering sker BARA vid tak, så de flesta löv rör aldrig län-slicing.
 */
async function harvestSlice(
  catId: number, name: string, sp: SoldSlice,
  req: Required<Pick<CrawlOptions, "maxFetches">>, stats: CrawlStats,
): Promise<void> {
  if (req.maxFetches && stats.fetches >= req.maxFetches) return;
  let res;
  try { res = await fetchSold(catId, 1, sp); } catch { return; }
  stats.fetches++;
  const total = res.totalItemCount;
  if (total === 0) return;
  if (total <= CAP) { await harvestAllPages(catId, name, sp, res, req, stats); return; }
  // Över taket → dela. 1) pris (om bandet har bredd).
  if (sp.price && sp.price.hi - sp.price.lo > 1) {
    const mid = Math.floor((sp.price.lo + sp.price.hi) / 2);
    await harvestSlice(catId, name, { ...sp, price: { lo: sp.price.lo, hi: mid } }, req, stats);
    await harvestSlice(catId, name, { ...sp, price: { lo: mid, hi: sp.price.hi } }, req, stats);
    return;
  }
  // 2) län (21) - bryter pris-golvet (många objekt på samma pris fördelas över län).
  if (!sp.county) {
    for (const c of COUNTIES) { if (req.maxFetches && stats.fetches >= req.maxFetches) return; await harvestSlice(catId, name, { ...sp, county: c }, req, stats); }
    return;
  }
  // 3) objekttyp (3).
  if (!sp.itemType) {
    for (const t of ITEM_TYPES) { if (req.maxFetches && stats.fetches >= req.maxFetches) return; await harvestSlice(catId, name, { ...sp, itemType: t }, req, stats); }
    return;
  }
  // 4) säljartyp (2).
  if (!sp.sellerType) {
    for (const s of SELLER_TYPES) { if (req.maxFetches && stats.fetches >= req.maxFetches) return; await harvestSlice(catId, name, { ...sp, sellerType: s }, req, stats); }
    return;
  }
  // Alla dimensioner uttömda och fortf. >500 (i praktiken aldrig) → ta de 500 vi når.
  await harvestAllPages(catId, name, sp, res, req, stats);
}

/** Skörda en kategori HELT via seed-prisband + flerdimensionell slicing. */
async function harvestBanded(
  catId: number,
  name: string,
  req: Required<Pick<CrawlOptions, "maxFetches">>,
  stats: CrawlStats,
): Promise<void> {
  for (let i = 0; i < PRICE_SEEDS.length - 1; i++) {
    if (req.maxFetches && stats.fetches >= req.maxFetches) return;
    await harvestSlice(catId, name, { price: { lo: PRICE_SEEDS[i]!, hi: PRICE_SEEDS[i + 1]! } }, req, stats);
  }
}

/** Skriv en sidas objekt till price_history + media. Returnerar antal lagrade. */
async function harvestItems(
  items: ReturnType<typeof parseSoldSearch>["items"],
  categoryName: string,
): Promise<number> {
  let n = 0;
  for (const raw of items) {
    const it = mapSoldItem(raw);
    if (!it) continue;
    await upsertPriceHistory(it, feeModelForItem(HOUSE, it.currency), null, categoryName);
    if (it.media.length) await upsertMedia(HOUSE, "item", it.externalId, it.media);
    n++;
  }
  return n;
}

async function crawlCategory(
  categoryId: number,
  categoryName: string,
  depth: number,
  opts: Required<Pick<CrawlOptions, "maxDepth" | "maxFetches">>,
  stats: CrawlStats,
  log: (m: string) => void,
  seen: Set<number>,
): Promise<void> {
  if (opts.maxFetches && stats.fetches >= opts.maxFetches) return;
  if (seen.has(categoryId)) return; // cykelskydd (Traderas fasett kan peka tillbaka uppåt)
  seen.add(categoryId);
  let first;
  try {
    first = await fetchSold(categoryId, 1);
  } catch (e) {
    log(`  [${categoryName}] hoppar över: ${(e as Error).message}`);
    return;
  }
  stats.fetches++;
  const total = first.totalItemCount;
  const accessible = Math.min(total, first.itemsMatchedWithCap || CAP);
  // Bara ICKE-besökta barn → bryter cykler. Slutar recursionen här (inga nya barn) tar
  // pris-slicingen nedan HELA subträdet, så täckningen förblir komplett ändå.
  const kids = first.childCategories.filter((c) => c.count > 0 && !seen.has(c.id));

  // Överstiger taket och har (nya) underkategorier → gå djupare för granulära etiketter.
  if (total > CAP && depth < opts.maxDepth && kids.length > 0) {
    log(`  [${categoryName}] ${total} sålda > ${CAP} → delar i ${kids.length} underkategorier`);
    for (const child of kids) {
      if (opts.maxFetches && stats.fetches >= opts.maxFetches) return;
      await crawlCategory(child.id, child.name || categoryName, depth + 1, opts, stats, log, seen);
    }
    return;
  }

  // Skörda den här noden. Över 500-taket (löv/maxdjup) → PRIS-SLICING som tömmer hela
  // kategorin; annars vanlig paginering (sida 1 redan hämtad).
  stats.categories++;
  const before = stats.stored;
  if (total > CAP) {
    await harvestBanded(categoryId, categoryName, opts, stats);
  } else {
    let stored = await harvestItems(first.items, categoryName);
    const pages = Math.ceil(accessible / PAGE_SIZE);
    for (let p = 2; p <= pages; p++) {
      if (opts.maxFetches && stats.fetches >= opts.maxFetches) break;
      await sleep(400);
      let res;
      try {
        res = await fetchSold(categoryId, p);
      } catch {
        break;
      }
      stats.fetches++;
      if (!res.items.length) break;
      stored += await harvestItems(res.items, categoryName);
    }
    stats.stored += stored;
  }
  log(`  [${categoryName}] ${total} sålda, lagrade ${stats.stored - before}${total > CAP ? " (pris-slicing)" : ""} (djup ${depth})`);
}

/**
 * FÄRSKHETS-SVEP (för schemaläggaren): hämtar sida 1 (nyast sålt först) för några
 * rot-kategorier per cykel via en roterande cursor. Fångar KONTINUERLIGT nysålda
 * objekt brett över hela sajten - billigt (få hämtningar) och alltid uppdaterat.
 * Historisk djup byggs separat av crawlTraderaSold (djup backfill-trickle/CLI).
 */
export async function crawlTraderaFresh(opts: {
  rootsPerCycle?: number;
  freshPages?: number;
  log?: (m: string) => void;
} = {}): Promise<CrawlStats> {
  const log = opts.log ?? (() => {});
  const rootsPerCycle = opts.rootsPerCycle ?? 6;
  const freshPages = Math.max(1, opts.freshPages ?? 1);
  const stats: CrawlStats = { fetches: 0, stored: 0, categories: 0 };
  const n = TRADERA_ROOTS.length;

  const st = await getJobState(FRESH_JOB);
  let idx = st.done ? 0 : Math.min(st.cursor_offset, n - 1);
  for (let k = 0; k < rootsPerCycle && k < n; k++) {
    const r = TRADERA_ROOTS[idx];
    if (r) {
      for (let p = 1; p <= freshPages; p++) {
        let res;
        try { res = await fetchSold(r.id, p); } catch { break; }
        stats.fetches++;
        if (!res.items.length) break;
        stats.stored += await harvestItems(res.items, r.name);
        if (res.items.length < PAGE_SIZE) break; // sista sidan
        if (p < freshPages) await sleep(400);
      }
      stats.categories++;
    }
    idx = (idx + 1) % n;
  }
  await setJobState(FRESH_JOB, idx, n, idx === 0);
  log(`Tradera fresh: ${stats.stored} sålda upsertade från ${stats.categories} kategorier (${stats.fetches} hämtningar)`);
  return stats;
}

/**
 * Kör en crawl. Utan rootId: iterera alla rötter med återupptagbar cursor (nästa
 * körning fortsätter där den slutade; wrappar runt när alla rötter är avbetade).
 */
export async function crawlTraderaSold(opts: CrawlOptions = {}): Promise<CrawlStats> {
  const log = opts.log ?? (() => {});
  // maxDepth 8: recursionen når Traderas RIKTIGA löv-kategorier (träden är sällan djupare) →
  // granulära etiketter + mindre per-löv-slicing. Djupare-än-löv stannar naturligt (inga barn).
  const req = { maxDepth: opts.maxDepth ?? 8, maxFetches: opts.maxFetches ?? 0 };
  const stats: CrawlStats = { fetches: 0, stored: 0, categories: 0 };

  const roots = opts.rootId != null
    ? TRADERA_ROOTS.filter((r) => r.id === opts.rootId)
    : TRADERA_ROOTS;
  if (roots.length === 0) {
    log(`Ingen rot-kategori matchar id ${opts.rootId}`);
    return stats;
  }

  let startIdx = 0;
  const useCursor = opts.rootId == null && opts.resume !== false;
  if (useCursor) {
    const st = await getJobState(JOB);
    startIdx = st.done ? 0 : Math.min(st.cursor_offset, roots.length - 1);
  }

  for (let i = startIdx; i < roots.length; i++) {
    if (req.maxFetches && stats.fetches >= req.maxFetches) {
      if (useCursor) await setJobState(JOB, i, roots.length, false);
      log(`Fetch-tak (${req.maxFetches}) nått, pausar vid rot ${i}/${roots.length}.`);
      return stats;
    }
    const r = roots[i];
    if (!r) continue;
    log(`Rot ${i + 1}/${roots.length}: ${r.name} (${r.id})`);
    await crawlCategory(r.id, r.name, 0, req, stats, log, new Set<number>());
    if (useCursor) {
      const next = i + 1 >= roots.length ? 0 : i + 1;
      await setJobState(JOB, next, roots.length, next === 0);
    }
  }
  return stats;
}

/* ---- AKTIVA objekt till items (syns i sök/listor) ---- */

const ACTIVE_SWEEP_JOB = "tradera-active-sweep";

/** Skriv en sidas AKTIVA objekt till items (upsert = fräsch bid/tid varje svep). */
async function harvestActiveItems(
  items: ReturnType<typeof parseSoldSearch>["items"],
): Promise<number> {
  let n = 0;
  for (const raw of items) {
    const it = mapActiveItem(raw);
    if (!it) continue;
    await upsertItem(it);
    n++;
  }
  return n;
}

/**
 * AKTIV-SVEP (för schemaläggaren): hämtar AKTIVA Tradera-objekt sorterade slutar-
 * snart-först (EndDateAscending) för några rot-kategorier per cykel via roterande
 * cursor. Objekten upsertas till items och syns i sök/listor; upsert gör varje svep
 * billigt (bud/sluttid fräschas), och finalizePastDue avslutar objekten när sluttiden
 * passerat. GDPR: ingen säljaridentitet lagras (mapActiveItem, samma regel som sålt).
 *
 * Takmedveten design: samma CloakBrowser-last som tradera-fresh → få rötter/sidor per
 * cykel, sorteringen gör att vi ALLTID fångar det mest tidkritiska (slutar snart) först
 * i stället för att bränna hämtningar på objekt med veckor kvar.
 */
export async function crawlTraderaActiveSweep(opts: {
  rootsPerCycle?: number;
  pagesPerRoot?: number;
  log?: (m: string) => void;
} = {}): Promise<CrawlStats> {
  const log = opts.log ?? (() => {});
  const rootsPerCycle = opts.rootsPerCycle ?? 8;
  const pagesPerRoot = Math.max(1, opts.pagesPerRoot ?? 3);
  const stats: CrawlStats = { fetches: 0, stored: 0, categories: 0 };
  const n = TRADERA_ROOTS.length;

  const st = await getJobState(ACTIVE_SWEEP_JOB);
  let idx = st.done ? 0 : Math.min(st.cursor_offset, n - 1);
  for (let k = 0; k < rootsPerCycle && k < n; k++) {
    const r = TRADERA_ROOTS[idx];
    if (r) {
      for (let p = 1; p <= pagesPerRoot; p++) {
        let res;
        try {
          res = await fetchSold(r.id, p, {}, "Active", "EndDateAscending");
        } catch (e) {
          log(`tradera-aktiv: [${r.name}] sida ${p} fel: ${(e as Error).message}`);
          break;
        }
        stats.fetches++;
        if (!res.items.length) break;
        stats.stored += await harvestActiveItems(res.items);
        if (res.items.length < PAGE_SIZE) break; // sista sidan
        if (p < pagesPerRoot) await sleep(400);
      }
      stats.categories++;
    }
    idx = (idx + 1) % n;
  }
  await setJobState(ACTIVE_SWEEP_JOB, idx, n, idx === 0);
  log(`tradera-aktiv: ${stats.stored} aktiva upsertade från ${stats.categories} kategorier (${stats.fetches} hämtningar)`);
  return stats;
}

/* ---- AKTIVA objekt för TRÄNING (ej lagring) ---- */

const ACTIVE_JOB = "tradera-active";

export interface ActiveTrainStats { fetches: number; trained: number; categories: number }

/** Träna lexikonet på ett prov aktiva titlar i EN kategori (mappad → vår nyckel). */
async function trainActiveItems(
  items: ReturnType<typeof parseSoldSearch>["items"],
  key: string,
): Promise<number> {
  const entries = items
    .map((it) => ({ title: (it.shortDescription ?? "").trim(), category: key }))
    .filter((e) => e.title.length > 0);
  if (entries.length) await lexicon.learn(entries);
  return entries.length;
}

async function trainCategoryActive(
  categoryId: number,
  categoryName: string,
  depth: number,
  req: { maxDepth: number; maxFetches: number; trainPages: number },
  stats: ActiveTrainStats,
  seen: Set<number>,
): Promise<void> {
  if (req.maxFetches && stats.fetches >= req.maxFetches) return;
  if (seen.has(categoryId)) return;
  seen.add(categoryId);
  let first;
  try { first = await fetchSold(categoryId, 1, undefined, "Active"); } catch { return; }
  stats.fetches++;
  const kids = first.childCategories.filter((c) => c.count > 0 && !seen.has(c.id));
  // Gå till LÖV (där sökt kategori = objektens kategori) för granulära etiketter.
  if (depth < req.maxDepth && kids.length > 0) {
    for (const child of kids) {
      if (req.maxFetches && stats.fetches >= req.maxFetches) return;
      await trainCategoryActive(child.id, child.name || categoryName, depth + 1, req, stats, seen);
    }
    return;
  }
  const key = traderaCategoryToKey(categoryName);
  if (!key) return; // tvetydigt namn → hoppa (hellre mindre data än fel)
  stats.categories++;
  let trained = await trainActiveItems(first.items, key);
  const pages = Math.min(req.trainPages, Math.ceil(Math.min(first.totalItemCount, CAP) / PAGE_SIZE));
  for (let p = 2; p <= pages; p++) {
    if (req.maxFetches && stats.fetches >= req.maxFetches) break;
    await sleep(300);
    let res;
    try { res = await fetchSold(categoryId, p, undefined, "Active"); } catch { break; }
    stats.fetches++;
    if (!res.items.length) break;
    trained += await trainActiveItems(res.items, key);
  }
  stats.trained += trained;
}

/**
 * Bred TRÄNINGS-svep över AKTIVA Tradera-objekt: rekurserar till löv-kategorier och
 * tränar lexikonet på ett prov (trainPages sidor) aktiva titlar per löv. LAGRAR INGET
 * (aktiva är ej sålda) - bara token→kategori. Ger snabb BRED taxonomi-täckning (aktiva
 * objekt finns i varje kategori NU) medan sålt-crawlen mal djupt över dagar.
 *
 * ENGÅNGS-svep (CLI): utan per-objekt-cursor skulle upprepade svep dubbelräkna samma
 * aktiva annonser → körs en gång för täckning, inte som löpande schemaläggarpass.
 * Återupptagbar mitt i via rot-cursor (job_state "tradera-active").
 */
export async function crawlTraderaActiveTrain(opts: {
  maxDepth?: number;
  maxFetches?: number;
  trainPages?: number;
  resume?: boolean;
  log?: (m: string) => void;
} = {}): Promise<ActiveTrainStats> {
  const log = opts.log ?? (() => {});
  const req = { maxDepth: opts.maxDepth ?? 4, maxFetches: opts.maxFetches ?? 0, trainPages: opts.trainPages ?? 2 };
  const stats: ActiveTrainStats = { fetches: 0, trained: 0, categories: 0 };
  await lexicon.ensureLoaded();
  const n = TRADERA_ROOTS.length;
  const st = await getJobState(ACTIVE_JOB);
  const startIdx = (opts.resume === false || st.done) ? 0 : Math.min(st.cursor_offset, n - 1);
  for (let i = startIdx; i < n; i++) {
    if (req.maxFetches && stats.fetches >= req.maxFetches) {
      await setJobState(ACTIVE_JOB, i, n, false);
      return stats;
    }
    const r = TRADERA_ROOTS[i];
    if (!r) continue;
    log(`aktiv-träning rot ${i + 1}/${n}: ${r.name} (${stats.trained} lärt hittills)`);
    await trainCategoryActive(r.id, r.name, 0, req, stats, new Set<number>());
    const next = i + 1 >= n ? 0 : i + 1;
    await setJobState(ACTIVE_JOB, next, n, next === 0);
  }
  return stats;
}
