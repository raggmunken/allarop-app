/**
 * Ingest-pipeline: hämtar parts → items → bud från en connector och speglar
 * allt till Postgres. Sajt-agnostisk: tar emot vilken Connector som helst.
 */

import {
  Connector,
  FlatSource,
  NormalizedAuction,
  NormalizedBid,
  NormalizedPart,
} from "../connectors/types.ts";
import { FeeModel } from "../fees/engine.ts";
import { feeModelFor } from "../fees/rules.ts";
import {
  finalizeEndedItem,
  getJobState,
  setJobState,
  upsertAuction,
  upsertBids,
  upsertItem,
  upsertPart,
} from "../db/repo.ts";

export interface IngestStats {
  parts: number;
  items: number;
  bidsFetchedFor: number;
}

/** Härled auktionen (grupperingen) ur en parts medföljande auktionsfält. */
export function auctionFromPart(part: NormalizedPart): NormalizedAuction {
  return {
    house: part.house,
    externalId: part.auctionExternalId,
    title: part.auctionTitle ?? part.title,
    description: part.auctionDescription ?? null,
    lastPayDate: part.auctionLastPayDate ?? null,
    contact: part.auctionContact ?? null,
    sourceUrl: part.sourceUrl,
  };
}

export interface IngestOptions {
  /** Hämta budhistorik per item (extra anrop, men ger korrekt aktuellt bud). */
  fetchBids?: boolean;
  /** Begränsa antal items per part vi hämtar bud för (kostnadskontroll). */
  maxBidFetch?: number;
}

/** Full ingest av alla pågående parts från en connector. */
export async function ingestAll(
  connector: Connector,
  opts: IngestOptions = {},
): Promise<IngestStats> {
  const feeModel: FeeModel = feeModelFor(connector.house);
  const stats: IngestStats = { parts: 0, items: 0, bidsFetchedFor: 0 };

  const parts = await connector.listParts({ status: "running" });
  stats.parts = parts.length;

  for (const part of parts) {
    await upsertAuction(auctionFromPart(part));
    await upsertPart(part);

    const items = await connector.listItems(part.externalId);
    stats.items += items.length;
    for (const item of items) await upsertItem(item, feeModel);

    if (opts.fetchBids) {
      let ids = items.map((i) => i.externalId);
      if (opts.maxBidFetch != null) ids = ids.slice(0, opts.maxBidFetch);
      const bidsMap = await fetchBids(connector, ids);
      for (const [itemId, bids] of bidsMap) {
        if (bids.length > 0) {
          await upsertBids(itemId, connector.house, bids);
          stats.bidsFetchedFor++;
        }
      }
    }
  }

  return stats;
}

/**
 * Platt ingest för objekt-centrerade källor (Auctionet m.fl.). Paginerar objekt
 * direkt, upsertar auktion + objekt + inbäddade bud, och skriver prishistorik
 * för avslutade. Returnerar statistik.
 */
export async function ingestFlat(
  source: FlatSource,
  opts: { ended?: boolean; maxPages?: number; perPage?: number; companyId?: number } = {},
): Promise<{ items: number; bids: number; pages: number; total: number }> {
  const feeModel = feeModelFor(source.house);
  const ended = opts.ended ?? false;
  let page = 1;
  let items = 0;
  let bids = 0;
  let total = 0;

  for (;;) {
    const res = await source.fetchPage({
      ended,
      page,
      perPage: opts.perPage ?? 100,
      companyId: opts.companyId,
    });
    total = res.totalEntries;
    for (const row of res.items) {
      await upsertAuction(row.auction);
      await upsertItem(row.item, feeModel);
      if (row.bids.length > 0) {
        await upsertBids(row.item.externalId, source.house, row.bids);
        bids += row.bids.length;
      }
      if (ended) await finalizeEndedItem(source.house, row.item.externalId);
      items++;
    }
    const reachedEnd = res.currentPage >= res.totalPages || res.items.length === 0;
    const reachedMax = opts.maxPages != null && page >= opts.maxPages;
    if (reachedEnd || reachedMax) break;
    page++;
  }

  return { items, bids, pages: page, total };
}

/**
 * Rullande svep av en platt källas AKTIVA katalog. Auctionet har ~36 000 aktiva
 * objekt och stödjer inte sortering på "senaste", så vi sveper hela katalogen
 * `pagesPerCycle` sidor i taget (cursor i job_state, wrappar runt). Upptäcker
 * nya auktioner och växer täckningen till hela katalogen över flera cykler.
 * Den "slutar snart"-sorterade fronten hålls ändå färsk av hot-pollen.
 */
