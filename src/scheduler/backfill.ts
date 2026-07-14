/**
 * Backfill av AVSLUTADE auktioner → prishistorik. Helt separat flöde från det
 * aktiva (pågående) flödet.
 *
 * Strategi: nyast först (sort desc), paginerat (offset/limit), återupptagbart
 * via en cursor i job_state. Varje batch betar av några parts; kör tills hela
 * arkivet är inläst (eller stoppa när du vill — cursorn ligger kvar).
 *
 * Vi hämtar INTE budhistorik per objekt här (för dyrt över hela arkivet) — det
 * avslutade objektets slutpris finns redan i itemWinningBidValue. Bilder
 * speglas inte heller för historiska objekt (URL:erna sparas, men nedladdning
 * sker bara för aktiva objekt — se storage/images.ts).
 */

import { Connector } from "../connectors/types.ts";
import { feeModelFor } from "../fees/rules.ts";
import {
  getJobState,
  setJobState,
  upsertAuction,
  upsertItem,
  upsertPart,
  upsertPriceHistory,
} from "../db/repo.ts";
import { auctionFromPart } from "./pipeline.ts";

export interface BackfillResult {
  processedParts: number;
  items: number;
  offset: number;
  total: number | null;
  doneAll: boolean;
}

/** Kör EN backfill-batch (några parts). Avancerar och sparar cursorn. */
export async function backfillEndedBatch(
  connector: Connector,
  batchParts = 3,
): Promise<BackfillResult> {
  const job = `${connector.house}:ended-backfill`;
  const state = await getJobState(job);

  if (state.done) {
    return { processedParts: 0, items: 0, offset: state.cursor_offset, total: state.total, doneAll: true };
  }

  // Bestäm totalen en gång (för progress).
  let total = state.total;
  if (total == null && connector.countParts) {
    total = await connector.countParts("ended");
  }

  const feeModel = feeModelFor(connector.house);
  const parts = await connector.listParts({
    status: "ended",
    sort: "desc",
    offset: state.cursor_offset,
    limit: batchParts,
  });

  let itemCount = 0;
  for (const part of parts) {
    await upsertAuction(auctionFromPart(part));
    await upsertPart(part);
    const items = await connector.listItems(part.externalId);
    itemCount += items.length;
    for (const item of items) {
      await upsertItem(item, feeModel); // status "ended" följer med från källan
      await upsertPriceHistory(item, feeModel, null, part.category ?? null);
    }
  }

  // Klart när en batch returnerar färre parts än begärt (slut på arkivet).
  const newOffset = state.cursor_offset + parts.length;
  const doneAll = parts.length < batchParts;
  await setJobState(job, newOffset, total, doneAll);

  return { processedParts: parts.length, items: itemCount, offset: newOffset, total, doneAll };
}
