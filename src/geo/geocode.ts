/**
 * Geokodning: ortnamn → lat/lon via Nominatim (OpenStreetMap, gratis). Permanent cache i
 * geocode-tabellen - ETT uppslag per unik ort någonsin (~600 orter). Nominatim-policy: max
 * 1 req/s + egen User-Agent → vi spacar 1,1s och kör små svep. lat/lon NULL = ej hittad
 * (sentinel, retryas ej). Driver kartan + områdesfiltret.
 */

import { pool } from "../db/pool.ts";

const UA = "Allarop/1.0 (svensk auktionsaggregator; kontakt via appen)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Samma normalisering som SQL: strippa ledande postnr, ta del före komma, gemener. */
export function normalizeLocation(loc: string): string {
  return loc.replace(/^[0-9\s]+/, "").split(",")[0]!.trim().toLowerCase();
}

/** Ett Nominatim-uppslag. { lat, lon } eller null (ej hittad/fel). */
async function nominatim(place: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=jsonv2&limit=1&accept-language=sv`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const arr = (await res.json()) as { lat?: string; lon?: string }[];
    const hit = arr[0];
    if (!hit?.lat || !hit?.lon) return null;
    const lat = Number(hit.lat), lon = Number(hit.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  } catch {
    return null;
  }
}

/**
 * Geokoda en fri adress/plats (för ruttplaneraren). Cachar på hela strängen i geocode-
 * tabellen (permanent). Returnerar { lat, lon } eller null. Respekterar Nominatims 1 req/s
 * bara vid cache-miss. OBS: nyckeln är hela adressen (ej stad-normaliserad som svepen).
 */
export async function geocodeAddress(q: string): Promise<{ lat: number; lon: number } | null> {
  const key = q.trim().toLowerCase();
  if (!key) return null;
  const cached = await pool.query<{ lat: number | null; lon: number | null }>(
    `SELECT lat, lon FROM geocode WHERE query=$1`,
    [key],
  );
  if (cached.rowCount) {
    const r = cached.rows[0]!;
    return r.lat != null && r.lon != null ? { lat: r.lat, lon: r.lon } : null;
  }
  const hit = await nominatim(q.trim());
  await pool.query(
    `INSERT INTO geocode (query, lat, lon) VALUES ($1,$2,$3) ON CONFLICT (query) DO NOTHING`,
    [key, hit?.lat ?? null, hit?.lon ?? null],
  );
  return hit;
}

export interface AddressSuggestion {
  label: string;
  lat: number;
  lon: number;
}

/**
 * Adressförslag medan användaren skriver (ruttplaneraren). ORS geocoding-autocomplete
 * (Pelias) om ORS_API_KEY finns - byggd för detta, ger förslag + exakta koordinater. Faller
 * tillbaka till Nominatim-sök. Fokus-bias mot Sverige men ej hårt landslås (utländska
 * upphämtningar kan förekomma). Tom lista vid fel/kort fråga.
 */
export async function geocodeSuggest(q: string): Promise<AddressSuggestion[]> {
  const query = q.trim();
  if (query.length < 3) return [];
  const key = process.env.ORS_API_KEY || "";
  try {
    if (key) {
      const url = `https://api.openrouteservice.org/geocode/autocomplete?api_key=${encodeURIComponent(key)}` +
        `&text=${encodeURIComponent(query)}&focus.point.lon=15&focus.point.lat=62&size=6&lang=sv`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const j = (await res.json()) as { features?: { properties?: { label?: string }; geometry?: { coordinates?: [number, number] } }[] };
        const out = (j.features ?? [])
          .map((f) => ({ label: f.properties?.label ?? "", lat: f.geometry?.coordinates?.[1] ?? NaN, lon: f.geometry?.coordinates?.[0] ?? NaN }))
          .filter((s) => s.label && Number.isFinite(s.lat) && Number.isFinite(s.lon));
        if (out.length) return out.slice(0, 6);
      }
    }
    // Fallback: Nominatim-sök (server-side, egen User-Agent).
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=6&accept-language=sv`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const arr = (await res.json()) as { display_name?: string; lat?: string; lon?: string }[];
    return arr
      .map((x) => ({ label: x.display_name ?? "", lat: Number(x.lat), lon: Number(x.lon) }))
      .filter((s) => s.label && Number.isFinite(s.lat) && Number.isFinite(s.lon))
      .slice(0, 6);
  } catch {
    return [];
  }
}

export interface GeocodePassResult {
  scanned: number;
  resolved: number;
}

/**
 * Ett svep: hämta distinkta aktiva orter som ännu inte är geokodade, slå upp (1,1s mellan),
 * cacha (lat/lon eller NULL-sentinel). limit = antal orter per svep (håll litet - 1 req/s).
 */
export async function geocodePass(limit = Number(process.env.GEOCODE_BATCH ?? 8)): Promise<GeocodePassResult> {
  const { rows } = await pool.query<{ ort: string }>(
    `SELECT DISTINCT trim(split_part(regexp_replace(location,'^[0-9 ]+',''),',',1)) AS ort
     FROM items i
     WHERE i.status='active' AND location IS NOT NULL AND length(trim(location)) > 1
       AND NOT EXISTS (SELECT 1 FROM geocode g WHERE g.query = lower(trim(split_part(regexp_replace(i.location,'^[0-9 ]+',''),',',1))))
     LIMIT $1`,
    [limit],
  );
  let resolved = 0;
  for (const r of rows) {
    const place = r.ort.trim();
    if (!place) continue;
    const key = place.toLowerCase();
    const hit = await nominatim(place);
    await pool.query(
      `INSERT INTO geocode (query, lat, lon) VALUES ($1,$2,$3)
       ON CONFLICT (query) DO NOTHING`,
      [key, hit?.lat ?? null, hit?.lon ?? null],
    );
    if (hit) resolved++;
    await sleep(1100); // Nominatim: max 1 req/s
  }
  return { scanned: rows.length, resolved };
}