const SHARD_MUL = 10000; // cursor = shardIndex * SHARD_MUL + page

export async function sweepFlatActive(
  source: FlatSource,
  pagesPerCycle: number,
  perPage = 200, // Auctionet maxar per_page=200
): Promise<{ items: number; shard: string | undefined }> {
  const job = `${source.house}:active-sweep`;
  const st = await getJobState(job);
  const feeModel = feeModelFor(source.house);
  // Shards = toppkategorier (Auctionet) eller [ingen] (källor utan tak, t.ex. Riks).
  const shards = source.listShards
    ? await source.listShards()
    : [{ key: undefined as string | undefined, label: undefined }];

  let cur = st.cursor_offset || 1; // default: shard 0 (0*MUL), sida 1
  if (Math.floor(cur / SHARD_MUL) >= shards.length) cur = 1; // shard borta → reset
  const startKey = cur;
  let items = 0;
  let fetched = 0;
  let lastLabel: string | undefined;

  do {
    const shardIdx = Math.min(Math.floor(cur / SHARD_MUL), shards.length - 1);
    const page = cur % SHARD_MUL || 1;
    const shard: { key: string | undefined; label?: string } =
      shards[shardIdx] ?? { key: undefined };
    lastLabel = shard.label;
    const res = await source.fetchPage({ ended: false, page, perPage, shard: shard.key });
    for (const row of res.items) {
      await upsertAuction(row.auction);
      await upsertItem(row.item, feeModel);
      if (row.bids.length > 0) await upsertBids(row.item.externalId, source.house, row.bids);
      items++;
    }
    fetched++;
    // Nästa position: nästa sida, eller nästa shard när kategorin är slut.
    const endOfShard = page >= (res.totalPages || 1) || res.items.length === 0;
    cur = endOfShard
      ? ((shardIdx + 1) % shards.length) * SHARD_MUL + 1
      : shardIdx * SHARD_MUL + page + 1;
  } while (fetched < pagesPerCycle && cur !== startKey); // stanna efter ett helt varv

  await setJobState(job, cur, st.total, false);
  return { items, shard: lastLabel };
}

/**
 * Återupptagbar backfill av en platt källas AVSLUTADE arkiv (Auctionet m.fl.) →
 * prishistorik. Betar av `pagesPerCycle` sidor per anrop, cursor i job_state, så
 * det trickar i bakgrunden tills arkivet är slut. Idempotent (upsert + finalize).
 */
export async function backfillFlatEnded(
  source: FlatSource,
  pagesPerCycle = 2,
  perPage = 100,
): Promise<{ items: number; offset: number; total: number | null; doneAll: boolean }> {
  const job = `${source.house}:ended-backfill`;
  const st = await getJobState(job);
  if (st.done) return { items: 0, offset: st.cursor_offset, total: st.total, doneAll: true };

  const feeModel = feeModelFor(source.house);
  let page = Math.max(1, st.cursor_offset || 1);
  let items = 0;
  let total = st.total;

  for (let i = 0; i < pagesPerCycle; i++) {
    const res = await source.fetchPage({ ended: true, page, perPage });
    total = res.totalEntries;
    for (const row of res.items) {
      await upsertAuction(row.auction);
      await upsertItem(row.item, feeModel);
      if (row.bids.length > 0) await upsertBids(row.item.externalId, source.house, row.bids);
      await finalizeEndedItem(source.house, row.item.externalId);
      items++;
    }
    const reachedEnd = res.currentPage >= res.totalPages || res.items.length === 0;
    page++;
    if (reachedEnd) {
      await setJobState(job, page, total, true);
      return { items, offset: page, total, doneAll: true };
    }
  }
  await setJobState(job, page, total, false);
  return { items, offset: page, total, doneAll: false };
}

/** Dela upp i hanterbara satser och utnyttja batch om connectorn stödjer det. */
export async function fetchBids(
  connector: Connector,
  itemExternalIds: string[],
  batchSize = 50,
): Promise<Map<string, NormalizedBid[]>> {
  const out = new Map<string, NormalizedBid[]>();
  if (connector.listBidsForItems) {
    for (let i = 0; i < itemExternalIds.length; i += batchSize) {
      const chunk = itemExternalIds.slice(i, i + batchSize);
      const map = await connector.listBidsForItems(chunk);
      for (const [k, v] of map) out.set(k, v);
    }
  } else {
    for (const id of itemExternalIds) {
      out.set(id, await connector.listBids(id));
    }
  }
  return out;
}
