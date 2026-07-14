/**
 * Bulk-berikning av BESKRIVNINGAR för hus vars objektsidor inte hunnit betas av via
 * den gradvisa svep-berikningen: Pantbanken (Objektinformation-tabellen), Bukowskis
 * (lot-description-diven) och Bidflow-husen (LotsApi/lotInfo: beskrivning + skick).
 * Aktiva objekt utan beskrivning. Bot-skyddade Bidflow-tenants (Effecta, Haraldssons)
 * batchas via browserApi (EN navigation → många in-page-fetchar); övriga via ren HTTP.
 * Avbrytbart/återupptagbart (skriver bara rader där description IS NULL).
 *
 * Kör: npx tsx scripts/enrich-descriptions.ts     Logg: data/enrich-descriptions.log
 */

// Minimal .env-laddare (samma som cli.ts - scriptet körs direkt via tsx).
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]!] == null) process.env[m[1]!] = m[2]!;
  }
} catch {
  /* ingen .env - ok */
}

import { pool } from "../src/db/pool.ts";
import { browserApi, closeBrowser } from "../src/browser/cloak.ts";
import { PantbankenClient } from "../src/connectors/pantbanken/client.ts";
import { BukowskisClient } from "../src/connectors/bukowskis/client.ts";
import { BidflowClient, parseLotInfo } from "../src/connectors/bidflow/client.ts";
import { BIDFLOW_HOUSES } from "../src/connectors/bidflow/houses.ts";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface Row {
  external_id: string;
  source_url: string;
}

/** Aktiva objekt utan beskrivning för ett hus. */
async function pending(house: string): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `SELECT external_id, source_url FROM items
      WHERE house=$1 AND status='active' AND description IS NULL
      ORDER BY ends_at NULLS LAST`,
    [house],
  );
  return rows;
}

/** Skriv beskrivning - bara om raden fortfarande saknar en (återupptagbart). */
async function save(house: string, externalId: string, desc: string | null): Promise<boolean> {
  if (!desc) return false;
  const res = await pool.query(
    `UPDATE items SET description=$3 WHERE house=$1 AND external_id=$2 AND description IS NULL`,
    [house, externalId, desc],
  );
  return (res.rowCount ?? 0) > 0;
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i] as T, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

/** Generisk plain-HTTP-berikning med samtidighet + löpande progress. */
async function enrichPlain(
  house: string,
  concurrency: number,
  fetchDesc: (row: Row) => Promise<string | null>,
): Promise<void> {
  const rows = await pending(house);
  log(`${house}: ${rows.length} objekt utan beskrivning`);
  let done = 0;
  let got = 0;
  await mapWithConcurrency(rows, concurrency, async (row) => {
    const desc = await fetchDesc(row).catch(() => null);
    if (await save(house, row.external_id, desc)) got++;
    if (++done % 200 === 0) log(`${house}: ${done}/${rows.length} (${got} med text)`);
  });
  log(`${house}: KLAR - ${got}/${rows.length} fick beskrivning`);
}

/** Bidflow via browserApi: batcha många lotInfo-anrop per navigation (bot-skyddade tenants). */
async function enrichBidflowBrowser(house: string, baseUrl: string): Promise<void> {
  const rows = await pending(house);
  log(`${house}: ${rows.length} objekt utan beskrivning (browser-batchad lotInfo)`);
  const headers = {
    "Content-Type": "application/json; charset=UTF-8",
    Accept: "application/json",
    "x-remoting-proxy": "true",
  };
  let got = 0;
  const CHUNK = 150; // per navigation - in-page-fetchar är billiga (~100-300 ms styck)
  for (let off = 0; off < rows.length; off += CHUNK) {
    const chunk = rows.slice(off, off + CHUNK);
    const requests = chunk.map((row) => {
      const [aucId, lotId] = row.external_id.split("-");
      return {
        path: "/api/LotsApi/lotInfo",
        method: "POST",
        headers,
        body: JSON.stringify([[{ AuctionId: aucId, LotId: lotId }, null]]),
      };
    });
    const texts = await browserApi(baseUrl, requests, { sessionPath: "/", concurrency: 4 });
    for (let i = 0; i < chunk.length; i++) {
      const txt = texts[i];
      if (txt == null) continue;
      let desc: string | null = null;
      try {
        desc = parseLotInfo(txt);
      } catch {
        /* trasigt svar - hoppa */
      }
      if (await save(house, chunk[i]!.external_id, desc)) got++;
    }
    log(`${house}: ${Math.min(off + CHUNK, rows.length)}/${rows.length} (${got} med text)`);
  }
  log(`${house}: KLAR - ${got}/${rows.length} fick beskrivning`);
}

async function main(): Promise<void> {
  const only = process.argv[2]; // valfritt: kör bara ett hus

  const jobs: { house: string; run: () => Promise<void> }[] = [];

  const pant = new PantbankenClient();
  jobs.push({
    house: "pantbanken",
    run: () => enrichPlain("pantbanken", 6, (row) => pant.fetchDetail(row.external_id)),
  });

  const buko = new BukowskisClient();
  jobs.push({
    house: "bukowskis",
    run: () => enrichPlain("bukowskis", 4, (row) => buko.fetchDetail(row.source_url)),
  });

  for (const h of BIDFLOW_HOUSES) {
    if (h.useBrowser) {
      jobs.push({ house: h.house, run: () => enrichBidflowBrowser(h.house, h.baseUrl) });
    } else {
      const client = new BidflowClient(h.baseUrl, false);
      jobs.push({
        house: h.house,
        run: () =>
          enrichPlain(h.house, 4, (row) => {
            const [aucId, lotId] = row.external_id.split("-");
            return client.fetchLotInfo(aucId ?? "", lotId ?? "");
          }),
      });
    }
  }

  for (const job of jobs) {
    if (only && job.house !== only) continue;
    try {
      await job.run();
    } catch (e) {
      log(`${job.house}: FEL - ${e instanceof Error ? e.message : e}`);
    }
  }

  await closeBrowser().catch(() => {});
  await pool.end();
  log("Allt klart.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
