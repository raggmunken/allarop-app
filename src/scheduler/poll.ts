/**
 * Adaptiv schemaläggare (aktiva flödet + automatisk historik).
 *   - Full katalog-refresh var FULL_REFRESH_MS (default 10 min).
 *   - Tät poll var HOT_POLL_MS (default 45 s) för "heta" objekt: aktiva objekt
 *     som avslutas inom HOT_WINDOW_MS (default 60 min) eller redan passerat.
 *   - Soft close: pollen uppdaterar ends_at när sena bud förlänger, och
 *     finaliserar objekt till price_history när de verkligt avslutats.
 *   - Backfill-trickle: betar av AVSLUTADE arkivet (nyast först) några parts
 *     per cykel tills det är klart. Helt separat från det aktiva flödet.
 *   - Backstop: finaliserar förfallna objekt med marginal (soft-close-säkert).
 */

import { Connector, FlatSource } from "../connectors/types.ts";
import { pool } from "../db/pool.ts";
import {
  finalizeEndedItem,
  finalizePastDue,
  updateItemEndsAt,
  upsertBids,
  upsertItem,
} from "../db/repo.ts";
import { feeModelFor } from "../fees/rules.ts";
import { llmClassifyImagePass, llmClassifyPass } from "../ai/classify-llm.ts";
import { readPlatePass, vehicleEnrichPass } from "../vehicle/enrich.ts";
import { ocrEnrichPass } from "../ai/ocr-enrich.ts";
import { embedPass } from "../ai/embed-enrich.ts";
import { getMaxSpeed } from "../db/settings.ts";
import { watchPass } from "../db/watch.ts";
import { embedTextPass } from "../ai/embed-text-enrich.ts";
import { konkursPass } from "../db/konkurs.ts";
import { geocodePass } from "../geo/geocode.ts";
import { estimatePass } from "../price/estimate.ts";
import { mirrorPendingImages } from "../storage/images.ts";
import { backfillEndedBatch } from "./backfill.ts";
import { crawlTraderaFresh, crawlTraderaSold } from "../connectors/tradera/index.ts";
import { trainTraderaLexiconPass } from "../categories/train-tradera.ts";
import {
  backfillFlatEnded,
  fetchBids,
  ingestAll,
  ingestFlat,
  sweepFlatActive,
} from "./pipeline.ts";
import { flush as flushIndexNow } from "./indexnow.ts";

const FULL_REFRESH_MS = Number(process.env.FULL_REFRESH_MS ?? 1_800_000); // 30 min
/** Loopens grundtakt — finaste pollintervallet (sista minuten pollas var 10:e s). */
const BASE_TICK_MS = Number(process.env.BASE_TICK_MS ?? 10_000);
/** Hur ofta Tovek-arkivets backfill-trickle körs (inte varje grundtick). */
const BACKFILL_INTERVAL_MS = Number(process.env.BACKFILL_INTERVAL_MS ?? 60_000);
const MIRROR_IMAGES = process.env.MIRROR_IMAGES !== "0";
const BACKFILL_ENABLED = process.env.BACKFILL_ENABLED !== "0";
const BACKFILL_PARTS_PER_CYCLE = Number(process.env.BACKFILL_PARTS_PER_CYCLE ?? 3);
/** Sidor av aktiva katalogen att sopa per full refresh (rullande cursor → upptäcker
 *  nya auktioner och täcker hela katalogen över flera cykler). */
