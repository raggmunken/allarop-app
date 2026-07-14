/** Postgres-pool och schema-init. */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://allarop:allarop@localhost:5432/allarop";

// max: pool-storlek. Höjs i schemaläggaren (PG_POOL_MAX) så många parallella embed-workers
// inte köar på DB-connections vid max-speed. Postgres default max_connections=100.
export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
});

export async function initSchema(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
