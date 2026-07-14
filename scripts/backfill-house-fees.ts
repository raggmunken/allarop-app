/**
 * Engångs-backfill av avgiftsdata för redan-berikade objekt (som annars hoppas över av
 * loadEnriched-skippen):
 *   - Budi: objektsidans data-budi-servicefee-* → raw.item.feeParams
 *   - Vaxxa: objektsidans is_taxable → raw.item.isTaxable
 *   - GAK-plattformen (gak/auktionskammaren): detaljsidans priceInfo-attribut → raw.detail.fee
 * Skriver BARA raw-seeds; totalpriser räknas av schemaläggarens nästa svep via den
 * vanliga upsert-vägen (connectorerna läser seedsen vid uppstart via rawFieldSeed).
 *
 * Körning: npx tsx scripts/backfill-house-fees.ts [budi|vaxxa|gak]
 */

import { BudiClient } from "../src/connectors/budi/client.ts";
import { VaxxaClient } from "../src/connectors/vaxxa/client.ts";
import { GakClient } from "../src/connectors/gak/client.ts";
import { GAK_HOUSES } from "../src/connectors/gak/houses.ts";
import { pool } from "../src/db/pool.ts";

const CONCURRENCY = 3;

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

async function backfillBudi(): Promise<void> {
  const { rows } = await pool.query<{ external_id: string; source_url: string }>(
    `SELECT external_id, source_url FROM items
     WHERE house='budi' AND status='active' AND source_url IS NOT NULL
       AND raw->'item'->'feeParams' IS NULL`,
  );
  console.log(`Budi: ${rows.length} objekt saknar avgiftsparametrar`);
  const client = new BudiClient();
  let ok = 0, miss = 0;
  await mapWithConcurrency(rows, CONCURRENCY, async (r, i) => {
    const d = await client.fetchDetail(r.source_url);
    if (d.feeParams) {
      await pool.query(
        `UPDATE items SET raw = jsonb_set(raw, '{item,feeParams}', $1::jsonb)
         WHERE house='budi' AND external_id=$2`,
        [JSON.stringify(d.feeParams), r.external_id],
      );
      ok++;
    } else miss++;
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${rows.length} (ok ${ok}, miss ${miss})`);
  });
  console.log(`Budi klart: ${ok} seedade, ${miss} utan parametrar`);
}

async function backfillVaxxa(): Promise<void> {
  const { rows } = await pool.query<{ external_id: string }>(
    `SELECT external_id FROM items
     WHERE house='vaxxa' AND status='active'
       AND raw->'item'->'isTaxable' IS NULL`,
  );
  console.log(`Vaxxa: ${rows.length} objekt saknar momsstatus`);
  const client = new VaxxaClient();
  let ok = 0, miss = 0;
  await mapWithConcurrency(rows, CONCURRENCY, async (r, i) => {
    const d = await client.fetchDetail(r.external_id);
    if (d.taxable != null) {
      await pool.query(
        `UPDATE items SET raw = jsonb_set(raw, '{item,isTaxable}', $1::jsonb)
         WHERE house='vaxxa' AND external_id=$2`,
        [JSON.stringify(d.taxable), r.external_id],
      );
      ok++;
    } else miss++;
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${rows.length} (ok ${ok}, miss ${miss})`);
  });
  console.log(`Vaxxa klart: ${ok} seedade, ${miss} utan momsstatus`);
}

async function backfillGak(): Promise<void> {
  for (const cfg of GAK_HOUSES) {
    const { rows } = await pool.query<{ external_id: string; raw: { item?: { slug?: string } } }>(
      `SELECT external_id, raw FROM items
       WHERE house=$1 AND status='active'
         AND raw->'detail'->'fee' IS NULL`,
      [cfg.house],
    );
    console.log(`${cfg.house}: ${rows.length} objekt saknar avgiftsattribut`);
    const client = new GakClient(cfg.baseUrl);
    let ok = 0, miss = 0;
    // Låg samtidighet - GAK-plattformen throttlar snabba upprepade anrop.
    await mapWithConcurrency(rows, 2, async (r, i) => {
      const slug = r.raw?.item?.slug ?? "";
      const d = slug ? await client.fetchDetail(slug, r.external_id) : null;
      if (d?.fee) {
        // OBS: raw->'detail' kan vara JSON-null (inte SQL-NULL) → COALESCE hjälper inte
        // och `null || objekt` blir en ARRAY. Säkerställ objekt-typ explicit.
        await pool.query(
          `UPDATE items SET raw = jsonb_set(
             CASE WHEN jsonb_typeof(raw->'detail') = 'object' THEN raw
                  ELSE jsonb_set(raw, '{detail}', '{}'::jsonb) END,
             '{detail,fee}', $1::jsonb, true)
           WHERE house=$2 AND external_id=$3`,
          [JSON.stringify(d.fee), cfg.house, r.external_id],
        );
        ok++;
      } else miss++;
      if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${rows.length} (ok ${ok}, miss ${miss})`);
    });
    console.log(`${cfg.house} klart: ${ok} seedade, ${miss} utan attribut`);
  }
}

const target = process.argv[2];
if (target === "budi" || target == null) await backfillBudi();
if (target === "vaxxa" || target == null) await backfillVaxxa();
if (target === "gak" || target == null) await backfillGak();
await pool.end();