const FLAT_SWEEP_PAGES = Number(process.env.FLAT_SWEEP_PAGES ?? 40);
/** Marginal innan ett platt-objekt finaliseras (skydd mot soft-close + refresh-lag). */
const FLAT_GRACE_MS = Number(process.env.FLAT_GRACE_MS ?? 1_200_000);
/** Sidor av avslutad-arkivet (Auctionet m.fl.) att backfilla per full refresh. */
const FLAT_ENDED_PAGES_PER_CYCLE = Number(process.env.FLAT_ENDED_PAGES_PER_CYCLE ?? 2);
/** Antal sidor (sida 1 = hetast) att tät-refresha för "slutar snart"-sorterade källor. */
const HOT_PAGES = Number(process.env.HOT_PAGES ?? 1);
/** LLM-klassning av nyckelords-missar (kräver OPENROUTER_API_KEY): en batch per intervall. */
const AI_CLASSIFY_INTERVAL_MS = Number(process.env.AI_CLASSIFY_INTERVAL_MS ?? 300_000);
/** Bild-klassning av objekt där texten inte räckte (vision-modell, färre/dyrare anrop). */
const AI_IMAGE_CLASSIFY_INTERVAL_MS = Number(process.env.AI_IMAGE_CLASSIFY_INTERVAL_MS ?? 600_000);
const VEHICLE_ENRICH_INTERVAL_MS = Number(process.env.VEHICLE_ENRICH_INTERVAL_MS ?? 120_000);
const PLATE_READ_INTERVAL_MS = Number(process.env.PLATE_READ_INTERVAL_MS ?? 180_000);
const OCR_ENRICH_INTERVAL_MS = Number(process.env.OCR_ENRICH_INTERVAL_MS ?? 90_000);
const ESTIMATE_INTERVAL_MS = Number(process.env.ESTIMATE_INTERVAL_MS ?? 45_000);
const EMBED_INTERVAL_MS = Number(process.env.EMBED_INTERVAL_MS ?? 60_000);
// Max-speed (settings.max_speed via /status): maxa embedding med datorns fulla kraft.
const EMBED_MAX_INTERVAL_MS = Number(process.env.EMBED_MAX_INTERVAL_MS ?? 250);
const EMBED_MAX_BATCH = Number(process.env.EMBED_MAX_BATCH ?? 96);
const EMBED_MAX_CONCURRENCY = Number(process.env.EMBED_MAX_CONCURRENCY ?? 8);
const EMBED_TEXT_INTERVAL_MS = Number(process.env.EMBED_TEXT_INTERVAL_MS ?? 45_000);
const KONKURS_INTERVAL_MS = Number(process.env.KONKURS_INTERVAL_MS ?? 300_000);
const WATCH_INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS ?? 60_000);
const GEOCODE_INTERVAL_MS = Number(process.env.GEOCODE_INTERVAL_MS ?? 60_000);
// Tradera-prisdata (ENBART sålt): kontinuerligt i bakgrunden, likt husen. Browser-tungt
// (CloakBrowser, delas med Blinto m.fl.) → medvetet försiktiga takter. Sätt TRADERA_ENABLED=0
// för att stänga av. Två pass: FÄRSKHET (sida 1, nyast först, brett) + DJUP backfill-trickle.
const TRADERA_ENABLED = process.env.TRADERA_ENABLED !== "0";
const TRADERA_FRESH_MS = Number(process.env.TRADERA_FRESH_MS ?? 150_000); // ~2,5 min
const TRADERA_ROOTS_PER_CYCLE = Number(process.env.TRADERA_ROOTS_PER_CYCLE ?? 6);
const TRADERA_FRESH_PAGES = Number(process.env.TRADERA_FRESH_PAGES ?? 1);
const TRADERA_BACKFILL_MS = Number(process.env.TRADERA_BACKFILL_MS ?? 600_000); // 10 min
const TRADERA_BACKFILL_FETCHES = Number(process.env.TRADERA_BACKFILL_FETCHES ?? 25);
// Lexikon-träning på Traderas märkta data (växer med crawlen).
const TRADERA_TRAIN_MS = Number(process.env.TRADERA_TRAIN_MS ?? 300_000); // 5 min
const TRADERA_TRAIN_ROWS = Number(process.env.TRADERA_TRAIN_ROWS ?? 20_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Senaste tät-refresh av sida 1 per hus (för "slutar snart"-sorterade källor). */
const hotPageAt = new Map<string, number>();

/** Millisekunder tills det aktiva objekt som avslutas närmast i ett hus (eller null). */
async function soonestActiveMs(house: string): Promise<number | null> {
  const res = await pool.query<{ ms: string | null }>(
    `SELECT extract(epoch from (min(ends_at) - now())) * 1000 AS ms
     FROM items WHERE house=$1 AND status='active' AND ends_at > now()`,
    [house],
  );
  const ms = res.rows[0]?.ms;
  return ms != null ? Number(ms) : null;
}

/** Pollintervall (ms) utifrån tid kvar till avslut — samma trappa som dueItems. */
function tierInterval(msLeft: number): number | null {
  if (msLeft <= 60_000) return 10_000; // sista minuten
  if (msLeft <= 300_000) return 60_000; // < 5 min
  if (msLeft <= 900_000) return 180_000; // < 15 min
  return null; // längre bort → full refresh räcker
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Objekt som är "dags att uppdatera" — pollfrekvensen trappas upp ju närmare
 * sluttiden objektet är (tid kvar → intervall sedan senaste uppdatering):
 *   < 1 min kvar  → var 10:e sekund   (fånga sista buden + soft-close-förlängning)
 *   < 5 min kvar  → varje minut
 *   < 15 min kvar → var 3:e minut
 * Objekt med 15–60 min kvar (och längre) täcks av full refresh (var 30:e min).
 * Objekt mer än ~20 min förbi sluttiden lämnas till finaliseringen.
 */
async function dueItems(house: string): Promise<string[]> {
  const res = await pool.query<{ external_id: string }>(
    `SELECT external_id FROM items
     WHERE house=$1 AND status='active' AND ends_at IS NOT NULL
       AND ends_at > now() - interval '20 minutes'
       AND (
         (ends_at <= now() + interval '1 minute'  AND last_seen < now() - interval '10 seconds') OR
         (ends_at <= now() + interval '5 minutes'  AND last_seen < now() - interval '1 minute')  OR
         (ends_at <= now() + interval '15 minutes' AND last_seen < now() - interval '3 minutes')
       )
     ORDER BY ends_at ASC
     LIMIT 500`,
    [house],
  );
  return res.rows.map((r) => r.external_id);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Polla heta objekt: uppdatera bud + (ev. förlängd) sluttid, finalisera avslutade. */
async function pollHot(connector: Connector): Promise<{ polled: number; ended: number }> {
  const ids = await dueItems(connector.house);
  if (ids.length === 0) return { polled: 0, ended: 0 };
  let polled = 0;
  let ended = 0;

  // Soft-close-medveten poll om connectorn stödjer det; annars enkel budpoll.
  if (connector.pollItems) {
    for (const ids50 of chunk(ids, 50)) {
      try {
        const map = await connector.pollItems(ids50);
        for (const [id, r] of map) {
          if (r.bids.length > 0) {
            await upsertBids(id, connector.house, r.bids);
            polled++;
          }
          await updateItemEndsAt(connector.house, id, r.endsAt);
          if (r.ended) {
            await finalizeEndedItem(connector.house, id);
            ended++;
          }
        }
      } catch (e) {
        log(`hot-poll fel: ${(e as Error).message}`);
      }
    }
  } else {
    const bidsMap = await fetchBids(connector, ids);
    for (const [id, bids] of bidsMap) {
      if (bids.length > 0) {
        await upsertBids(id, connector.house, bids);
        polled++;
      }
    }
  }
  return { polled, ended };
}

/**
 * Platt-källa: håll objekt nära avslut färska och finalisera avslutade.
 *   - Om källan stödjer fetchItem (Riksauktioner): hämta varje hett objekt enskilt
 *     för exakt slutpris + ev. förlängd sluttid; finalisera direkt om källan säger
 *     att det avslutats.
 *   - Backstop (alla platta källor): finalisera förfallna objekt till price_history
 *     (sista kända pris) med marginal mot soft-close/refresh-lag.
 */
async function pollHotFlat(
  source: FlatSource,
): Promise<{ polled: number; ended: number }> {
  let polled = 0;
  let ended = 0;

  if (source.fetchItems) {
    // Batchad per-objekt-hämtning (Blinto): ETT browser-anrop för alla heta objekt
    // → blockerar inte loopen när många avslutas samtidigt.
    const ids = await dueItems(source.house);
    if (ids.length > 0) {
      const feeModel = feeModelFor(source.house);
      try {
        const map = await source.fetchItems(ids);
        for (const [id, r] of map) {
          await upsertItem(r.item, feeModel);
          if (r.bids.length > 0) await upsertBids(id, source.house, r.bids);
          await updateItemEndsAt(source.house, id, r.item.endsAt ?? null);
          polled++;
          if (r.item.status !== "active") {
            await finalizeEndedItem(source.house, id);
            ended++;
          }
        }
      } catch (e) {
        log(`flat hot-poll fel (${source.house}): ${(e as Error).message}`);
      }
    }
  } else if (source.fetchItem) {
    // Per-objekt-hämtning (Riksauktioner): exakt och billigt per hett objekt.
    const ids = await dueItems(source.house);
    const feeModel = feeModelFor(source.house);
    for (const id of ids) {
      try {
        const r = await source.fetchItem(id);
        if (!r) continue; // borta ur källan → backstop nedan finaliserar
        await upsertItem(r.item, feeModel);
        if (r.bids.length > 0) await upsertBids(id, source.house, r.bids);
        await updateItemEndsAt(source.house, id, r.item.endsAt ?? null);
        polled++;
        if (r.item.status !== "active") {
          // Källan säger avslutad → finalisera med exakt slutpris direkt.
          await finalizeEndedItem(source.house, id);
          ended++;
        }
      } catch (e) {
        log(`flat hot-poll fel (${source.house}/${id}): ${(e as Error).message}`);
      }
    }
  } else if (source.endingSortedFirst) {
    // Ingen per-objekt-endpoint (Auctionet) men "slutar snart"-sorterad → tät-
    // refresha sida 1 i takt med hur nära det närmaste objektet är sitt avslut.
    const ms = await soonestActiveMs(source.house);
    const interval = ms != null ? tierInterval(ms) : null;
    if (interval != null && Date.now() - (hotPageAt.get(source.house) ?? 0) >= interval) {
      hotPageAt.set(source.house, Date.now());
      try {
        const r = await ingestFlat(source, { ended: false, maxPages: HOT_PAGES });
        polled += r.items;
      } catch (e) {
        log(`flat hot-page fel (${source.house}): ${(e as Error).message}`);
      }
    }
  }

  ended += await finalizePastDue(source.house, FLAT_GRACE_MS);
  return { polled, ended };
}

/**
 * Full refresh: hämta bud för alla aktiva objekt + svep flat-källornas kataloger
 * + arkiv-backfill + bildspegling. KAN TA FLERA MINUTER (Blinto live+berikning,
 * Klaravik ~3000, Tovek-bud) → körs i BAKGRUNDEN från loopen så hot-pollen (som
 * håller snart-avslutande objekt färska var ~10 s) aldrig blockeras.
 */
async function runFullRefresh(
  connector: Connector,
  flatSources: FlatSource[],
): Promise<void> {
  if (connector.ensureFresh && (await connector.ensureFresh())) {
    log("Ny deploy upptäckt — hashar uppdaterade.");
  }
  // Hämta bud för ALLA aktiva objekt (batchat) så priser hålls färska,
  // inte bara för objekt som snart avslutas.
  const stats = await ingestAll(connector, { fetchBids: true });
  const finalized = await finalizePastDue(connector.house);
  // Svep flat-källornas aktiva katalog (rullande) → upptäck nya auktioner
  // + täck hela katalogen över flera cykler. Bud ligger inbäddade i datan.
  let flatItems = 0;
  for (const fs of flatSources) {
    try {
      const r = await sweepFlatActive(fs, FLAT_SWEEP_PAGES);
      flatItems += r.items;
    } catch (e) {
      log(`flat-svep fel (${fs.house}): ${(e as Error).message}`);
    }
  }
  // Backfill-trickle av platta källors AVSLUTAD-arkiv (Auctionet) → historik.
  let flatArchive = 0;
  if (BACKFILL_ENABLED) {
    for (const fs of flatSources) {
      if (!fs.hasEndedArchive) continue;
      try {
        const r = await backfillFlatEnded(fs, FLAT_ENDED_PAGES_PER_CYCLE);
        flatArchive += r.items;
        if (r.items > 0) {
          log(
            `${fs.house} arkiv-backfill: +${r.items} objekt (sida ${r.offset}` +
              `${r.total != null ? "/~" + Math.ceil(r.total / 100) : ""})` +
              `${r.doneAll ? " — KLART" : ""}`,
          );
        }
      } catch (e) {
        log(`arkiv-backfill fel (${fs.house}): ${(e as Error).message}`);
      }
    }
  }
  let mirrored = 0;
  if (MIRROR_IMAGES) mirrored = await mirrorPendingImages(100);
  log(
    `full refresh: ${stats.parts} parts, ${stats.items} items, ` +
      `flat ${flatItems}, arkiv ${flatArchive}, backstop ${finalized}, bilder ${mirrored}`,
  );
}

/** Kör schemaläggaren tills `signal` aborteras (eller för evigt). */
export async function runScheduler(
  connector: Connector,
  signal?: AbortSignal,
  flatSources: FlatSource[] = [],
): Promise<void> {
  let backoff = 1000;
  let lastFull = 0;
  let fullRunning = false;
  let lastBackfill = 0;
  let lastLlmClassify = 0;
  let llmRunning = false;
  let lastImageClassify = 0;
  let imageClassifyRunning = false;
  let lastVehicleEnrich = 0;
  let vehicleRunning = false;
  let lastPlateRead = 0;
  let plateRunning = false;
  let lastOcr = 0;
  let ocrRunning = false;
  let lastEstimate = 0;
  let estimateRunning = false;
  let maxSpeed = false;
  let lastEmbedText = 0;
  let embedTextRunning = false;
  let lastKonkurs = 0;
  let lastWatch = 0;
  let watchRunning = false;
  let lastGeocode = 0;
  let geocodeRunning = false;
  let lastTraderaFresh = 0;
  let traderaFreshRunning = false;
  let lastTraderaBackfill = 0;
  let traderaBackfillRunning = false;
  let lastTraderaTrain = 0;
  let traderaTrainRunning = false;

  log(
    `Schemaläggare startad: full=${FULL_REFRESH_MS}ms, tick=${BASE_TICK_MS}ms ` +
      `(sista min var 10s, <5min varje min), ` +
      `backfill=${BACKFILL_ENABLED ? BACKFILL_PARTS_PER_CYCLE + " parts/" + BACKFILL_INTERVAL_MS + "ms" : "av"}`,
  );

  // Dedikerad bild-embedding-loop, FRIKOPPLAD från 10s-huvudticken → kör pass back-to-back
  // så sidecaren hålls mättad. Läser maxSpeed live (uppdateras av huvudloopen). Max-speed →
  // stor batch + hög concurrency + kort paus (datorns fulla kraft); annars sök-vänligt.
  const embedLoop = async (): Promise<void> => {
    while (!signal?.aborted) {
      // Läs max-speed-flaggan FÄRSKT varje pass (settings.max_speed via /status) → toggeln slår
      // igenom vid nästa pass-start (snabbt på GPU där ett pass tar sekunder).
      let on = false;
      try { on = await getMaxSpeed(); } catch { /* DB-glapp → behåll av */ }
      if (on !== maxSpeed) { maxSpeed = on; log(`max-speed ${on ? "PÅ - maxar embedding (full kraft)" : "av - sök-vänlig takt"}`); }
      const batch = on ? EMBED_MAX_BATCH : Number(process.env.EMBED_BATCH ?? 24);
      const conc = on ? EMBED_MAX_CONCURRENCY : Number(process.env.EMBED_CONCURRENCY ?? 1);
      try {
        const r = await embedPass(batch, conc);
        if (r.scanned > 0) log(`embed: ${r.embedded}/${r.scanned} huvudbilder embeddade (visuell gate)${on ? " [max]" : ""}`);
        // scanned 0 = inget kvar (vänta längre), <0 = sidecar nere (kort backoff), annars kort paus.
        await sleep(r.scanned === 0 ? 30_000 : r.scanned < 0 ? 5_000 : (on ? EMBED_MAX_INTERVAL_MS : EMBED_INTERVAL_MS));
      } catch (e) {
        log(`embed fel: ${(e as Error).message}`);
        await sleep(10_000);
      }
    }
  };
  void embedLoop();

  while (!signal?.aborted) {
    try {
      const now = Date.now();
      // Starta full refresh i BAKGRUNDEN (ej await) → hot-pollen nedan fortsätter
      // var ~10 s även medan full refresh tar minuter. fullRunning hindrar överlapp.
      if (!fullRunning && now - lastFull >= FULL_REFRESH_MS) {
        lastFull = now;
        fullRunning = true;
        void runFullRefresh(connector, flatSources)
          .catch((e) => log(`full-refresh fel: ${(e as Error).message}`))
          .finally(() => {
            fullRunning = false;
          });
      }

      const { polled, ended } = await pollHot(connector);
      // Platta källor: hett-poll (exakt slutpris där fetchItem finns) + finalisering.
      let fPolled = 0;
      let fEnded = 0;
      for (const fs of flatSources) {
        const r = await pollHotFlat(fs);
        fPolled += r.polled;
        fEnded += r.ended;
      }
      if (polled > 0 || ended > 0 || fPolled > 0 || fEnded > 0) {
        log(
          `hot-poll: bud uppdaterade ${polled + fPolled}, ` +
            `finaliserade ${ended + fEnded}`,
        );
      }
      // IndexNow: skicka ev. buffrade URL:er (nya + nyavslutade objekt från
      // hot-poll/finalisering). Fire-and-forget — kan aldrig störa loopen.
      flushIndexNow();

      // LLM-klassning av nyckelords-missar (conf='none') - en batch per intervall, i
      // BAKGRUNDEN (LLM-svar kan ta ~min; grundticken får inte blockeras). Tyst no-op
      // utan OPENROUTER_API_KEY.
      if (!llmRunning && process.env.OPENROUTER_API_KEY && now - lastLlmClassify >= AI_CLASSIFY_INTERVAL_MS) {
        lastLlmClassify = now;
        llmRunning = true;
        void llmClassifyPass()
          .then((r) => {
            if (r && (r.sent > 0 || r.learned > 0))
              log(`llm-klassning: ${r.classified}/${r.sent} via LLM, ${r.learned} ur lexikonet (${r.lexiconSize} tokens), ${r.remaining} kvar`);
          })
          .catch((e) => log(`llm-klassning fel: ${(e as Error).message}`))
          .finally(() => {
            llmRunning = false;
          });
      }

      // Bild-klassning av objekt där texten inte räckte (LLM sa "diverse"/inget svar):
      // vision-modellen tittar på annonsbilden. Färre anrop (dyrare payload).
      if (!imageClassifyRunning && process.env.OPENROUTER_API_KEY && now - lastImageClassify >= AI_IMAGE_CLASSIFY_INTERVAL_MS) {
        lastImageClassify = now;
        imageClassifyRunning = true;
        void llmClassifyImagePass()
          .then((r) => {
            if (r && r.sent > 0) log(`bild-klassning: ${r.classified}/${r.sent} via vision, ${r.remaining} diverse kvar`);
          })
          .catch((e) => log(`bild-klassning fel: ${(e as Error).message}`))
          .finally(() => {
            imageClassifyRunning = false;
          });
      }

      // Fordonsberikning: regnr (attrs.reg/titel/beskrivning) → biluppgifter.se-cache.
      // Litet svep-tak (källan throttlas ~1 anrop/s), permanent cache per regnr.
      if (!vehicleRunning && now - lastVehicleEnrich >= VEHICLE_ENRICH_INTERVAL_MS) {
        lastVehicleEnrich = now;
        vehicleRunning = true;
        void vehicleEnrichPass()
          .then((r) => {
            if (r.looked > 0) log(`fordonsdata: ${r.found}/${r.looked} regnr uppslagna (biluppgifter)`);
          })
          .catch((e) => log(`fordonsdata fel: ${(e as Error).message}`))
          .finally(() => {
            vehicleRunning = false;
          });
      }

      // Plåtläsning: fordon utan regnr i text → läs skylten ur bilden (gratis vision),
      // korsvalidera mot märket. Höjer täckningen bortom vad annonstexten avslöjar.
      if (!plateRunning && process.env.OPENROUTER_API_KEY && now - lastPlateRead >= PLATE_READ_INTERVAL_MS) {
        lastPlateRead = now;
        plateRunning = true;
        void readPlatePass()
          .then((r) => {
            if (r.read > 0) log(`plåtläsning: ${r.matched}/${r.read} skyltar validerade → fordonsdata (av ${r.scanned})`);
          })
          .catch((e) => log(`plåtläsning fel: ${(e as Error).message}`))
          .finally(() => {
            plateRunning = false;
          });
      }

      // OCR-berikning: läs text (modellkoder/skyltar) ur bilden → sökbar signal.
      // Kräver alpr-sidecaren; tyst no-op om den är nere.
      if (!ocrRunning && now - lastOcr >= OCR_ENRICH_INTERVAL_MS) {
        lastOcr = now;
        ocrRunning = true;
        void ocrEnrichPass()
          .then((r) => {
            if (r.scanned > 0) log(`ocr: ${r.withText}/${r.scanned} bilder gav text (sökbar)`);
          })
          .catch((e) => log(`ocr fel: ${(e as Error).message}`))
          .finally(() => {
            ocrRunning = false;
          });
      }

      // Bild-embedding + max-speed-flaggan körs i en EGEN loop (embedLoop ovan), frikopplad
      // från denna 10s-tick så toggeln slår igenom snabbt och sidecaren hålls mättad.

      // Geokodning: slå upp nya orter → lat/lon (Nominatim, 1 req/s) → kartan.
      if (!geocodeRunning && now - lastGeocode >= GEOCODE_INTERVAL_MS) {
        lastGeocode = now;
        geocodeRunning = true;
        void geocodePass()
          .then((r) => { if (r.scanned > 0) log(`geokod: ${r.resolved}/${r.scanned} orter`); })
          .catch((e) => log(`geokod fel: ${(e as Error).message}`))
          .finally(() => { geocodeRunning = false; });
      }

      // Konkurs-flaggning: sätt is_konkurs för nya oflaggade objekt (auktions-nivå).
      if (now - lastKonkurs >= KONKURS_INTERVAL_MS) {
        lastKonkurs = now;
        void konkursPass()
          .then((r) => { if (r.updated > 0) log(`konkurs: ${r.updated} objekt flaggade`); })
          .catch((e) => log(`konkurs fel: ${(e as Error).message}`));
      }

      // Bevakning: matcha nya objekt mot sparade sökningar + notifiera bevakade objekts
      // övergångar (slutar snart / reserv uppnådd / avslutad).
      if (!watchRunning && now - lastWatch >= WATCH_INTERVAL_MS) {
        lastWatch = now;
        watchRunning = true;
        void watchPass()
          .then((r) => {
            if (r.searchMatches + r.itemEvents > 0) log(`bevakning: ${r.searchMatches} sök-träffar, ${r.itemEvents} objekt-händelser`);
          })
          .catch((e) => log(`bevakning fel: ${(e as Error).message}`))
          .finally(() => { watchRunning = false; });
      }

      // Tradera-prisdata (ENBART sålt, ingen säljaridentitet). FÄRSKHET: sida 1 (nyast
      // först) för några rot-kategorier per cykel via roterande cursor → fångar nysålt
      // brett och kontinuerligt. Browser-tungt → i BAKGRUNDEN (ej await), guard mot överlapp.
      if (TRADERA_ENABLED && !traderaFreshRunning && now - lastTraderaFresh >= TRADERA_FRESH_MS) {
        lastTraderaFresh = now;
        traderaFreshRunning = true;
        void crawlTraderaFresh({ rootsPerCycle: TRADERA_ROOTS_PER_CYCLE, freshPages: TRADERA_FRESH_PAGES })
          .then((r) => { if (r.stored > 0) log(`tradera-fresh: ${r.stored} sålda upsertade (${r.categories} kat, ${r.fetches} hämtn.)`); })
          .catch((e) => log(`tradera-fresh fel: ${(e as Error).message}`))
          .finally(() => { traderaFreshRunning = false; });
      }

      // Tradera DJUP backfill (MAX DJUP - allt): full adaptiv crawl med PRIS-SLICING som
      // tömmer varje kategori helt (kringgår 500-taket per fråga). En enda långkörande
      // pass (dagar) via cursor - guarden hindrar överlapp, den återupptas vid omstart och
      // loopar om (deduppar + fångar nysålt) när hela trädet är avbetat. TRADERA_ENABLED=0 = av.
      if (TRADERA_ENABLED && !traderaBackfillRunning && now - lastTraderaBackfill >= TRADERA_BACKFILL_MS) {
        lastTraderaBackfill = now;
        traderaBackfillRunning = true;
        void crawlTraderaSold({ log: (m) => log(`tradera-backfill ${m}`) })
          .then((r) => { if (r.stored > 0) log(`tradera-backfill KLAR varv: ${r.stored} sålda lagrade (${r.categories} kat, ${r.fetches} hämtn.)`); })
          .catch((e) => log(`tradera-backfill fel: ${(e as Error).message}`))
          .finally(() => { traderaBackfillRunning = false; });
      }

      // Tradera-lexikon-träning: mata Traderas (titel→vår-kategori) in i learned_tokens.
      // Bunden chunk/pass, cursor-styrt (ingen dubbelräkning), växer med crawlen → klassaren
      // blir bättre på konsument/samlarvaror. Env TRADERA_ENABLED styr (samma flagga).
      if (TRADERA_ENABLED && !traderaTrainRunning && now - lastTraderaTrain >= TRADERA_TRAIN_MS) {
        lastTraderaTrain = now;
        traderaTrainRunning = true;
        void trainTraderaLexiconPass(TRADERA_TRAIN_ROWS)
          .then((r) => { if (r.learned > 0) log(`tradera-träning: ${r.learned} titlar → lexikon (${r.skipped} tvetydiga)${r.done ? " [ikapp]" : ""}`); })
          .catch((e) => log(`tradera-träning fel: ${(e as Error).message}`))
          .finally(() => { traderaTrainRunning = false; });
      }

      // TEXT-embedding (e5) på titel+beskrivning per aktivt objekt → semantisk sök.
      // Kräver alpr-sidecaren; tyst no-op om nere. Batchat (ett ONNX-anrop per svep).
      if (!embedTextRunning && now - lastEmbedText >= EMBED_TEXT_INTERVAL_MS) {
        lastEmbedText = now;
        embedTextRunning = true;
        void embedTextPass()
          .then((r) => {
            if (r.scanned > 0) log(`text-embed: ${r.embedded}/${r.scanned} objekt embeddade (semantisk sök)`);
          })
          .catch((e) => log(`text-embed fel: ${(e as Error).message}`))
          .finally(() => {
            embedTextRunning = false;
          });
      }

      // FYND-motorn: uppskattat slutvärde per aktivt objekt ur comparables → fynd-flagga.
      // Prioriterar slutar-snart. Tungt (trigram/objekt) → litet svep-tak.
      if (!estimateRunning && now - lastEstimate >= ESTIMATE_INTERVAL_MS) {
        lastEstimate = now;
        estimateRunning = true;
        void estimatePass()
          .then((r) => {
            if (r.scanned > 0) log(`fynd-est: ${r.estimated}/${r.scanned} objekt fick uppskattat värde`);
          })
          .catch((e) => log(`fynd-est fel: ${(e as Error).message}`))
          .finally(() => {
            estimateRunning = false;
          });
      }

      // Backfill-trickle av Tovek-arkivet (separat flöde, inte varje grundtick).
      if (BACKFILL_ENABLED && now - lastBackfill >= BACKFILL_INTERVAL_MS) {
        lastBackfill = now;
        const r = await backfillEndedBatch(connector, BACKFILL_PARTS_PER_CYCLE);
        if (r.processedParts > 0) {
          log(
            `backfill: +${r.processedParts} parts (${r.items} objekt), ` +
              `${r.offset}${r.total != null ? "/" + r.total : ""}` +
              `${r.doneAll ? " — KLART" : ""}`,
          );
        }
      }

      backoff = 1000;
      await sleep(BASE_TICK_MS);
    } catch (e) {
      log(`schemaläggare-fel: ${(e as Error).message}; backoff ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 5 * 60_000);
    }
  }
  log("Schemaläggare stoppad.");
}
