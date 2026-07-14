/**
 * Körtidsinställningar (key/value i settings-tabellen). Läses av schemaläggaren varje svep,
 * sätts via /status. Just nu: max_speed (maxa embedding-takten med datorns fulla kraft).
 */

import { pool } from "./pool.ts";

export async function getSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query<{ value: string }>(`SELECT value FROM settings WHERE key=$1`, [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [key, value],
  );
}

export async function getMaxSpeed(): Promise<boolean> {
  return (await getSetting("max_speed")) === "1";
}
