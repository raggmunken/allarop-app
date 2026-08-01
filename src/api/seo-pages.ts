/**
 * SSR SEO-sidor för allarop.se — server-renderade landnings- och objektsidor som ger
 * Google/AI riktiga, indexerbara sidor utöver SPA:n (som annars är EN sida).
 *
 *   /kategori/<huvud>[/<under>]   → alla objekt i en kategori (t.ex. /kategori/fordon)
 *   /auktioner/<hus>              → alla objekt från ett auktionshus (t.ex. /auktioner/klaravik)
 *   /plats/<stad>                 → alla objekt på en ort (t.ex. /plats/stockholm)
 *   /guide/vad-ar-natauktioner    → informationssida (bygger topical authority)
 *   /objekt/<hus>/<id>            → ett auktionsobjekt med Product/Offer-schema
 *
 * Sidorna är lätta (ingen SPA-JS), har unik title/meta/canonical/H1 + BreadcrumbList och
 * CollectionPage/ItemList-schema, och korslänkar varandra → interna länkvägar + auktoritet
 * mot "nätauktioner"-klustret. Objektsidor är `noindex` när auktionen avslutats (undvik
 * inaktuella soft-404:or i indexet).
 *
 * Återanvänder den testade frågelagren (listActive) — ingen ny SQL-logik för listning.
 */
import type { ServerResponse } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { pool } from "../db/pool.ts";
import { getHiddenHouses, listActive, type ListOpts, type SearchRow } from "../db/repo.ts";
import { TAXONOMY } from "../categories/taxonomy.ts";
import { renderChartsInHtml } from "../lib/charts.ts";

const SITE = "https://allarop.se";

/** Hus-nyckel → visningsnamn (spegel av frontendens HOUSE_LABELS). */
const HOUSE_LABELS: Record<string, string> = {
  tovek: "Tovek", auctionet: "Auctionet", riksauktioner: "Riksauktioner", fabeo: "Fabeo",
  bukowskis: "Bukowskis", bna: "BNA", kvd: "KVD", klaravik: "Klaravik", blinto: "Blinto",
  psauction: "PS Auction", retrade: "Retrade", netauktion: "Netauktion",
  kronofogden: "Kronofogden", junora: "Junora", sajab: "Sajab", effecta: "Auktionsbyrån Effecta",
  effectamaskin: "Effecta Maskin", haraldssons: "Haraldssons Auktioner", frivio: "Frivio",
  siko: "Sikö Auktioner", upplands: "Upplands Auktionsverk", gak: "Göteborgs Auktionskammare",
  auktionskammaren: "Auktionskammaren", metropol: "Metropol Auktioner", pantbanken: "Pantbanken Sverige",
  budi: "Budi Auktioner", vaxxa: "Vaxxa", auktiona: "Auktiona", tradera: "Tradera",
};
const HOUSE_KEYS = Object.keys(HOUSE_LABELS);
const houseName = (h: string): string =>
  HOUSE_LABELS[h] ?? (h ? h.charAt(0).toUpperCase() + h.slice(1) : h);

/** Topp-orter för /plats-sidor (statisk vitlista → stabila URL:er, undviker tunna sidor). */
const CITIES = [
  "Stockholm", "Göteborg", "Malmö", "Uppsala", "Västerås", "Örebro", "Linköping",
  "Helsingborg", "Jönköping", "Norrköping", "Lund", "Umeå", "Gävle", "Borås",
  "Eskilstuna", "Halmstad", "Växjö", "Karlstad", "Sundsvall", "Östersund",
];

/** URL-slug: gemener, å/ä/ö → a/a/o, mellanslag → bindestreck. Stabil och läsbar. */
function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/å/g, "a").replace(/ä/g, "a").replace(/ö/g, "o")
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
const CITY_BY_SLUG = new Map(CITIES.map((c) => [slugify(c), c]));

/** Kategori-uppslag: slug/nyckel → {main, sub?}. */
type CatHit = { key: string; label: string; main: string; mainLabel: string; icon: string };
const CAT_BY_KEY = new Map<string, CatHit>();
for (const m of TAXONOMY) {
  CAT_BY_KEY.set(m.key, { key: m.key, label: m.label, main: m.key, mainLabel: m.label, icon: m.icon });
  for (const s of m.subs) {
    CAT_BY_KEY.set(`${m.key}/${s.key}`, {
      key: `${m.key}/${s.key}`, label: s.label, main: m.key, mainLabel: m.label, icon: m.icon,
    });
  }
}

// ── HTML-hjälpare ────────────────────────────────────────────────────────────
function esc(s: unknown): string {
  return (s == null ? "" : String(s)).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
/** Tar bort HTML-taggar och avkodar entiteter ur källornas objektbeskrivningar (flera
 * auktionshus skickar formaterad HTML, t.ex. "<p>...</p>"). Utan detta visade meta
 * description, Product-schemats description OCH sidans brödtext bokstavligt "&lt;p&gt;..."
 * som synlig text (bekräftat av SEO-audit 2026-07-29). */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
const CURSYM: Record<string, string> = { EUR: "€", GBP: "£", USD: "$" };
function money(n: number | null, c: string | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "";
  const v = new Intl.NumberFormat("sv-SE").format(Math.round(n));
  if (!c || c === "SEK") return `${v} kr`;
  if (CURSYM[c]) return `${CURSYM[c]}${v}`;
  return `${v} ${c}`;
}
const num = (s: string | null): number | null => {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
/** Bästa synliga pris för ett objekt (totalpris → bud → utrop). */
function priceText(r: SearchRow): string {
  const total = num(r.total_price);
  if (total && total > 0) return money(total, r.currency);
  const bid = num(r.current_bid) ?? num(r.min_bid);
  if (bid && bid > 0) return money(bid, r.currency);
  return r.status === "ended" ? "Avslutad" : "Öppen för bud";
}
function endsText(d: Date | null): string {
  if (!d) return "";
  try {
    return new Date(d).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}
const itemUrl = (r: { house: string; external_id: string }): string =>
  `${SITE}/objekt/${encodeURIComponent(r.house)}/${encodeURIComponent(r.external_id)}`;

/** Objektkort (server-renderat, klickbart, med bild-dimensioner mot CLS). De tre första
 * korten i varje grid (index 0-2) laddas eager med fetchpriority="high" - de hamnar ofta
 * above the fold och blir LCP-bilden (audit 2026-07-29). Resten lazy som tidigare. */
function card(r: SearchRow, index = -1): string {
  const href = `/objekt/${encodeURIComponent(r.house)}/${encodeURIComponent(r.external_id)}`;
  const eager = index >= 0 && index <= 2;
  const img = r.image
    ? `<img src="${esc(r.image)}" alt="${esc(r.title)}" loading="${eager ? "eager" : "lazy"}"${eager ? ` fetchpriority="high"` : ""} decoding="async" width="300" height="220" />`
    : `<div class="noimg" aria-hidden="true">Ingen bild</div>`;
  const price = priceText(r);
  const ends = endsText(r.ends_at);
  return (
    `<a class="c" href="${href}">` +
    `<div class="cimg">${img}</div>` +
    `<div class="cbody">` +
    `<div class="ctitle">${esc(r.title)}</div>` +
    `<div class="cmeta"><span class="cprice">${esc(price)}</span>` +
    `<span class="chouse">${esc(houseName(r.house))}</span></div>` +
    (ends ? `<div class="cends">Slutar ${esc(ends)}</div>` : "") +
    `</div></a>`
  );
}

// ── Sid-layout ───────────────────────────────────────────────────────────────
const FONT = "https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:ital,wght@0,400..800;1,400..600&display=swap";
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" fill="#283232" aria-labelledby="t d" role="img" viewBox="0 0 271 254"><title id="t">Allarop – till startsidan</title><desc id="d">Allarops logotyp, länk till startsidan.</desc><g id="icon"><path d="M267.02.28c-.55.33-3.15 1.29-4.89 1.83-1.8.56-3.56 1.14-4.5 1.5-.94.35-2.66.92-4.5 1.5a33 33 0 0 0-4.1 1.41c-.25.14-.99.4-1.63.59-.62.17-1.53.46-2.02.62l-2.19.78c-1.34.46-2.45.86-5.81 2.09-1.03.38-2.15.83-2.5 1.01-.34.17-1.01.4-1.5.5-.48.1-1.1.31-1.38.49s-.9.4-1.37.5c-.49.1-1.1.32-1.38.5s-.9.4-1.37.51c-.49.1-1.15.34-1.5.52-.34.18-1.01.44-1.5.58-.48.14-1.66.54-2.63.9-.96.36-2.13.77-2.62.9-.48.14-1.21.41-1.63.6-.72.32-1.98.76-4.37 1.5-.61.19-1.58.51-2.13.72-1.4.53-2.68.5-3.43-.1-.35-.26-.9-.61-1.23-.75s-1.49-.76-2.59-1.37a48 48 0 0 0-3.62-1.88c-.2-.13-.54-.32-.75-.41-.2-.07-.96-.41-1.68-.75a10 10 0 0 0-1.52-.59c-.14 0-.38-.16-.53-.35s-.6-.42-.97-.51a9 9 0 0 1-1.43-.51 27 27 0 0 0-3.86-1.63c-.15 0-.69-.22-1.2-.5a5 5 0 0 0-1.27-.5 3 3 0 0 1-1-.37 22 22 0 0 0-3.79-1.4c-.48-.14-1.26-.4-1.75-.59-.48-.19-1.89-.64-3.13-1-1.23-.36-2.58-.77-3-.91a22 22 0 0 0-2.27-.61c-.84-.19-1.8-.45-2.13-.59-.32-.15-1.21-.38-1.97-.51-.75-.15-1.99-.43-2.74-.64a11 11 0 0 0-2.16-.38c-.44 0-1.23-.15-1.76-.35-.54-.18-1.82-.41-2.84-.51a38 38 0 0 1-3.63-.52C151.8.91 143.72.37 136.38.37c-7.51-.01-17.68.59-20.88 1.24-.96.19-2.58.42-3.62.51-1.03.1-2.15.29-2.5.41-.34.14-1.46.4-2.5.59-3.23.59-6.5 1.34-6.99 1.61a2.4 2.4 0 0 1-.94.25c-.41-.01-2.27.52-5.07 1.43-.61.2-1.69.51-2.38.7a47 47 0 0 0-4.25 1.39c-.27.12-1.56.62-2.87 1.12a18 18 0 0 0-2.61 1.14c-.13.12-.4.22-.62.22-.2 0-.85.23-1.45.5-2.1.98-3.21 1.48-3.82 1.74-.34.14-.79.38-1 .51-.2.14-.65.37-1 .5-.34.14-.79.37-1 .5-.2.14-.65.37-1 .5-.34.14-.79.37-1 .5-.2.14-.65.37-1 .5-.34.15-1.13.55-1.75.9-.61.35-1.89 1.07-2.83 1.57l-2.37 1.28c-.74.42-8.98 5.93-10.18 6.83a150 150 0 0 0-24.17 22.55c-.88 1.02-3.86 4.84-4.86 6.22-1.12 1.57-5.29 7.8-5.69 8.53-.24.41-.69 1.2-1.03 1.75-.33.55-.78 1.34-1 1.75s-.83 1.54-1.38 2.5a59 59 0 0 0-2.23 4.12c-.12.2-.54 1.05-.9 1.88-.37.82-.77 1.66-.9 1.87-.11.2-.29.54-.37.75-.24.62-1.05 2.42-1.6 3.6-.28.6-.62 1.43-.74 1.82-.13.38-.53 1.5-.89 2.46-.35.96-.8 2.25-.99 2.87-.53 1.73-1.11 3.55-1.41 4.38-.15.41-.42 1.42-.61 2.25-.36 1.62-.98 4.16-1.36 5.75-.14.55-.42 2.01-.6 3.25s-.45 2.7-.6 3.25-.33 1.84-.42 2.87a55 55 0 0 1-.56 4.25c-.59 3.44-.59 18.74 0 22.5.23 1.44.48 3.47.56 4.5s.32 2.49.5 3.25.42 2.1.52 3 .27 1.9.41 2.25c.12.34.39 1.42.56 2.38a44 44 0 0 0 1.53 6.12c.18.48.4 1.27.48 1.75a10 10 0 0 0 .49 1.63c.19.41.45 1.2.59 1.75.4 1.55 1.05 3.44 1.45 4.16.19.36.35.8.35.98 0 .16.24.82.52 1.46l.98 2.15c.25.55.9 1.95 1.46 3.12s1.14 2.4 1.29 2.75c.14.34.54 1.08.86 1.63.34.55.73 1.27.88 1.62.15.34.37.79.51 1s.41.72.62 1.13.65 1.2.99 1.75.76 1.29.94 1.62c.97 1.92 7.17 10.68 8.65 12.23.24.25 1.1 1.21 1.92 2.16 2.89 3.31 2.47 3.11 5.37 2.39 3.6-.93 5.15-1.3 6.37-1.55a10 10 0 0 0 1.88-.59 7 7 0 0 1 1.51-.47c1.11-.22 3.07-.98 6.87-2.67l2.32-1.01c.65-.29 1.36-.62 1.56-.75a7 7 0 0 1 1-.49c.35-.13.8-.36 1-.5.21-.13.66-.36 1-.5.35-.13.8-.36 1-.48.21-.13.85-.48 1.42-.78a20 20 0 0 0 1.88-1.07c.45-.32 1-.63 1.21-.72 1.55-.58 10.7-7.53 14-10.61a161 161 0 0 0 8.49-8.56c1.49-1.73 5.31-6.49 6.12-7.61l1.5-2.04c2.5-3.33 4.85-6.6 5.52-7.69.41-.66 1.56-2.46 2.57-4a57 57 0 0 0 1.99-3.19c.14-.35 1.06-1.82 1.49-2.37.1-.14.33-.54.51-.88.17-.35.6-1.07.94-1.62s.75-1.29.92-1.63c.18-.35.65-1.13 1.05-1.75a28 28 0 0 0 1.99-3.41c.21-.44.49-.82.6-.87s.57-.83 1.02-1.72c.45-.9 1.08-2.07 1.4-2.62.33-.55.78-1.34.99-1.75.23-.41.69-1.2 1.03-1.75.33-.55.78-1.34 1-1.75s.67-1.2 1-1.75.78-1.34 1-1.75.67-1.2 1-1.75.78-1.34 1-1.75.63-1.16.93-1.66c.93-1.54 2.08-3.57 2.28-3.97.09-.21.44-.82.77-1.37s.95-1.66 1.38-2.48c.7-1.32 2.02-3.6 3.69-6.35.31-.51.73-1.26.95-1.67s.63-1.16.93-1.66c2.73-4.57 2.8-4.68 4-6.84.3-.55.73-1 .93-1 .32 0 .37 2.16.41 17.44.03 9.58.1 17.61.18 17.81.16.41 1.53.52 1.77.15.08-.13.73-.36 1.45-.53a9 9 0 0 0 1.81-.61c.28-.17.84-.39 1.25-.49 1.74-.41 5.18-2.16 8.59-4.37 5.81-3.74 11.49-9.49 20.66-20.9l4.54-5.63c.65-.73 1.48-1.73 1.91-2.3 1.68-2.15 4.64-5.98 5.05-6.55.28-.37.77-.97 1.08-1.31s1.04-1.26 1.61-2.05c.58-.77 4.36-5.6 8.43-10.71a722 722 0 0 0 11.4-14.65c1.58-2.03 1.58-1.99-.47-3.66a66 66 0 0 0-2.61-2.07l-2.5-1.77-2.81-2.05c-.61-.46-2.59-1.84-4.38-3.04a62 62 0 0 1-4-2.85 8 8 0 0 0-1.47-1.02c-.4-.19-.71-.45-.71-.59 0-.38 1.93-1.25 4.43-1.99 1.24-.37 2.65-.82 3.13-1.01.49-.19 1.16-.41 1.5-.5s.96-.3 1.37-.49c.83-.35 2.63-.97 4.38-1.51 1.19-.36 2.72-.91 5.62-2 .97-.36 2.29-.81 2.95-1a6 6 0 0 0 1.5-.58c.17-.12.75-.35 1.3-.48a41 41 0 0 0 2.75-.93 72 72 0 0 1 2.88-1c1.96-.6 4.06-1.37 4.35-1.61.15-.11.67-.3 1.15-.4a6 6 0 0 0 1.37-.46c.28-.15.95-.42 1.5-.58s1.79-.59 2.75-.95a76 76 0 0 1 5.38-1.91c.49-.14 1.21-.4 1.62-.58.84-.37 2.67-1 4.38-1.52.62-.19 1.91-.64 2.87-.99l2.75-1c.55-.19 1.79-.64 2.75-1a88 88 0 0 1 2.83-1 7 7 0 0 0 1.37-.57c.4-.3 2.44-.88 2.59-.74.19.19.15.91-.14 3.17-.13 1.17-.37 4.2-.52 6.75s-.36 5.3-.49 6.13c-.12.82-.3 2.85-.39 4.5s-.32 4.01-.51 5.25a68 68 0 0 0-.5 5.5c-.07 1.79-.3 4.6-.49 6.25-.2 1.65-.42 4.57-.51 6.5-.07 1.92-.3 4.79-.49 6.37-.18 1.58-.41 4.05-.5 5.5a88 88 0 0 1-.52 5.5c-.2 1.58-.44 4.68-.54 6.88-.17 3.82-.21 4-.72 4.07-.29.04-.73-.12-.97-.36a262 262 0 0 0-8.42-6.66c-1.48-1.13-3.3-2.5-4.06-3.05l-5.12-3.74c-1.18-.89-1.86-.81-2.83.29l-1.2 1.32c-1.09 1.13-8.09 9.94-11.24 14.13a139 139 0 0 1-4.88 6.26 4339 4339 0 0 1-15 19 78 78 0 0 1-3.13 3.94c-.54.6-.9 1.02-2.83 3.4-2.39 2.92-2.96 3.55-7.29 7.89a72 72 0 0 1-8.12 7.41c-3.26 2.65-5.4 4.22-5.74 4.22q-.24.02-.26.23c0 .12-.7.64-1.56 1.14s-2.29 1.36-3.19 1.9c-1.71 1.03-8.55 4.48-8.89 4.48-.11 0-.66.22-1.22.47a48 48 0 0 1-8.02 2.68c-.55.1-1.33.32-1.75.49s-1.36.39-2.12.49c-.75.1-1.8.34-2.34.54-.54.18-1.41.33-1.94.33-1.72 0-1.66-.47-1.76 14.5l-.09 13.37.63.28c1.42.65 11.16-.33 15.12-1.53.69-.22 1.77-.48 2.38-.6 1.42-.29 3.41-.94 4.34-1.4.38-.2.83-.37 1-.37.15 0 .85-.28 1.53-.62a6 6 0 0 1 1.67-.61c.21-.02.53-.18.7-.38s.62-.42 1.01-.51.85-.31 1.01-.51.41-.37.56-.37c.27 0 3.92-2.06 4.84-2.73a73 73 0 0 0 12.1-10.97c.48-.6 1.06-1.32 1.31-1.61a79 79 0 0 0 4.57-6.99c.2-.45.47-1 .61-1.2.12-.21.52-1.05.89-1.87s.87-1.96 1.13-2.51c.27-.57.48-1.15.48-1.3s.16-.59.36-.98c.76-1.5 1.75-5.3 2.36-9.11.18-1.1.42-1.6 1.08-2.25.46-.48 2.74-3.21 5.06-6.1 2.33-2.89 4.55-5.56 4.95-5.94l.71-.69h8.47c7.28 0 8.5.05 8.77.39.45.54.16 14.11-.35 16.24-.2.82-.44 2.11-.52 2.87-.1.75-.33 1.88-.52 2.5-.18.62-.52 1.85-.73 2.75-.83 3.42-1.17 4.6-1.37 4.87-.11.13-.28.6-.37 1.01-.18.75-.94 2.85-1.55 4.25-1.3 2.99-1.81 4.1-3.15 6.75-2.13 4.22-5.59 9.94-6.99 11.49-.19.2-.56.66-.84 1.02s-.62.79-.78.96c-.17.18-.89 1.04-1.62 1.93A88 88 0 0 1 185 197c-4.06 2.65-4.08 2.66-5 3.12-.41.21-1.2.65-1.75.99-.55.32-1.27.72-1.62.87-.34.15-1.09.5-1.64.77-.56.26-1.14.48-1.29.48s-.4.17-.57.38c-.18.2-.5.37-.71.37-.23 0-.75.19-1.17.4-.41.23-1.2.55-1.75.73-.55.19-1.78.62-2.75.99-.96.36-2.31.81-3 .97-.68.18-1.47.44-1.75.59-.27.15-1 .35-1.62.45-.61.1-1.4.32-1.75.5a7 7 0 0 1-1.88.47c-.68.1-1.75.33-2.37.52-.61.2-1.8.42-2.63.51s-2.4.35-3.5.57c-2.91.62-22.47.62-24.75 0a24 24 0 0 0-3.12-.57c-.89-.1-2.13-.33-2.75-.51-.61-.2-1.43-.42-1.79-.48-.36-.07-.74-.32-.82-.56-.2-.54-.2-26.01 0-26.34.22-.37-.14-1.24-.52-1.24-.2 0-.43.17-.55.35-.11.19-.56.78-1.01 1.32-.44.52-2.4 2.98-4.35 5.46-4.36 5.55-4.16 5.32-10.71 11.87a118 118 0 0 1-8.75 8.05c-3.13 2.47-11.05 7.95-11.5 7.95-.1 0-.34.18-.51.39a4 4 0 0 1-1.09.76c-.43.2-1.23.64-1.78.98a85 85 0 0 1-4.5 2.34c-3.37 1.66-4.52 2.2-7.06 3.3-.65.28-1.52.67-1.94.87s-1.08.43-1.5.51-.87.27-1.02.39-1.16.46-2.25.78c-2.63.75-2.7 1.16-.55 2.7 3 2.16 5.49 3.81 6.2 4.15.21.1.91.56 1.57 1.02.67.46 1.45.95 1.75 1.09s1 .52 1.55.85c.55.34 1.34.77 1.75.99.42.21.93.48 1.13.63.21.14.66.37 1 .5a165 165 0 0 0 10.25 4.88 11 11 0 0 1 1.5.66c.47.25.97.46 1.11.46.25 0 2.36.78 3.76 1.38.8.35 2.53.94 4.38 1.51l2.37.75c3.39 1.08 6.59 1.84 12.63 2.98 1.17.22 2.86.56 3.75.76s2.3.42 3.12.5 2.29.31 3.25.5c.97.2 3.39.47 5.38.62 2 .14 4.7.37 6 .5 3.06.3 13.64.3 16.87-.01 1.38-.12 4.08-.35 6-.49 1.93-.15 4.29-.42 5.25-.61.97-.2 2.54-.42 3.5-.51a21 21 0 0 0 3-.5c.69-.2 1.93-.43 2.75-.51.83-.1 1.88-.33 2.34-.52.48-.2 1.09-.35 1.39-.35s1.15-.17 1.91-.38c.75-.22 2.04-.54 2.86-.73.83-.17 1.79-.44 2.13-.57.35-.14 1.64-.57 2.87-.94 1.24-.36 2.54-.81 2.88-.99.35-.17.96-.4 1.37-.49 1.29-.3 4.47-1.57 8.39-3.37a8 8 0 0 1 1.34-.53c.1 0 1.27-.51 2.6-1.15l5.05-2.36a7 7 0 0 1 1-.49c.35-.13.8-.36 1-.5.21-.13.71-.41 1.12-.62s1.18-.63 1.68-.94l3.47-2.06c2.92-1.73 2.77-1.63 6.52-4.2 3.7-2.55 4.4-3.06 5.46-3.94.47-.4 1.84-1.49 3-2.41 2.36-1.89 2.8-2.25 6.24-5.35a148 148 0 0 0 12.8-13.23c.42-.48.95-1.16 1.17-1.5a84 84 0 0 1 2.16-2.87 96 96 0 0 0 3.5-4.88 47 47 0 0 1 2.19-3.06c.24-.24.44-.56.44-.71s.32-.69.71-1.19c.4-.5.91-1.25 1.15-1.66l1.03-1.75c.33-.55.77-1.34.98-1.75.22-.41.49-.93.63-1.13.14-.21.36-.66.5-1a130 130 0 0 0 4-8.43c0-.12.22-.65.5-1.19.27-.54.5-1.15.51-1.36 0-.22.16-.6.38-.88.2-.26.36-.65.36-.86s.21-.83.47-1.39c.45-.99.95-2.39 1.65-4.64l.72-2.25c.2-.62.61-1.97.9-3l.88-3c.2-.62.47-1.75.6-2.5.13-.76.35-1.66.48-2.01.14-.35.32-1.42.42-2.37s.33-2.37.5-3.12c.19-.76.42-2.16.5-3.12s.34-3.05.57-4.63c.56-4.07.56-18.66 0-22.75-.23-1.58-.48-3.72-.57-4.75a26 26 0 0 0-.41-3c-.15-.62-.41-2.2-.59-3.5-.38-2.87-1-5.97-1.48-7.5-.19-.62-.43-1.68-.53-2.37a8 8 0 0 0-.42-1.74c-.14-.26-.4-1.05-.58-1.75a36 36 0 0 0-1.49-4.51c-.18-.41-.62-1.6-1-2.63a42 42 0 0 0-1.06-2.68c-.49-1-.46-4.08.05-7.57.19-1.31.43-3.56.51-5 .09-1.45.32-3.92.5-5.5.19-1.58.42-4.22.5-5.87s.3-4.24.5-5.75c.19-1.51.42-4.28.5-6.13.09-1.86.32-4.45.5-5.75.19-1.31.42-3.67.5-5.25s.32-4.11.5-5.62c.2-1.51.48-4.54.63-6.73.15-2.18.31-4.06.37-4.16.07-.09.24-2.07.38-4.39s.42-5.41.62-6.85c.3-2.27.52-5.71.42-6.68-.05-.39-1.24-.4-1.9-.02M146.75 43.57c.97.2 2.54.44 3.5.54.97.09 2.27.31 2.88.5.62.19 1.64.41 2.25.5s1.64.31 2.25.51 1.8.54 2.62.75a71 71 0 0 1 12 4.13c1.59.68 7.95 3.87 9.17 4.57l2.28 1.34a39 39 0 0 1 2.45 1.57c.62.43 1.47 1.02 1.92 1.29.45.29.81.71.81.96s-.6 1.08-1.35 1.84a47 47 0 0 0-4.03 4.78c-.27.38-1.35 1.78-2.38 3.11a484 484 0 0 0-3.98 5.15c-4.62 6.07-5.12 6.55-6.07 5.71-.7-.61-2.54-1.84-2.75-1.84-.09 0-.58-.28-1.09-.62a42 42 0 0 0-3.83-2.01l-3.61-1.75a3 3 0 0 0-.97-.37c-.15 0-.74-.21-1.3-.47-.93-.43-2.85-1.04-6.64-2.1-.75-.21-1.99-.46-2.75-.55-.75-.09-2.21-.35-3.25-.58-2.71-.61-16.64-.61-18.88-.01-.82.24-2.17.5-3 .59-.82.1-1.68.27-1.9.39s-1.12.38-2 .58a23 23 0 0 0-4.76 1.55c-.36.19-.8.35-.95.35-.65 0-6.9 3.08-8.71 4.29-.59.39-1.15.71-1.24.71-.34 0-3.84 2.48-6.56 4.65a55 55 0 0 0-11.65 12.85c-1.58 2.38-1.58 2.39-3.05 5.38-1.79 3.62-2.3 4.75-2.3 5.06 0 .15-.16.59-.36.98-.47.9-1.09 2.81-1.52 4.58-.17.75-.43 1.67-.57 2.02s-.38 1.66-.53 2.92a65 65 0 0 1-.52 3.58c-.45 2.33-.3 9.85.26 13.91.29 2.04.64 4.09.79 4.57s.42 1.55.6 2.38c.61 2.95 1.74 5.91 3.91 10.27l1.75 3.52-.46.72c-.26.4-.63.9-.8 1.11-.19.2-1.8 2.23-3.59 4.5-1.8 2.27-3.34 4.18-3.42 4.25-.1.07-.95 1.08-1.9 2.25-2.07 2.54-6.55 7.02-7.95 7.95-.97.64-1.03.64-1.29.22-.15-.27-.6-.88-.99-1.38a91 91 0 0 1-4.31-6.51c-2.2-3.94-2.63-4.73-2.85-5.28-.14-.35-.36-.8-.5-1a8 8 0 0 1-.51-1c-.14-.35-.42-.96-.62-1.37a21 21 0 0 1-1.37-3.48c0-.15-.21-.67-.46-1.15a8 8 0 0 1-.65-1.7 7 7 0 0 0-.54-1.5 3 3 0 0 1-.35-.98c0-.18-.21-.97-.48-1.75-.26-.79-.55-1.89-.65-2.44-.08-.55-.31-1.51-.51-2.13-1.04-3.37-1.86-11.08-1.86-17.46 0-4.17.46-10.92.86-12.54.19-.76.43-2.05.53-2.87.08-.83.31-1.85.48-2.28.18-.42.4-1.38.5-2.12s.34-1.75.53-2.23.45-1.32.57-1.87a36 36 0 0 1 1.39-4.25c.18-.41.69-1.69 1.13-2.84a31 31 0 0 1 1.51-3.54c.14-.35.36-.8.5-1a71 71 0 0 1 3.75-6.85c5.7-9.17 10.82-15.03 19.6-22.46.29-.24 1.2-.95 2.02-1.56s1.67-1.26 1.87-1.43c1.8-1.53 7.55-4.88 12.51-7.31 3.61-1.76 4.32-2.09 5-2.27.35-.1.74-.27.87-.37.35-.27 3.35-1.43 4.25-1.65.42-.1.98-.31 1.25-.48.28-.17.95-.39 1.49-.48.55-.1 1.28-.32 1.63-.5a8 8 0 0 1 1.88-.5c.69-.1 1.53-.32 1.88-.5s1.25-.4 2-.49c.76-.1 1.94-.33 2.62-.52s1.99-.41 2.88-.5c.9-.09 2.07-.29 2.62-.43 1.99-.52 5.14-.66 13.13-.57 5.99.06 8.59.19 9.87.46"/></g></svg>`;
// Samma favicon/logga som huvudsidan (web-assets/favicon.svg) → identisk flik-ikon + nav.
const FAVICON = "data:image/svg+xml," + encodeURIComponent(LOGO_SVG);
const LOGO_MARK = LOGO_SVG.replace("<svg ", '<svg class="logomark" ');

function layout(o: {
  title: string; desc: string; canonical: string; h1: string; intro: string;
  crumbs: { name: string; url?: string }[]; bodyHtml: string; jsonld: object[]; noindex?: boolean;
  image?: string; eyebrow?: string;
}): string {
  const robots = o.noindex
    ? "noindex, follow"
    : "index, follow, max-image-preview:large, max-snippet:-1";
  const ld = { "@context": "https://schema.org", "@graph": o.jsonld };
  const crumbNav = o.crumbs.map((c, i) =>
    c.url && i < o.crumbs.length - 1
      ? `<a href="${esc(c.url.replace(SITE, "") || "/")}">${esc(c.name)}</a>`
      : `<span>${esc(c.name)}</span>`
  ).join('<span class="sep">/</span>');
  return `<!doctype html>
<html lang="sv"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.desc)}" />
<meta name="robots" content="${robots}" />
<meta name="theme-color" content="#111110" />
<link rel="canonical" href="${esc(o.canonical)}" />
<link rel="icon" href="${FAVICON}" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Allarop" />
<meta property="og:title" content="${esc(o.title)}" />
<meta property="og:description" content="${esc(o.desc)}" />
<meta property="og:url" content="${esc(o.canonical)}" />
<meta property="og:image" content="${esc(o.image || `${SITE}/og-image.png`)}" />
<meta property="og:image:alt" content="${esc(o.h1)}" />
<meta property="og:locale" content="sv_SE" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${esc(o.image || `${SITE}/og-image.png`)}" />
<meta name="twitter:image:alt" content="${esc(o.h1)}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="dns-prefetch" href="https://media.se.klaravik.com" />
<link rel="dns-prefetch" href="https://cdn.blinto.se" />
<link rel="dns-prefetch" href="https://images.auctionet.com" />
<link rel="dns-prefetch" href="https://d2q01ftr6ua4w.cloudfront.net" />
<link rel="preload" as="style" href="${FONT}" onload="this.onload=null;this.rel='stylesheet'" />
<noscript><link rel="stylesheet" href="${FONT}" /></noscript>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
:root{--bg:#f4f3ef;--bg-2:#eceae3;--ink:#111110;--ink-soft:#76746c;--ink-faint:#8f8a7e;--line:#e6e3da;--line-2:#dcd8cd;--accent:#0e7d63;--accent-ink:#0a5e4a;--accent-soft:#e2f1ec;--green:#0c8a5a;--r:18px;--r-sm:12px}
@font-face{font-family:"SG Fallback";src:local("Arial");ascent-override:96%;descent-override:24%;line-gap-override:0%;size-adjust:100%}
*{margin:0;box-sizing:border-box}
body{font-family:"Schibsted Grotesk","SG Fallback",system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--ink);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.wrap{max-width:1200px;margin:0 auto;padding:0 22px}
nav.top{position:sticky;top:0;z-index:40;background:rgba(244,243,239,.82);backdrop-filter:saturate(1.4) blur(12px);-webkit-backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid var(--line)}
nav.top .nav-in{display:flex;align-items:center;justify-content:space-between;height:64px}
.logo{display:flex;align-items:center;gap:10px;color:var(--ink)}
.logo .logomark{width:34px;height:34px;flex:none;display:block}
.logo .logotext{display:flex;flex-direction:column;line-height:1.08}
.logo .logotext b{font-weight:800;font-size:18px;letter-spacing:-.02em}
.logo .logotext small{font-weight:500;font-size:11px;color:var(--ink-soft)}
.navcta{font-size:13px;font-weight:700;color:var(--accent-ink);background:var(--accent-soft);padding:9px 16px;border-radius:999px;white-space:nowrap}
.navcta:hover{background:#d3e9e0}
.navsearch{display:none;flex:1;min-width:0;max-width:440px;margin:0 18px}
.navsearch input{width:100%;padding:9px 16px;border:1px solid var(--line);border-radius:999px;font:inherit;font-size:14px;background:#fff;color:var(--ink)}
.navsearch input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
nav.top.scrolled .navsearch{display:block}
nav.top.scrolled .navcta{display:none}
@media(max-width:600px){.navsearch{margin:0 8px}.navsearch input{padding:8px 12px;font-size:13px}}
nav.bc{font-size:13px;color:var(--ink-soft);padding:18px 0 4px}
nav.bc .sep{margin:0 8px;opacity:.5}
nav.bc a:hover{color:var(--accent)}
h1{font-size:clamp(24px,4vw,32px);font-weight:800;letter-spacing:-.02em;margin:10px 0}
.lead{font-size:16px;color:var(--ink-soft);max-width:72ch;margin-bottom:6px}
h2{font-size:19px;font-weight:800;margin:34px 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-top:20px}
.c{background:#fff;border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden;display:flex;flex-direction:column;transition:box-shadow .15s,transform .15s}
.c:hover{box-shadow:0 10px 26px -14px rgba(17,17,16,.25);transform:translateY(-3px);border-color:var(--line-2)}
.cimg{aspect-ratio:300/220;background:var(--bg-2);overflow:hidden}
.cimg img{width:100%;height:100%;object-fit:cover;display:block}
.noimg{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--ink-faint);font-size:12px}
.cbody{padding:11px 13px;display:flex;flex-direction:column;gap:5px;flex:1}
.ctitle{font-size:14px;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.55em}
.cmeta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:auto}
.cprice{font-weight:800;font-size:14px}
.chouse{font-size:11px;font-weight:600;color:var(--accent-ink);background:var(--accent-soft);padding:3px 8px;border-radius:999px;white-space:nowrap}
.cends{font-size:11px;color:var(--ink-soft)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.chip{font-size:13px;font-weight:600;background:#fff;border:1px solid var(--line);color:var(--ink);padding:6px 13px;border-radius:999px}
.chip:hover{border-color:var(--accent);color:var(--accent)}
.cta{display:inline-flex;align-items:center;gap:10px;margin:18px 0;background:var(--ink);color:#fff;padding:15px 22px;border-radius:999px;font-weight:600;font-size:15.5px;transition:background .15s}
.cta:hover{background:var(--accent)}
.empty{padding:40px 0;color:var(--ink-soft)}
.eyebrow{font-size:11.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-faint);margin:14px 0 2px}
.snabbsvar{border-left:3px solid var(--ink);padding:2px 0 2px 16px;margin:18px 0;font-size:16px;line-height:1.6;color:var(--ink)}
.byline{font-size:13px;color:var(--ink-faint);margin:2px 0 18px}
.seo-faq{border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin-bottom:8px;background:#fff}
.seo-faq summary{font-weight:700;font-size:14px;cursor:pointer;list-style:none;color:var(--ink)}
.seo-faq summary::-webkit-details-marker{display:none}
.seo-faq p{margin:10px 0 2px}
.glist{max-width:72ch}
.gcard{padding:16px 0;border-top:1px solid var(--line)}
.gcard:first-child{border-top:0}
.gcard .eyebrow{margin:0}
.gcard a{font-size:17px;font-weight:700;line-height:1.35;display:block;margin:3px 0 4px}
.gcard a:hover{color:var(--accent)}
.gcard p{margin:0;color:var(--ink-soft);font-size:14px;line-height:1.4}
.prose p{margin:12px 0;color:var(--ink-soft);max-width:72ch}
.prose h2{margin-top:28px}
.prose img{display:block;width:100%;max-width:72ch;height:auto;border-radius:var(--r-sm);margin:22px 0 6px}
.prose p:has(> img:only-child){margin:22px 0 6px}
.prose p:has(> img:only-child) + p > em:only-child{display:block;font-size:12.5px;color:var(--ink-faint);margin-top:-2px;margin-bottom:18px}
.prose table{border-collapse:collapse;width:100%;max-width:72ch;margin:18px 0;font-size:14px}
.prose th,.prose td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left}
.prose th{font-weight:700;color:var(--ink-faint);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
footer.ft{border-top:1px solid var(--line);margin-top:40px}
footer.ft .foot-in{display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:26px 0;font-size:13px;color:var(--ink-soft)}
.footlinks{display:flex;flex-wrap:wrap;gap:14px}
.footlinks a{font-weight:600}.footlinks a:hover{color:var(--accent)}
.guide-hero{padding:4px 0 0}
.cluster-section{margin:34px 0 10px}
.filter-bar{position:sticky;top:64px;z-index:30;background:rgba(244,243,239,.9);backdrop-filter:saturate(1.2) blur(10px);-webkit-backdrop-filter:saturate(1.2) blur(10px);border-bottom:1px solid var(--line);padding:12px 0;margin:0 0 24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.filter-bar span{font-size:13px;font-weight:700;color:var(--ink-soft);white-space:nowrap}
.filter-bar .chips{margin:0}
.guide-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px;margin-top:14px}
.guide-grid.small{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.featured-guides{margin:34px 0 10px}
.all-guides{margin:34px 0 10px}
.guide-card{background:#fff;border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden;transition:box-shadow .15s,transform .15s,border-color .15s}
.guide-card:hover{box-shadow:0 12px 30px -14px rgba(17,17,16,.22);transform:translateY(-3px);border-color:var(--accent)}
.guide-card>a{display:flex;flex-direction:column;height:100%}
.guide-card-body{padding:20px 18px;display:flex;flex-direction:column;gap:8px;flex:1}
.guide-card-body .eyebrow{margin:0;font-size:11px}
.guide-card-body h3{font-size:16px;font-weight:700;line-height:1.32;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.5em}
.guide-card-body p{color:var(--ink-soft);font-size:13.5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;flex:1}
.guide-meta{margin-top:auto;font-size:12px;color:var(--ink-faint);font-weight:600;padding-top:6px}
.article-layout{display:grid;grid-template-columns:220px 1fr;gap:34px;align-items:start;margin-top:8px}
.toc{position:sticky;top:84px;background:#fff;border:1px solid var(--line);border-radius:var(--r-sm);padding:14px;font-size:13px}
.toc strong{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint);margin-bottom:10px}
.toc a{display:block;padding:5px 0;color:var(--ink-soft);border-bottom:1px solid var(--line);line-height:1.35}
.toc a:last-child{border-bottom:0}
.toc a:hover{color:var(--accent)}
.article-main{min-width:0}
.prose{font-size:17px;line-height:1.7;color:var(--ink)}
.prose p{color:var(--ink-soft);margin:14px 0}
.prose h2{margin-top:38px;margin-bottom:14px;font-size:22px}
.prose h3{font-size:18px;margin:28px 0 10px}
.prose ul,.prose ol{margin:14px 0;padding-left:1.4em}
.prose li{margin:6px 0}
.prose blockquote{border-left:3px solid var(--accent);padding:2px 0 2px 18px;margin:20px 0;color:var(--ink);font-style:italic;background:transparent}
.prose table{font-size:15px}
.prose th,.prose td{padding:10px 12px}
.prose img{border-radius:var(--r-sm)}
.info-box{background:#fff;border:1px solid var(--line);border-radius:var(--r-sm);padding:16px 18px;margin:28px 0;font-size:14px;color:var(--ink-soft)}
.info-box div{display:inline-block;margin-right:18px;margin-bottom:4px}
.info-box div strong{color:var(--ink);font-weight:700}
.info-box p{margin:10px 0 0}
.share{margin:22px 0;display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.share strong{font-size:14px;margin-right:6px}
.share a{font-size:13px;font-weight:600;background:#fff;border:1px solid var(--line);padding:7px 13px;border-radius:999px}
.share a:hover{border-color:var(--accent);color:var(--accent)}
.related-guides{margin-top:34px}
.item-layout{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(280px,380px);gap:34px;align-items:start;margin-top:18px}
.item-media{min-width:0}
.item-sidebar{position:sticky;top:84px;display:flex;flex-direction:column;gap:18px}
.gallery{width:100%}
.gallery input{position:absolute;opacity:0;pointer-events:none}
.gallery-stage{position:relative;aspect-ratio:4/3;background:var(--bg-2);border-radius:var(--r);overflow:hidden;border:1px solid var(--line)}
.main-img{display:none;position:absolute;inset:0;cursor:pointer}
.main-img img{width:100%;height:100%;object-fit:cover;display:block}
.gallery input:nth-of-type(1):checked~.gallery-stage .main-img:nth-child(1),.gallery input:nth-of-type(2):checked~.gallery-stage .main-img:nth-child(2),.gallery input:nth-of-type(3):checked~.gallery-stage .main-img:nth-child(3),.gallery input:nth-of-type(4):checked~.gallery-stage .main-img:nth-child(4),.gallery input:nth-of-type(5):checked~.gallery-stage .main-img:nth-child(5),.gallery input:nth-of-type(6):checked~.gallery-stage .main-img:nth-child(6),.gallery input:nth-of-type(7):checked~.gallery-stage .main-img:nth-child(7),.gallery input:nth-of-type(8):checked~.gallery-stage .main-img:nth-child(8){display:block}
.gallery-thumbs{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.thumb{width:76px;height:58px;border-radius:8px;overflow:hidden;border:2px solid transparent;cursor:pointer;opacity:.65;transition:opacity .15s,border-color .15s;background:var(--bg-2)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.gallery input:nth-of-type(1):checked~.gallery-thumbs .thumb:nth-child(1),.gallery input:nth-of-type(2):checked~.gallery-thumbs .thumb:nth-child(2),.gallery input:nth-of-type(3):checked~.gallery-thumbs .thumb:nth-child(3),.gallery input:nth-of-type(4):checked~.gallery-thumbs .thumb:nth-child(4),.gallery input:nth-of-type(5):checked~.gallery-thumbs .thumb:nth-child(5),.gallery input:nth-of-type(6):checked~.gallery-thumbs .thumb:nth-child(6),.gallery input:nth-of-type(7):checked~.gallery-thumbs .thumb:nth-child(7),.gallery input:nth-of-type(8):checked~.gallery-thumbs .thumb:nth-child(8){opacity:1;border-color:var(--accent)}
.price-card{background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:22px;display:flex;flex-direction:column;gap:12px;box-shadow:0 10px 30px -16px rgba(17,17,16,.12)}
.price-row{display:flex;flex-direction:column;gap:2px}
.price-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint)}
.price-amount{font-size:32px;font-weight:800;letter-spacing:-.02em;color:var(--ink)}
.status-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.status-badge{font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px}
.status-badge.active{background:var(--accent-soft);color:var(--accent-ink)}
.status-badge.ended{background:var(--bg-2);color:var(--ink-soft)}
.ends-in{font-size:13px;color:var(--ink-soft)}
.info-row{font-size:14px;color:var(--ink-soft)}
.cta.big{width:100%;justify-content:center;margin:6px 0 0}
.disclaimer{font-size:12px;color:var(--ink-faint);margin:0;line-height:1.45}
.specs{background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:18px 20px}
.specs h2{font-size:16px;margin:0 0 12px}
.spec-row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}
.spec-row:last-child{border-bottom:0}
.spec-row span{color:var(--ink-faint)}
.spec-row strong{color:var(--ink);font-weight:700;text-align:right}
.desc-body{margin-top:22px;font-size:17px;line-height:1.7;color:var(--ink)}
.desc-body p{margin:14px 0;color:var(--ink-soft)}
.desc-body ul,.desc-body ol{margin:14px 0;padding-left:1.4em;color:var(--ink-soft)}
.desc-body li{margin:6px 0}
.desc-body h2{font-size:20px;margin:26px 0 10px}
.desc-body h3{font-size:18px;margin:22px 0 8px}
.desc-body strong{color:var(--ink)}
.similar{margin-top:44px}
.related-collapse{margin-top:34px;background:#fff;border:1px solid var(--line);border-radius:var(--r-sm);padding:14px 16px}
.related-collapse summary{font-weight:700;font-size:14px;cursor:pointer;list-style:none;color:var(--ink)}
.related-collapse summary::-webkit-details-marker{display:none}
.related-collapse .chips{margin-top:10px}
.desc-body.structured{font-size:14px;line-height:1.6;color:var(--ink-soft)}
.desc-body.structured p{background:#fff;border:1px solid var(--line);border-radius:var(--r-sm);padding:16px 18px;margin:0;max-height:400px;overflow-y:auto}
.desc-body.structured br{margin-bottom:2px}
@media(max-width:760px){.article-layout{grid-template-columns:1fr}.toc{position:static;margin-bottom:18px}.filter-bar{top:64px}.guide-grid,.guide-grid.small{grid-template-columns:1fr}.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.logo .logotext small{display:none}.item-layout{grid-template-columns:1fr}.item-sidebar{position:static}.price-amount{font-size:28px}}
.skip-nav{position:absolute;left:-9999px;top:0;background:var(--ink);color:#fff;padding:10px 18px;border-radius:0 0 12px 0;z-index:100;font-weight:600}
.skip-nav:focus{left:0}
</style>
</head><body>
<a class="skip-nav" href="#main-content">Hoppa till innehåll</a>
<nav class="top"><div class="wrap nav-in">
<a class="logo" href="/" aria-label="allarop.se">${LOGO_MARK}<span class="logotext"><b>allarop.se</b><small>Alla Sveriges nätauktioner</small></span></a>
<form class="navsearch" action="/" method="get" role="search">
<input type="search" name="q" placeholder="Sök bland alla auktioner…" aria-label="Sök bland alla auktioner" />
</form>
<a class="navcta" href="/">Sök alla auktioner →</a>
</div></nav>
<script>(function(){var t=document.querySelector('nav.top');if(!t)return;function f(){t.classList.toggle('scrolled',window.scrollY>160)}window.addEventListener('scroll',f,{passive:true});f();})();</script>
<main id="main-content"><div class="wrap">
<nav class="bc" aria-label="Brödsmulor">${crumbNav}</nav>
${o.eyebrow ? `<div class="eyebrow">${esc(o.eyebrow)}</div>` : ""}
<h1>${esc(o.h1)}</h1>
<p class="lead">${o.intro}</p>
${o.bodyHtml}
</div></main>
<footer class="ft"><div class="wrap foot-in">
<span>Allarop &ndash; aggregator &amp; mellanhand. All budgivning sker hos respektive auktionssajt.</span>
<span class="footlinks"><a href="/">Sök</a><a href="/guide/vad-ar-natauktioner">Om nätauktioner</a><a href="/om">Om</a><a href="/om#villkor">Villkor</a><a href="/om#integritet">Integritet</a><a href="/om#kontakt">Kontakt</a></span>
</div></footer>
</body></html>`;
}

// ── Schema-hjälpare ──────────────────────────────────────────────────────────
function breadcrumb(crumbs: { name: string; url?: string }[]): object {
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem", position: i + 1, name: c.name,
      ...(c.url ? { item: c.url } : {}),
    })),
  };
}
function itemListSchema(id: string, name: string, rows: SearchRow[]): object {
  return {
    "@type": "ItemList", "@id": id, name, numberOfItems: rows.length,
    itemListElement: rows.slice(0, 40).map((r, i) => ({
      "@type": "ListItem", position: i + 1, url: itemUrl(r), name: r.title,
    })),
  };
}

// ── Landningssidor ───────────────────────────────────────────────────────────
function relatedChips(current: string): string {
  const cats = TAXONOMY.map((m) =>
    `<a class="chip" href="/kategori/${m.key}">${m.icon} ${esc(m.label)}</a>`).join("");
  const houses = HOUSE_KEYS.slice(0, 12).map((h) =>
    `<a class="chip" href="/auktioner/${h}">${esc(houseName(h))}</a>`).join("");
  // Utan denna rad var alla 20 /plats/<stad>-sidor helt orphanade (inget länkade till dem
  // någonstans på sajten) - bekräftat av en seo-mcp-crawl. Chips-raden renderas på alla
  // kategori-/hus-/ort-sidor, så det räcker för att ge dem interna länkar.
  const orts = CITIES.map((c) =>
    `<a class="chip" href="/plats/${slugify(c)}">${esc(c)}</a>`).join("");
  return (
    `<h2>Bläddra efter kategori</h2><div class="chips">${cats}</div>` +
    `<h2>Bläddra efter auktionshus</h2><div class="chips">${houses}</div>` +
    `<h2>Bläddra efter ort</h2><div class="chips">${orts}</div>`
  );
}

function gridOrEmpty(rows: SearchRow[], emptyMsg: string): string {
  if (!rows.length) return `<p class="empty">${esc(emptyMsg)} Titta gärna in igen – nya objekt tillkommer löpande, eller <a href="/">sök bland alla auktioner</a>.</p>`;
  return `<div class="grid">${rows.map((r, i) => card(r, i)).join("")}</div>`;
}

async function renderCategory(hit: CatHit): Promise<string> {
  const opts: ListOpts = { category: hit.key, limit: 60, sort: "ending" };
  const rows = await listActive(opts);
  const isSub = hit.key.includes("/");
  const label = hit.label;
  const canonical = `${SITE}/kategori/${hit.key}`;
  const title = `${label} på nätauktion – ${rows.length ? "köp begagnat" : "alla auktioner"} | Allarop`;
  const desc = `Alla ${label.toLowerCase()} på svenska nätauktioner samlade på ett ställe. Sök, jämför och buda på ${label.toLowerCase()} från Klaravik, Auctionet, PS Auction m.fl. Se totalpriset inkl. avgifter.`;
  const crumbs = [
    { name: "Allarop", url: `${SITE}/` },
    ...(isSub ? [{ name: hit.mainLabel, url: `${SITE}/kategori/${hit.main}` }] : []),
    { name: label },
  ];
  const subChips = !isSub
    ? (() => {
        const m = TAXONOMY.find((x) => x.key === hit.key);
        if (!m || !m.subs.length) return "";
        return `<div class="chips">${m.subs.map((s) =>
          `<a class="chip" href="/kategori/${hit.key}/${s.key}">${esc(s.label)}</a>`).join("")}</div>`;
      })()
    : "";
  const intro = `Bläddra bland <strong>${label.toLowerCase()}</strong> från alla Sveriges nätauktioner. Vi samlar objekt från 29 auktionssajter så att du kan jämföra och hitta fynd på ett ställe – med det verkliga totalpriset inklusive avgifter.`;
  const { byCat } = guideLinksIndex();
  const catGuides = [...(byCat.get(hit.key) ?? []), ...(hit.main !== hit.key ? (byCat.get(hit.main) ?? []) : [])];
  const body = subChips + gridOrEmpty(rows, `Inga aktiva ${label.toLowerCase()} just nu.`) + relatedChips(hit.key) + guidesModule(catGuides);
  return layout({
    title, desc, canonical, h1: `${label} på nätauktion`, intro, crumbs, bodyHtml: body,
    jsonld: [
      { "@type": "CollectionPage", "@id": canonical, url: canonical, name: `${label} på nätauktion`, isPartOf: { "@id": `${SITE}/#website` } },
      breadcrumb(crumbs.map((c) => ({ name: c.name, url: c.url }))),
      itemListSchema(`${canonical}#items`, `${label} på nätauktion`, rows),
    ],
  });
}

async function renderHouse(house: string): Promise<string> {
  const name = houseName(house);
  const rows = await listActive({ house, limit: 60, sort: "ending" });
  const canonical = `${SITE}/auktioner/${house}`;
  // Långa husnamn (t.ex. "Auktionsbyrån Effecta") gjorde titeln 61-81 tecken - trunkeras i
  // sökresultat. Kortare suffix när det inte ryms inom ~60 tecken (bekräftat av en seo-mcp-crawl).
  const longSuffix = " – alla objekt & auktioner samlade | Allarop";
  const shortSuffix = " – nätauktioner samlade | Allarop";
  const title = `${name}${(name + longSuffix).length > 60 ? shortSuffix : longSuffix}`;
  const desc = `Alla aktiva objekt från ${name} samlade på ett ställe. Sök och jämför ${name}s nätauktioner mot övriga svenska auktionssajter – med totalpriset inklusive avgifter. Helt gratis.`;
  const crumbs = [
    { name: "Allarop", url: `${SITE}/` },
    { name: "Auktionshus", url: `${SITE}/auktioner/${house}` },
    { name },
  ];
  const intro = `Alla aktiva auktioner från <strong>${esc(name)}</strong>, samlade med objekt från resten av Sveriges nätauktioner. Jämför ${esc(name)} mot andra auktionshus och se det verkliga totalpriset inklusive avgifter.`;
  const { byHouse } = guideLinksIndex();
  const body = gridOrEmpty(rows, `Inga aktiva objekt från ${name} just nu.`) + relatedChips("") + guidesModule(byHouse.get(house) ?? []);
  return layout({
    title, desc, canonical, h1: `${name} – nätauktioner`, intro, crumbs, bodyHtml: body,
    jsonld: [
      { "@type": "CollectionPage", "@id": canonical, url: canonical, name: `${name} – nätauktioner`, isPartOf: { "@id": `${SITE}/#website` } },
      breadcrumb(crumbs.map((c) => ({ name: c.name, url: c.url }))),
      itemListSchema(`${canonical}#items`, `Objekt från ${name}`, rows),
    ],
  });
}

async function renderCity(city: string): Promise<string> {
  const rows = await listActive({ location: city, limit: 60, sort: "ending" });
  const slug = slugify(city);
  const canonical = `${SITE}/plats/${slug}`;
  const title = `Nätauktioner i ${city} – lokala auktioner & fynd | Allarop`;
  const desc = `Nätauktioner och auktionsobjekt i ${city} samlade på ett ställe. Hitta lokala fynd du kan hämta själv och slippa frakt – från alla Sveriges auktionssajter. Helt gratis.`;
  const crumbs = [
    { name: "Allarop", url: `${SITE}/` },
    { name: "Orter", url: `${SITE}/plats/${slug}` },
    { name: city },
  ];
  const intro = `Auktionsobjekt i <strong>${esc(city)}</strong> från alla Sveriges nätauktioner. Perfekt för att hitta lokala fynd du kan hämta själv – jämför objekt över alla auktionssajter på ett ställe.`;
  const body = gridOrEmpty(rows, `Inga aktiva objekt i ${city} just nu.`) + relatedChips("");
  return layout({
    title, desc, canonical, h1: `Nätauktioner i ${city}`, intro, crumbs, bodyHtml: body,
    jsonld: [
      { "@type": "CollectionPage", "@id": canonical, url: canonical, name: `Nätauktioner i ${city}`, isPartOf: { "@id": `${SITE}/#website` } },
      breadcrumb(crumbs.map((c) => ({ name: c.name, url: c.url }))),
      itemListSchema(`${canonical}#items`, `Auktionsobjekt i ${city}`, rows),
    ],
  });
}

// Flagg­skeppsguiden /guide/vad-ar-natauktioner (C2 i auditen): längre artikel med
// snabbsvar, 5-7 H2-sektioner, FAQ (synlig + FAQPage-schema) och källhänvisningar.
// Innehållet är generellt om nätauktioner - inga fabricerade siffror.
const GUIDE_VAD_AR_UPDATED = "2026-07-30";
const GUIDE_VAD_AR_UPDATED_HUMAN = "30 juli 2026";
const GUIDE_VAD_AR_FAQ: { q: string; a: string }[] = [
  { q: "Kan man ångra ett bud på nätauktion?",
    a: "I princip nej – ett lagt bud är bindande hos de flesta svenska auktionshus. Ångerrätten i distansavtalslagen gäller normalt inte för försäljning som sker genom auktion. Läs alltid auktionshusets villkor och undersök objektet innan du budar." },
  { q: "Kostar det något att lägga bud?",
    a: "Nej, att registrera sig och lägga bud är gratis hos de stora svenska nätauktionerna. Du betalar först om du vinner – då tillkommer slagavgift och i många fall moms utöver det vinnande budet." },
  { q: "Vad är en slagavgift?",
    a: "Slagavgiften (auktionsprovisionen) är avgiften auktionshuset tar utöver det vinnande budet, vanligtvis en procent av budet eller ett fast belopp. Den redovisas på objektsidan, och Allarop visar totalpriset inklusive avgiften så att du kan jämföra rättvist." },
  { q: "Hur vet jag vad jag köper?",
    a: "Objekt på nätauktion säljs i befintligt skick och som köpare har du undersökningsplikt. Läs beskrivningen noggrant, titta på alla bilder och utnyttja provvisningen när den erbjuds. Fel som framgått av beskrivningen kan du normalt inte reklamera efteråt." },
  { q: "Vem äger auktionerna som visas på Allarop?",
    a: "Ingen av dem – Allarop är en aggregator och mellanhand. Vi samlar objekt från 29 svenska auktionssajter i ett sökindex, men all budgivning, betalning och hämtning sker hos respektive auktionshus." },
];

function renderGuide(): string {
  const canonical = `${SITE}/guide/vad-ar-natauktioner`;
  const title = "Vad är en nätauktion? Så fungerar svenska nätauktioner | Allarop";
  const desc = "Guide till nätauktioner i Sverige: så fungerar budgivning, avgifter och totalpris, konkurs- och kronofogdeauktioner – och hur du hittar alla nätauktioner på ett ställe.";
  const crumbs = [
    { name: "Allarop", url: `${SITE}/` },
    { name: "Guide", url: canonical },
    { name: "Vad är en nätauktion?" },
  ];
  const faqHtml = GUIDE_VAD_AR_FAQ.map((f) =>
    `<details class="seo-faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("");
  const body = `<div class="prose">
<p class="snabbsvar">En nätauktion är en auktion som sker helt på nätet: auktionshuset lägger upp objekt med bilder och beskrivning, du lägger bud digitalt fram till en sluttid, och det högsta budet när tiden går ut vinner. Utöver budet tillkommer oftast slagavgift och ibland moms – räkna därför alltid på totalpriset, inte bara budet.</p>
<div class="byline">Allarop · Uppdaterad ${GUIDE_VAD_AR_UPDATED_HUMAN}</div>
<p>En <strong>nätauktion</strong> fungerar i grunden som en traditionell auktion, men hela förloppet sker digitalt. Auktionshuset fotograferar och beskriver objekten, lägger ut dem med en sluttid, och budgivarna lägger sina bud via webben eller en app. När tiden går ut vinner det högsta budet som nått eventuellt reservationspris. Modellen används i Sverige för allt från konst och designklassiker till <strong>maskiner, fordon, konkurslager och kronofogdens utmätta gods</strong>.</p>
<h2>Så fungerar en nätauktion – steg för steg</h2>
<p>Förloppet ser ungefär likadant ut hos alla större svenska nätauktioner. Först registrerar du ett konto hos auktionshuset och legitimerar dig, ofta med BankID. Sedan kan du lägga bud direkt eller lägga ett maxbud som systemet budar upp automatiskt åt dig. Många hus förlänger dessutom sluttiden några minuter om ett bud kommer in precis i slutet, så att budgivningen inte ska avgöras av vem som är snabbast på knappen. Vinner du får du en bekräftelse med betalningsinformation, och därefter hämtar eller fraktar du objektet enligt husets villkor.</p>
<h2>Bud, utropspris och reservationspris</h2>
<p>Varje objekt har ett <strong>utropspris</strong> – den nivå budgivningen startar på – och ibland ett <strong>reservationspris</strong>, en dold miniminivå som säljaren accepterar. Det betyder att det högsta budet inte alltid vinner: nås inte reservationspriset behåller säljaren objektet. Vissa auktioner har i stället ett öppet reservationspris, eller inget alls. Läs alltid objektets villkor innan du budar så att du vet vad som gäller.</p>
<h2>Avgifter och totalpris – räkna på det verkliga priset</h2>
<p>Det vinnande budet är sällan det du faktiskt betalar. Utöver budet tillkommer normalt en <strong>slagavgift</strong> (auktionsprovision) och i många fall moms på både bud och avgift, beroende på hur objektet säljs. Det verkliga priset kan därför bli märkbart högre än budet. Företagsobjekt säljs dessutom ofta exklusive moms, vilket spelar roll om du jämför mot privatmarknaden. Allarop visar därför <strong>totalpriset inklusive avgifter</strong> – inte bara budet – så att du kan jämföra objekt rättvist mellan olika auktionssajter.</p>
<h2>Konkurs- och kronofogdeauktioner</h2>
<p>En stor del av det svenska nätauktionsutbudet kommer från <strong>konkursförvaltare och Kronofogden</strong>. Vid konkurser och utmätningar säljs tillgångar exekutivt via nätauktion – maskiner, fordon, inventarier, verktyg och hela lager. Eftersom säljaren inte kan vänta på bästa möjliga köpare finns här ofta de riktiga fynden, men också de tuffaste villkoren: objekten säljs strikt i befintligt skick och upphämtning sker inom kort tidsfrist. På Allarop kan du filtrera fram just <a href="/kategori/entreprenad">konkurs- och maskinauktioner</a> och se allt som slutar snart.</p>
<h2>Undersökningsplikt och provvisning</h2>
<p>Objekt på nätauktion säljs i befintligt skick, och som köpare har du en långtgående <strong>undersökningsplikt</strong>. Det innebär att fel du kunnat upptäcka – i bilder, beskrivning eller vid visning – normalt inte kan reklameras i efterhand. Använd därför alltid provvisningen när den erbjuds, ställ frågor till auktionshuset och läs skickbeskrivningen i detalj. Det är den enskilt viktigaste rutinen för att buda tryggt.</p>
<h2>Alla nätauktioner på ett ställe</h2>
<p>Utbudet är splittrat: varje auktionshus har sin egen sajt, sitt eget kontosystem och sina egna villkor. I stället för att bevaka tjugotalet auktionsajter var för sig samlar Allarop alla Sveriges nätauktioner i ett sökfält. Du söker, följer och jämför objekt från Klaravik, Auctionet, PS Auction, Blinto, Tradera och många fler – med totalpris inklusive avgifter – helt gratis. Budgivningen sker alltid hos respektive auktionshus.</p>
<p>Vill du gå djupare? Se <a href="/guide">alla Allarops guider</a> om budgivning, avgifter, konkursauktioner och köpråd.</p>
<h2>Vanliga frågor</h2>
${faqHtml}
<h2>Källor</h2>
<ul>
<li><a href="https://www.konsumentverket.se/" target="_blank" rel="noopener">Konsumentverket</a> – konsumenträtt vid köp och auktion, ångerrätt och reklamation</li>
<li><a href="https://www.kronofogden.se/" target="_blank" rel="noopener">Kronofogden</a> – hur utmätt egendom säljs exekutivt</li>
<li><a href="https://www.tradera.com/" target="_blank" rel="noopener">Tradera</a> – villkor för Sveriges största konsumentauktion</li>
<li><a href="https://www.klaravik.se/" target="_blank" rel="noopener">Klaravik</a> – villkor för maskin- och konkursauktioner</li>
</ul>
</div>` + relatedChips("");
  return layout({
    title, desc, canonical, h1: "Vad är en nätauktion?",
    intro: "Allt du behöver veta om svenska nätauktioner – budgivning, avgifter, totalpris och var du hittar dem alla samlade.",
    crumbs, bodyHtml: body,
    jsonld: [
      {
        "@type": "Article", headline: "Vad är en nätauktion? Så fungerar svenska nätauktioner",
        description: desc, inLanguage: "sv-SE",
        author: { "@type": "Organization", name: "Allarop", url: SITE },
        publisher: { "@id": `${SITE}/#org` },
        datePublished: GUIDE_PUBLISHED, dateModified: GUIDE_VAD_AR_UPDATED,
        image: `${SITE}/og-image.png`, mainEntityOfPage: canonical,
      },
      breadcrumb(crumbs.map((c) => ({ name: c.name, url: c.url }))),
      { ...faqLdEntity(GUIDE_VAD_AR_FAQ)!, "@id": `${canonical}#faq` },
    ],
  });
}

// ── 56 guider (markdown-artiklar) ─────────────────────────────────────────────
// Källa: services/allarop/app-src/guider/*.md i digitalbyra, kopieras in i app-källan av
// setup-allarop.sh (samma mönster som seo-pages.ts själv). Varje fil har YAML-liknande
// frontmatter (SEO-titel/Meta description/URL/Internlänkar) + markdown-brödtext med ett
// "Snabbt svar"-citat och en "## Vanliga frågor"-sektion som blir FAQPage-schema.
const GUIDER_DIR = join(dirname(fileURLToPath(import.meta.url)), "../guider");
/** Fallback-publiceringsdatum för guider utan egna datumfält i frontmatter ("Uppdaterad:"/
 * "Publicerad:" vinner om de finns). Uppdatera när guider utan eget datum redigeras i sak. */
const GUIDE_PUBLISHED = "2026-07-29";
/** "2026-07-30" → "30 juli 2026" (svenskt format, utan Date-parsning/tidszonsfallgropar). */
const SV_MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
function dateHuman(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${Number(m[3])} ${SV_MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

interface Guide {
  slug: string; seoTitle: string; metaDesc: string; internalLinks: string[];
  h1: string; snabbsvar: string; bodyHtml: string; faq: { q: string; a: string }[];
  readMinutes: number; heroImage: string | null;
  /** Frontmatter "Uppdaterad:"/"Publicerad:" (YYYY-MM-DD) om de finns, annars null. */
  updated: string | null; published: string | null;
}
/** Kluster/kategori-etikett per guide, ur guideplanens egen indelning (00-guideplan-och-
 * strategi.md) - inte gissat. Guider utan träff (borde inte förekomma) får "Guide". */
const GUIDE_CLUSTER: Record<string, string> = {
  "hur-fungerar-budgivning-pa-natauktion": "Grunder", "kan-man-angra-bud-pa-natauktion": "Grunder",
  "avgifter-natauktion-totalpris": "Grunder", "reservationspris-vad-betyder-det": "Grunder",
  "provvisning-undersokningsplikt": "Grunder", "moms-pa-natauktion": "Grunder",
  "vanliga-misstag-natauktion": "Grunder",
  "kopa-bil-pa-natauktion-guide": "Fordon", "kopa-bil-kronofogden": "Fordon",
  "kopa-gravmaskin-pa-auktion": "Fordon", "kopa-traktor-pa-natauktion": "Fordon",
  "kopa-bat-pa-auktion": "Fordon",
  "konkursauktioner-guide": "Konkurs & exekutivt", "kronofogdens-auktioner-guide": "Konkurs & exekutivt",
  "kopa-pa-konkursauktion-risker": "Konkurs & exekutivt",
  "basta-natauktionerna-sverige": "Jämförelser", "klaravik-vs-ps-auction": "Jämförelser",
  "natauktion-vs-blocket": "Jämförelser", "kvd-vs-klaravik": "Jämförelser",
  "bukowskis-vs-auctionet": "Jämförelser", "pantbanken-vs-bukowskis": "Jämförelser",
  "salja-pa-natauktion-foretag": "Sälja", "vad-kostar-det-att-salja-pa-auktion": "Sälja",
  "sa-fungerar-klaravik": "Auktionshus", "sa-fungerar-kvd": "Auktionshus",
  "sa-fungerar-tradera-auktion": "Auktionshus", "sa-fungerar-auctionet": "Auktionshus",
  "sa-fungerar-pantbanken-auktion": "Auktionshus", "sa-fungerar-retrade": "Auktionshus",
  "sa-fungerar-ps-auction": "Auktionshus", "sa-fungerar-bukowskis": "Auktionshus",
  "sa-fungerar-bilweb-auctions": "Auktionshus", "sa-fungerar-netauktion": "Auktionshus",
  "sa-fungerar-budi": "Auktionshus", "sa-fungerar-fabeo": "Auktionshus",
  "sa-fungerar-tovek": "Auktionshus", "sa-fungerar-blinto": "Auktionshus",
  "sa-fungerar-metropol": "Auktionshus", "sa-fungerar-siko-auktioner": "Auktionshus",
  "sa-fungerar-vaxxa": "Auktionshus", "sa-fungerar-auktiona": "Auktionshus",
  "kopa-mobler-pa-auktion": "Kategorier", "kopa-klockor-pa-auktion": "Kategorier",
  "kopa-konst-pa-auktion": "Kategorier", "kopa-elektronik-pa-auktion": "Kategorier",
  "kopa-hastutrustning-pa-auktion": "Kategorier",
  "rolex-priser-tradera-2026": "Priser & trender", "pokemonkort-priser-2026": "Priser & trender",
  "vad-ar-iphone-vard-tradera-2026": "Priser & trender", "veteranmopeder-priser-2026": "Priser & trender",
  "begagnade-datorer-priser-2026": "Priser & trender", "maskinmarknaden-2024-2026": "Priser & trender",
  "saljer-du-for-billigt-prisstatistik": "Priser & trender", "trender-natauktion-2026": "Priser & trender",
  "prognos-pokemonkort-hosten-2026": "Priser & trender", "klockmarknaden-trend-prognos-2026": "Priser & trender",
  "vad-ar-natauktioner": "Grunder",
};
const guideCluster = (slug: string): string => GUIDE_CLUSTER[slug] ?? "Guide";

// ── Guide-rendering helpers ──────────────────────────────────────────────────
/** Ensures every <img> has an alt attribute. Falls back to the guide title for
 * prose images where the markdown author left alt empty. */
function ensureImgAlt(html: string, fallback: string): string {
  return html.replace(/<img\b([^>]*)>/gi, (m, attrs: string) => {
    if (/\salt\s*=/i.test(attrs)) return m;
    return `<img${attrs} alt="${esc(fallback)}" />`;
  });
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function headingId(text: string): string {
  return slugify(stripTags(text)).replace(/-+/g, "-").replace(/^-|-$/g, "") || "section";
}

/** Builds a sticky Table of Contents from <h2> headings and injects stable ids. */
function buildToc(bodyHtml: string): { toc: string; body: string } {
  const headings: { id: string; text: string }[] = [];
  let dupIndex = 0;
  const body = bodyHtml.replace(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi, (m, attrs: string, content: string) => {
    const text = stripTags(content);
    const existingId = attrs.match(/\bid=["']?([^"'>]+)["']?/i)?.[1];
    let id = existingId || headingId(text);
    if (!existingId) {
      const base = id;
      while (headings.some((h) => h.id === id)) id = `${base}-${++dupIndex}`;
    }
    headings.push({ id, text });
    const newAttrs = existingId ? attrs : `${attrs} id="${id}"`.trim();
    return `<h2 ${newAttrs}>${content}</h2>`;
  });
  if (!headings.length) return { toc: "", body };
  // Använd en esc-variant som inte omvandlar citattecken till &quot; (TOC-länkarna
  // ska visa riktiga citat, inte HTML-entiteter). stripTags har redan dekodat dem.
  const links = headings.map((h) => `<a href="#${h.id}">${esc(h.text).replace(/&quot;/g, '"')}</a>`).join("");
  return { toc: `<nav class="toc" aria-label="Innehållsförteckning"><strong>Innehåll</strong>${links}</nav>`, body };
}

function guideCard(g: Guide): string {
  const cluster = guideCluster(g.slug);
  const href = `/guide/${g.slug}`;
  return `<article class="guide-card">
<a href="${href}" aria-label="${esc(g.h1)}">
<div class="guide-card-body">
<div class="eyebrow">${esc(cluster)}</div>
<h3>${esc(g.h1)}</h3>
<p>${esc(g.metaDesc)}</p>
<div class="guide-meta">${g.readMinutes} min läsning</div>
</div>
</a>
</article>`;
}

function relatedGuideCard(path: string, guides: Map<string, Guide>): string {
  if (!path.startsWith("/guide/")) return "";
  const g = guides.get(path.slice(7));
  return g ? guideCard(g) : "";
}

function shareLinks(canonical: string, title: string): string {
  const url = encodeURIComponent(canonical);
  const text = encodeURIComponent(title);
  return `<div class="share">
<strong>Dela guiden</strong>
<a class="share-tw" href="https://twitter.com/intent/tweet?url=${url}&text=${text}" target="_blank" rel="noopener">Twitter / X</a>
<a class="share-fb" href="https://www.facebook.com/sharer/sharer.php?u=${url}" target="_blank" rel="noopener">Facebook</a>
<a class="share-li" href="https://www.linkedin.com/sharing/share-offsite/?url=${url}" target="_blank" rel="noopener">LinkedIn</a>
<a class="share-email" href="mailto:?subject=${text}&body=${url}">E-post</a>
</div>`;
}

function parseFrontMatter(raw: string): { fm: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv) fm[kv[1]!.trim()] = kv[2]!.trim();
  }
  return { fm, body: m[2]! };
}
/** Klipper ut "## <heading>"-sektionen (till nästa "## " eller filslutet) ur body. */
function extractSection(body: string, heading: string): { section: string; rest: string } {
  // Två separata sökningar (start, sen nästa "## ") istället för en regex med $-lookahead:
  // med "m"-flaggan (för att ^ ska hitta rubriken var som helst) matchar $ slutet av VARJE
  // rad, inte hela strängen - en lat [\s\S]*? stannar då redan vid första radbrytningen.
  const startM = body.match(new RegExp(`^## ${heading}\\s*\\r?\\n`, "m"));
  if (!startM || startM.index == null) return { section: "", rest: body };
  const contentStart = startM.index + startM[0].length;
  const nextHeading = body.slice(contentStart).match(/\r?\n## /);
  const contentEnd = nextHeading && nextHeading.index != null ? contentStart + nextHeading.index : body.length;
  return {
    section: body.slice(contentStart, contentEnd).trim(),
    rest: body.slice(0, startM.index) + body.slice(contentEnd),
  };
}
/** "**Fråga?**\nSvar." upprepat → [{q,a}]. Matchar exakt skrivregeln i guideplanen. */
function parseFaq(section: string): { q: string; a: string }[] {
  const out: { q: string; a: string }[] = [];
  const re = /\*\*(.+?)\*\*\s*\r?\n([\s\S]+?)(?=\r?\n\*\*|\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section))) out.push({ q: m[1]!.trim(), a: m[2]!.trim().replace(/\s+/g, " ") });
  return out;
}

let GUIDES_CACHE: Map<string, Guide> | null = null;
/** Läser + parsar alla guide-.md-filer en gång, cachar i minnet (filerna ändras aldrig
 * under körning - appen startas om vid varje deploy). */
function loadGuides(): Map<string, Guide> {
  if (GUIDES_CACHE) return GUIDES_CACHE;
  const map = new Map<string, Guide>();
  let files: string[] = [];
  try { files = readdirSync(GUIDER_DIR); } catch { /* guider/ saknas lokalt - inget att göra */ }
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const raw = readFileSync(join(GUIDER_DIR, file), "utf-8");
    const { fm, body } = parseFrontMatter(raw);
    const slug = (fm["URL"] || "").replace(/^\/guide\//, "");
    if (!slug) continue;
    // trimStart mellan varje steg - frontmatter-stängningen/rubrikerna följs alltid av en
    // tom rad i källfilerna, och ^ (utan "m"-flagga) matchar bara position 0 i strängen.
    let rest = body.replace(/^\s+/, "");
    const h1Match = rest.match(/^#\s+(.+?)\r?\n/);
    const h1 = h1Match ? h1Match[1]!.trim() : (fm["SEO-titel"] || slug);
    if (h1Match && h1Match.index != null) rest = rest.slice(h1Match.index + h1Match[0].length).replace(/^\s+/, "");
    const svMatch = rest.match(/^>\s*\*\*Snabbt svar:\*\*\s*(.+?)\r?\n/);
    const snabbsvar = svMatch ? svMatch[1]!.trim() : "";
    if (svMatch && svMatch.index != null) rest = rest.slice(svMatch.index + svMatch[0].length).replace(/^\s+/, "");
    const { section: faqSection, rest: withoutFaq } = extractSection(rest, "Vanliga frågor");
    const faq = parseFaq(faqSection);
    // marked esc:ar citat till &quot; i text; håll dem som riktiga citattecken i brödtexten.
    const bodyHtml = (marked.parse(withoutFaq, { async: false }) as string)
      .replace(/&quot;/g, '"');
    // ~200 ord/minut, minst 1 min. Räknas på hela filens ord (snabbsvar+brödtext+FAQ) -
    // grovt men rätt storleksordning, ingen anledning att räkna exaktare.
    const readMinutes = Math.max(1, Math.round(raw.split(/\s+/).length / 200));
    // Valfritt "Bild: <fil>" i frontmatter - filen ska ligga i services/allarop/web-assets/
    // guider/ (digitalbyra) och nås på /guide-images/<fil>. Ingen bild = ingen hero, precis
    // som idag. Standard markdown-bilder (![alt](url)) fungerar redan i brödtexten via marked.
    const heroImage = fm["Bild"] ? `/guide-images/${fm["Bild"].trim()}` : null;
    // Valfria datumfält "Uppdaterad:"/"Publicerad:" (YYYY-MM-DD) i frontmatter - saknas de
    // faller renderGuidePage tillbaka på GUIDE_PUBLISHED. Validera minimalt så ett feltalet
    // värde inte läcker rakt ut i JSON-LD.
    const isoDate = (v: string | undefined): string | null =>
      v && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
    map.set(slug, {
      slug, seoTitle: fm["SEO-titel"] || h1, metaDesc: fm["Meta description"] || "",
      internalLinks: (fm["Internlänkar"] || "").split(",").map((s) => s.trim()).filter(Boolean),
      h1, snabbsvar, bodyHtml, faq, readMinutes, heroImage,
      updated: isoDate(fm["Uppdaterad"]), published: isoDate(fm["Publicerad"]),
    });
  }
  GUIDES_CACHE = map;
  return map;
}

/** Path → läsbar länktext för "Läs också"/kategori-/hus-moduler. */
function labelForPath(path: string, guides: Map<string, Guide>): string {
  if (path === "/guide/vad-ar-natauktioner") return "Vad är en nätauktion?";
  if (path.startsWith("/guide/")) return guides.get(path.slice(7))?.h1 ?? path;
  if (path.startsWith("/kategori/")) return CAT_BY_KEY.get(path.slice(10))?.label ?? path;
  if (path.startsWith("/auktioner/")) return houseName(path.slice(11));
  return path;
}

let GUIDE_LINKS_BY_CAT: Map<string, Guide[]> | null = null;
let GUIDE_LINKS_BY_HOUSE: Map<string, Guide[]> | null = null;
/** Omvänt index (kategori/auktionshus → vilka guider länkar dit), härlett ur guidernas
 * egna Internlänkar-fält - ingen separat mappning att hålla i synk. */
function guideLinksIndex(): { byCat: Map<string, Guide[]>; byHouse: Map<string, Guide[]> } {
  if (GUIDE_LINKS_BY_CAT && GUIDE_LINKS_BY_HOUSE) return { byCat: GUIDE_LINKS_BY_CAT, byHouse: GUIDE_LINKS_BY_HOUSE };
  const byCat = new Map<string, Guide[]>();
  const byHouse = new Map<string, Guide[]>();
  for (const g of loadGuides().values()) {
    for (const link of g.internalLinks) {
      let key: string | null = null;
      let m: Map<string, Guide[]> | null = null;
      if (link.startsWith("/kategori/")) { key = link.slice(10); m = byCat; }
      else if (link.startsWith("/auktioner/")) { key = link.slice(11); m = byHouse; }
      if (key && m) { if (!m.has(key)) m.set(key, []); m.get(key)!.push(g); }
    }
  }
  GUIDE_LINKS_BY_CAT = byCat; GUIDE_LINKS_BY_HOUSE = byHouse;
  return { byCat, byHouse };
}
function guidesModule(guides: Guide[]): string {
  if (!guides.length) return "";
  const uniq = [...new Map(guides.map((g) => [g.slug, g])).values()];
  return `<h2>Guider &amp; priser</h2><div class="chips">${uniq.map((g) =>
    `<a class="chip" href="/guide/${g.slug}">${esc(g.h1)}</a>`).join("")}</div>`;
}

function faqLdEntity(faq: { q: string; a: string }[]): object | null {
  if (!faq.length) return null;
  return { "@type": "FAQPage", mainEntity: faq.map((f) => ({
    "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a },
  })) };
}

function renderGuidePage(slug: string): string | null {
  const guides = loadGuides();
  const g = guides.get(slug);
  if (!g) return null;
  const canonical = `${SITE}/guide/${slug}`;
  // Per-guide-datum ur frontmatter ("Uppdaterad:"/"Publicerad:"), annars paketets
  // publiceringsdatum. Samma datum återanvänds i byline, infobox, Article och Dataset.
  const updatedIso = g.updated ?? GUIDE_PUBLISHED;
  const publishedIso = g.published ?? GUIDE_PUBLISHED;
  const crumbs = [{ name: "Allarop", url: `${SITE}/` }, { name: "Guider", url: `${SITE}/guide` }, { name: g.h1 }];
  const faqHtml = g.faq.length
    ? `<h2>Vanliga frågor</h2>${g.faq.map((f) =>
        `<details class="seo-faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("")}`
    : "";
  const mainContent = `${g.bodyHtml}\n${faqHtml}`;
  const { toc, body: tocBody } = buildToc(mainContent);
  const chartedBody = renderChartsInHtml(tocBody);
  const accessibleBody = ensureImgAlt(chartedBody, g.h1);
  // Hero-bilden används endast för og:image/schema – visas inte på sidan själv.
  const hero = "";
  const infoBox = `<aside class="info-box" aria-label="Metadata">
<div><strong>Publicerad</strong> ${dateHuman(publishedIso)}</div>
<div><strong>Uppdaterad</strong> ${dateHuman(updatedIso)}</div>
<div><strong>Lästid</strong> ${g.readMinutes} min</div>
<p>Allarop är en samlingsplattform för Sveriges nätauktioner. Vi äger inga auktioner själva – all budgivning sker hos respektive auktionshus.</p>
</aside>`;
  const relatedGuides = g.internalLinks.filter((p) => p.startsWith("/guide/"));
  const relatedOther = g.internalLinks.filter((p) => !p.startsWith("/guide/"));
  const relatedCards = relatedGuides.map((p) => relatedGuideCard(p, guides)).filter(Boolean).join("");
  const relatedChipsOther = relatedOther.map((p) =>
    `<a class="chip" href="${esc(p)}">${esc(labelForPath(p, guides))}</a>`).join("");
  const relatedHtml = (relatedCards || relatedChipsOther)
    ? `<section class="related-guides"><h2>Läs också</h2>${relatedCards ? `<div class="guide-grid small">${relatedCards}</div>` : ""}${relatedChipsOther ? `<div class="chips">${relatedChipsOther}</div>` : ""}</section>`
    : "";
  const body = `<div class="article-layout">
${toc}
<article class="article-main">
<div class="byline">Allarop · ${g.readMinutes} min läsning · Uppdaterad ${dateHuman(updatedIso)}</div>
${hero}
<div class="prose">
${g.snabbsvar ? `<p class="snabbsvar">${esc(g.snabbsvar)}</p>` : ""}
${accessibleBody}
</div>
${infoBox}
${shareLinks(canonical, g.seoTitle)}
${relatedHtml}
</article>
</div>`;
  const jsonld: object[] = [
    {
      "@type": "Article", headline: g.h1, description: g.metaDesc || g.h1,
      image: g.heroImage ? `${SITE}${g.heroImage}` : `${SITE}/og-image.png`, inLanguage: "sv-SE",
      author: { "@type": "Organization", name: "Allarop", url: SITE },
      publisher: { "@id": `${SITE}/#org` },
      datePublished: publishedIso, dateModified: updatedIso,
      mainEntityOfPage: canonical,
    },
    breadcrumb(crumbs.map((c) => ({ name: c.name, url: c.url }))),
  ];
  const faqLd = faqLdEntity(g.faq);
  if (faqLd) jsonld.push({ ...faqLd, "@id": `${canonical}#faq` });
  // E3 (audit 2026-07-29): pris-/trendguiderna är i praktiken små dataset. Märk dem som
  // Dataset så att AI/sök kan citera dem som datakälla - ingen statistik fabriceras, noden
  // pekar bara på artikeln med sin egen metadata.
  if (guideCluster(slug) === "Priser & trender") {
    jsonld.push({
      "@type": "Dataset", "@id": `${canonical}#dataset`,
      name: g.h1, description: g.metaDesc || g.h1, url: canonical,
      creator: { "@id": `${SITE}/#org` },
      dateModified: updatedIso, inLanguage: "sv-SE",
      spatialCoverage: { "@type": "Place", name: "Sverige" },
    });
  }
  return layout({
    title: `${g.seoTitle} | Allarop`, desc: g.metaDesc || g.h1, canonical, h1: g.h1,
    intro: esc(g.metaDesc || g.h1), crumbs, bodyHtml: body, jsonld,
    eyebrow: guideCluster(slug), image: g.heroImage ? `${SITE}${g.heroImage}` : undefined,
  });
}

/** Samma ordning som klustren i guideplanen - flat lista blir därmed grupperad "på känn"
 * utan att behöva sektionsrubriker (varje kort har redan sin egen kicker). */
const CLUSTER_ORDER = ["Grunder", "Fordon", "Konkurs & exekutivt", "Jämförelser", "Sälja", "Auktionshus", "Kategorier", "Priser & trender", "Guide"];

const FEATURED_GUIDE_SLUGS = ["vad-ar-natauktioner", "basta-natauktionerna-sverige", "avgifter-natauktion-totalpris", "kopa-bil-pa-natauktion-guide"];

function renderGuideIndex(): string {
  const all = [...loadGuides().values()].sort((a, b) => {
    const ca = CLUSTER_ORDER.indexOf(guideCluster(a.slug)), cb = CLUSTER_ORDER.indexOf(guideCluster(b.slug));
    return ca !== cb ? ca - cb : a.h1.localeCompare(b.h1, "sv");
  });
  const featured = FEATURED_GUIDE_SLUGS.map((s) => loadGuides().get(s)).filter((g): g is Guide => Boolean(g));
  const rest = all.filter((g) => !FEATURED_GUIDE_SLUGS.includes(g.slug));
  const clusters = CLUSTER_ORDER.filter((c) => c !== "Guide" && all.some((g) => guideCluster(g.slug) === c));
  const canonical = `${SITE}/guide`;
  const crumbs = [{ name: "Allarop", url: `${SITE}/` }, { name: "Guider" }];
  const filterChips = clusters.map((c) =>
    `<a class="chip" href="#${esc(slugify(c))}" data-cluster="${esc(c)}">${esc(c)}</a>`).join("");
  const clusterSections = clusters.map((c) => {
    const guidesInCluster = rest.filter((g) => guideCluster(g.slug) === c);
    if (!guidesInCluster.length) return "";
    return `<section class="cluster-section" id="${esc(slugify(c))}"><h2>${esc(c)}</h2><div class="guide-grid">${guidesInCluster.map(guideCard).join("")}</div></section>`;
  }).join("");
  const body = `
<section class="guide-hero">
<div class="filter-bar"><span>Hoppa till ämne:</span><div class="chips">${filterChips}</div></div>
</section>
${featured.length ? `<section class="featured-guides"><h2>Utvalda guider</h2><div class="guide-grid featured">${featured.map(guideCard).join("")}</div></section>` : ""}
<div class="cluster-list">${clusterSections}</div>`;
  return layout({
    title: "Guider om nätauktioner | Allarop",
    desc: "Allarops guider om nätauktioner: budgivning, avgifter, konkursauktioner, jämförelser och köpråd - skrivna mot svenska auktionssajters egna villkor.",
    canonical, h1: "Guider om nätauktioner",
    intro: `${all.length} guider om hur nätauktioner fungerar, vad de kostar och hur du köper smart. Hoppa till ett ämne eller läs våra utvalda guider.`,
    crumbs, bodyHtml: body,
    jsonld: [
      { "@type": "CollectionPage", "@id": canonical, url: canonical, name: "Guider om nätauktioner", isPartOf: { "@id": `${SITE}/#website` } },
      breadcrumb(crumbs.map((c) => ({ name: c.name, url: c.url }))),
      { "@type": "ItemList", numberOfItems: all.length, itemListElement: all.map((g, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/guide/${g.slug}`, name: g.h1 })) },
    ],
  });
}

// ── Objektsida (Product/Offer) ───────────────────────────────────────────────
type ItemRow = {
  house: string; external_id: string; title: string | null; description: string | null;
  location: string | null; status: string | null; ends_at: Date | null;
  min_bid: string | null; current_bid: string | null; total_price: string | null;
  currency: string | null; source_url: string | null; category: string | null; seller: string | null;
};

/** Behåller enbart säkra taggar och rensar alla attribut (inget onclick/srcdoc etc). */
function sanitizeHtml(html: string): string {
  const allowed = new Set(["p", "br", "ul", "ol", "li", "strong", "b", "em", "i", "h2", "h3", "h4", "div", "span"]);
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<(\/?)([a-z0-9]+)[^>]*>/gi, (m, slash, tag) => {
      const t = tag.toLowerCase();
      if (!allowed.has(t)) return " ";
      return `<${slash}${t}>`;
    });
}

/** Renderar beskrivning: HTML saneras, annars bryts dubbla radbyten i styckeblock.
 * Strukturerad data (många radbyten) får en kompakt klass för bättre läsbarhet. */
function renderDescription(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/<[a-z][\s\S]*?>/i.test(trimmed)) {
    return `<div class="desc-body">${sanitizeHtml(trimmed)}</div>`;
  }
  const paragraphs = trimmed.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return "";
  const isStructured = paragraphs.length === 1 && (paragraphs[0]?.match(/\n/g)?.length ?? 0) > 8;
  const cls = isStructured ? "desc-body structured" : "desc-body";
  return `<div class="${cls}">${paragraphs.map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
}

const SPEC_LABELS = ["Märke", "Fabrikat", "Tillverkare", "Modell", "Årsmodell", "År", "Model year", "Km-ställning", "Drivmedel", "Växellåda", "Drivning", "Effekt", "Vikt", "Mått"];
const SPEC_LABEL_RE = new RegExp(`\\s*(?:${SPEC_LABELS.map((l) => l.replace(/\s/g, "\\s")).join("|")})\\s*[:=]`, "i");

function truncateAtNextLabel(value: string): string {
  const idx = value.search(SPEC_LABEL_RE);
  return idx > 0 ? value.slice(0, idx).trim() : value.trim();
}

/** Försöker plocka ut klassiska fordonsspecifikationer ur beskrivningen. */
function extractSpecs(desc: string): Record<string, string> {
  const text = stripHtmlKeepNewlines(desc);
  const specs: Record<string, string> = {};
  const patterns: [RegExp, string][] = [
    [/(?:Märke|Fabrikat|Tillverkare)\s*[:=]\s*([^\n]+)/i, "Märke"],
    [/Modell\s*[:=]\s*([^\n]+)/i, "Modell"],
    [/(?:Årsmodell|År|Model\s*year)\s*[:=]\s*(\d{4})/i, "År"],
    [/Km-ställning\s*[:=]\s*([^\n]+)/i, "Körsträcka"],
    [/Drivmedel\s*[:=]\s*([^\n]+)/i, "Drivmedel"],
    [/Växellåda\s*[:=]\s*([^\n]+)/i, "Växellåda"],
    [/Drivning\s*[:=]\s*([^\n]+)/i, "Drivning"],
    [/Effekt\s*[:=]\s*([^\n]+)/i, "Effekt"],
    [/Vikt\s*[:=]\s*([^\n]+)/i, "Vikt"],
    [/Mått\s*[:=]\s*([^\n]+)/i, "Mått"],
  ];
  for (const [re, label] of patterns) {
    const m = text.match(re);
    if (m?.[1]) specs[label] = truncateAtNextLabel(m[1]).replace(/\s+/g, " ").slice(0, 80);
  }
  return specs;
}

function detectCondition(raw: string, title: string | null): string {
  const text = `${raw} ${title ?? ""}`.toLowerCase();
  // Ordmangräns-matchning: "ny" får inte matcha "nycklar", "nya" inte "begynna" etc.
  const newRe = /\b(ny|nytt|nya|oanvänd|oanvänt|unused|new\s+condition)\b/i;
  if (newRe.test(text)) return "https://schema.org/NewCondition";
  return "https://schema.org/UsedCondition";
}

/** Som stripHtml men behåller radbrytningar (för specifikationsutvinning). */
function stripHtmlKeepNewlines(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function extractBrand(desc: string): string | undefined {
  const text = stripHtmlKeepNewlines(desc);
  const m = text.match(/(?:Märke|Fabrikat|Tillverkare)\s*[:=]\s*([^\n,]+)/i);
  if (m?.[1]) return m[1].trim().split(/\s+/)[0];
  return undefined;
}

/** CSS-radio-galleri: klicka på tumnagel för att byta huvudbild, helt utan JS. */
function renderGallery(images: string[], alt: string): string {
  if (!images.length) return "";
  const thumb = (src: string, idx: number) =>
    `<label for="ga${idx}" class="thumb"><img src="${esc(src)}" alt="${esc(alt)} bild ${idx + 1}" width="120" height="90" loading="lazy" decoding="async"></label>`;
  return `<figure class="gallery" aria-label="Bildgalleri">` +
    images.map((_, i) => `<input type="radio" name="ga" id="ga${i}" ${i === 0 ? "checked" : ""} aria-hidden="true">`).join("") +
    `<div class="gallery-stage">${images.map((src, i) =>
      `<label for="ga${i}" class="main-img"><img src="${esc(src)}" alt="${esc(alt)}" width="800" height="600" loading="${i === 0 ? "eager" : "lazy"}"${i === 0 ? ` fetchpriority="high"` : ""} decoding="async"></label>`).join("")}</div>` +
    (images.length > 1 ? `<div class="gallery-thumbs">${images.map((src, i) => thumb(src, i)).join("")}</div>` : "") +
    `</figure>`;
}

/** Kompakt navigeringsblock för objektsidan, i ett details-element. */
function itemRelatedChips(currentCat: string | null): string {
  const mainKey = currentCat?.split("/")[0];
  const currentMain = mainKey ? TAXONOMY.find((m) => m.key === mainKey) : undefined;
  const cats = TAXONOMY.map((m) =>
    `<a class="chip" href="/kategori/${m.key}">${m.icon} ${esc(m.label)}</a>`).join("");
  const houses = HOUSE_KEYS.slice(0, 5).map((h) =>
    `<a class="chip" href="/auktioner/${h}">${esc(houseName(h))}</a>`).join("");
  const currentSubChips = currentMain
    ? `<div class="chips" style="margin-bottom:10px">${currentMain.subs.slice(0, 4).map((s) =>
      `<a class="chip" href="/kategori/${currentMain.key}/${s.key}">${esc(s.label)}</a>`).join("")}</div>`
    : "";
  return `<details class="related-collapse"><summary>Bläddra vidare bland kategorier och auktionshus</summary>
${currentSubChips}<div class="chips">${cats}</div><div class="chips" style="margin-top:10px">${houses}</div></details>`;
}

async function renderItem(house: string, id: string): Promise<string | null> {
  const q = await pool.query<ItemRow>(
    `SELECT house, external_id, title, description, location, status, ends_at,
            min_bid, current_bid, total_price, currency, source_url, category, seller
     FROM items WHERE house=$1 AND external_id=$2 LIMIT 1`,
    [house, id],
  );
  const it = q.rows[0];
  if (!it) return null;
  const media = await pool.query<{ url: string }>(
    `SELECT url FROM media WHERE house=$1 AND owner_type='item' AND owner_external_id=$2 AND kind='image' ORDER BY sort LIMIT 8`,
    [house, id],
  );
  const images = media.rows.map((m) => m.url).filter(Boolean);
  const name = houseName(house);
  const ended = it.status === "ended" || (it.ends_at != null && new Date(it.ends_at) < new Date());
  const priceNum = num(it.total_price) ?? num(it.current_bid) ?? num(it.min_bid);
  const searchLike = { ...(it as unknown as SearchRow), image: images[0] ?? null } as SearchRow;
  const price = priceText(searchLike);
  const canonical = `${SITE}/objekt/${encodeURIComponent(house)}/${encodeURIComponent(id)}`;
  const catHit = it.category ? CAT_BY_KEY.get(it.category) ?? CAT_BY_KEY.get(it.category.split("/")[0] ?? it.category) : undefined;
  const categoryLabel = catHit?.label;
  // SEO-titel: håll under ~60 tecken så den inte trunkeras i SERP. Prioritera
  // objekttiteln; tappa " | Allarop" och trunkera objekttiteln vid behov.
  const itemTitle = it.title ?? "Auktionsobjekt";
  const titleSuffix = ` – ${name} | Allarop`;
  const title = itemTitle.length + titleSuffix.length <= 60
    ? `${itemTitle}${titleSuffix}`
    : itemTitle.length + 11 <= 60
      ? `${itemTitle} – ${name}`
      : `${itemTitle.slice(0, Math.max(20, 56 - name.length)).trimEnd()}…`;

  // Meta description: kort, lockande, under 160 tecken.
  const endsDate = it.ends_at && !ended
    ? new Date(it.ends_at).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })
    : "";
  const metaParts = [
    it.title,
    price,
    name,
    it.location,
    ended ? "avslutad" : endsDate ? `slutar ${endsDate}` : "",
  ].filter((s): s is string => Boolean(s));
  let metaDesc = metaParts.join(" · ");
  // Google visar ~120–160 tecken: fyll ut för korta beskrivningar med en nyttig
  // slutmening istället för att bara klippa. Kortaste giltiga beskrivningen är
  // annars ~110 tecken (audit 2026-07-29: "meta description too short").
  if (metaDesc.length < 130) {
    const filler = ended
      ? "Se slutpris inklusive avgifter – samlat från svenska nätauktioner på Allarop."
      : "Se totalpriset inklusive avgifter och lägg bud – gratis att söka på Allarop.";
    metaDesc = `${metaDesc} ${filler}`;
  }
  metaDesc = metaDesc.slice(0, 157);
  if (metaDesc.length < 50) {
    metaDesc = `${it.title ?? "Auktionsobjekt"} på nätauktion hos ${name}. Se pris inklusive avgifter och buda via Allarop.`.slice(0, 157);
  }

  const crumbs = [
    { name: "Allarop", url: `${SITE}/` },
    ...(catHit ? [{ name: catHit.mainLabel, url: `${SITE}/kategori/${catHit.main}` }] : []),
    { name: name, url: `${SITE}/auktioner/${house}` },
    { name: it.title ?? "Objekt" },
  ];

  const gallery = renderGallery(images, it.title ?? "Auktionsobjekt");
  const ctaHref = esc(it.source_url ?? `/auktioner/${house}`);
  const specs = extractSpecs(it.description ?? "");
  const specsBox = `<aside class="specs" aria-label="Snabbfakta">
<h2>Snabbfakta</h2>
${categoryLabel ? `<div class="spec-row"><span>Kategori</span><strong>${esc(categoryLabel)}</strong></div>` : ""}
<div class="spec-row"><span>Auktionshus</span><strong>${esc(name)}</strong></div>
${Object.entries(specs).map(([k, v]) => `<div class="spec-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join("")}
</aside>`;
  const priceCard = `<aside class="price-card" aria-label="Pris och status">
<div class="price-row">
  <span class="price-label">${ended ? "Avslutat pris" : "Aktuellt pris"}</span>
  <span class="price-amount">${esc(price)}</span>
</div>
<div class="status-row">
  <span class="status-badge ${ended ? "ended" : "active"}">${ended ? "Avslutad" : "Aktiv auktion"}</span>
  ${it.ends_at && !ended ? `<span class="ends-in">Slutar ${esc(endsText(it.ends_at))}</span>` : ""}
</div>
${it.location ? `<div class="info-row">📍 ${esc(it.location)}</div>` : ""}
${it.seller ? `<div class="info-row">Säljare: ${esc(it.seller)}</div>` : ""}
<a class="cta big" href="${ctaHref}" rel="nofollow noopener" target="_blank">Lägg bud hos ${esc(name)} →</a>
<p class="disclaimer">Budgivningen sker hos ${esc(name)}. Allarop är en aggregator och mellanhand.</p>
</aside>`;

  const descriptionHtml = renderDescription(it.description ?? "");

  // Liknande objekt (endast om vi har en kategori att utgå ifrån).
  let similarHtml = "";
  if (it.category) {
    const similar = await listActive({ category: it.category, limit: 12, sort: "ending" });
    const filtered = similar.filter((r) => !(r.house === house && r.external_id === id));
    if (filtered.length) {
      similarHtml = `<section class="similar"><h2>Liknande objekt</h2><div class="grid">${filtered.map((r, i) => card(r, i)).join("")}</div></section>`;
    }
  }

  const body = `<div class="item-layout">
<div class="item-media">
${gallery}
${descriptionHtml}
</div>
<div class="item-sidebar">
${priceCard}
${specsBox}
</div>
</div>
${similarHtml}
${itemRelatedChips(it.category ?? null)}`;

  const condition = detectCondition(it.description ?? "", it.title);
  const brand = extractBrand(it.description ?? "");
  const offer: Record<string, unknown> = {
    "@type": "Offer",
    url: it.source_url ?? canonical,
    priceCurrency: it.currency || "SEK",
    availability: ended ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
    itemCondition: condition,
    seller: { "@type": "Organization", name: name },
  };
  if (priceNum && priceNum > 0) offer.price = priceNum;
  // E4 (audit 2026-07-29): full ISO-datetime + availabilityEnds för live-objekt, så att
  // Google/AI vet exakt när erbjudandet upphör. Avslutade objekt får inget av fälten.
  if (it.ends_at && !ended) {
    const endsIso = new Date(it.ends_at).toISOString();
    offer.priceValidUntil = endsIso;
    offer.availabilityEnds = endsIso;
  }

  return layout({
    title, desc: metaDesc, canonical, h1: it.title ?? "Auktionsobjekt",
    intro: `Objekt hos ${esc(name)} – samlat på Allarop.`,
    crumbs, bodyHtml: body, noindex: ended, image: images[0],
    jsonld: [
      {
        "@type": "Product",
        name: it.title ?? "Auktionsobjekt",
        sku: `${house}/${id}`,
        ...(brand ? { brand: { "@type": "Brand", name: brand } } : {}),
        ...(categoryLabel ? { category: categoryLabel } : {}),
        itemCondition: condition,
        ...(images.length ? { image: images } : {}),
        ...(metaDesc ? { description: metaDesc } : {}),
        offers: offer,
      },
      breadcrumb(crumbs.map((c) => ({ name: c.name, url: c.url }))),
    ],
  });
}

// ── Publikt API ──────────────────────────────────────────────────────────────
/** Samma säkerhetsheaders som SPA-sidorna (server.ts SECURITY_HEADERS) + HSTS och
 * Permissions-Policy. Tidigare hade SSR-sidorna inga headers alls (audit 2026-07-29). */
const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "SAMEORIGIN",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};

/** HEAD får aldrig ha body (uptime-monitorer/HEAD-checkar). Servern dispatch:ar
 * GET+HEAD hit så vi måste själva droppa body:n för HEAD. */
function isHead(res: ServerResponse): boolean {
  return (res as unknown as { req?: { method?: string } }).req?.method === "HEAD";
}

function sendHtml(res: ServerResponse, status: number, html: string, cacheSeconds: number): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": `public, max-age=${cacheSeconds}`,
    ...SECURITY_HEADERS,
  });
  res.end(isHead(res) ? undefined : html);
}
function sendText(res: ServerResponse, contentType: string, body: string, cacheSeconds: number): void {
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": `public, max-age=${cacheSeconds}`,
  });
  res.end(isHead(res) ? undefined : body);
}

// ── llms.txt + robots.txt ─────────────────────────────────────────────────────
function renderLlmsTxt(): string {
  return `# Allarop

> Samlingsplattform för alla Sveriges nätauktioner. Allarop äger inga auktioner själv – budgivningen sker alltid hos respektive auktionshus.

Allarop samlar objekt från 29 svenska auktionssajter (Klaravik, Auctionet, PS Auction, Blinto, Tradera m.fl.) i ett sökbart index och visar det verkliga totalpriset inklusive avgifter, så att objekt kan jämföras rättvist mellan olika auktionshus. Tjänsten är gratis att använda.

## Vad sajten innehåller

- Sök och filtrering av alla aktiva objekt (titel, källa, kategori, ort, pris, sluttid)
- Objektsidor med bilder, beskrivning, sluttid, bud, slagavgift och totalpris
- Server-renderade kategori-, auktionshus- och ortssidor som är indexbara
- Guider om nätauktioner, avgifter, konkursauktioner och köpråd

## Viktiga sidor

- [Sök alla nätauktioner](${SITE}/) – huvudsidan med sök och filter
- [Guider](${SITE}/guide) – samtliga artiklar om nätauktioner och budgivning
- [Vad är en nätauktion?](${SITE}/guide/vad-ar-natauktioner) – grundläggande guide
- [Kategorier](${SITE}/kategori/fordon) – fordon, entreprenad, konst, smycken m.fl.
- [Auktionshus](${SITE}/auktioner/klaravik) – alla anslutna auktionssajter
- [Orter](${SITE}/plats/stockholm) – lokala nätauktioner per stad
- [Om, villkor, integritet, kontakt](${SITE}/om)

## Sidstruktur

- Startsida: \`/\`
- Objektsida: \`/objekt/<hus>/<id>\` (Product/Offer-schema)
- Kategorisida: \`/kategori/<huvudkategori>[/<underkategori>]\`
- Auktionshus-sida: \`/auktioner/<hus>\`
- Ortssida: \`/plats/<stad>\`
- Guidesida: \`/guide/<slug>\`

## Guider & prisstatistik

- [Alla guider](${SITE}/guide) – komplett guidekorpus om nätauktioner
- [Bästa nätauktionerna i Sverige](${SITE}/guide/basta-natauktionerna-sverige) – jämförelse av auktionsajter
- [Rolex-priser på Tradera 2026](${SITE}/guide/rolex-priser-tradera-2026) – prisstatistik för klockor
- [Trender på nätauktion 2026](${SITE}/guide/trender-natauktion-2026) – samlade marknadstrender

## Data

Indexet omfattar ~52 000 aktiva objekt från 29 källor, uppdaterat löpande.

Slutpriser inklusive avgifter visas på avslutade objekt.

## Optional

- [Sitemap](${SITE}/sitemap.xml)
- [Robots](${SITE}/robots.txt)
- [Komplett guidekorpus (llms-full.txt)](${SITE}/llms-full.txt)
`;
}

/** HTML → ren text för llms-full.txt. Blocktaggar ersätts med radbrytningar före stripTags
 * (stripTags kollapsar all whitespace till mellanslag, så brytningarna måste sättas först). */
function htmlToPlainText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote|h[1-6])>/gi, "\n");
  return withBreaks
    .split("\n")
    .map((line) => stripTags(line).trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** E8 (audit 2026-07-29): hela guidekorpusen som ren text för AI-crawlers som föredrar en
 * enda stor källa framför 50+ enskilda sidor. Eventuella "Källor"-sektioner i artiklarna
 * följer automatiskt med eftersom hela brödtexten tas med. */
function renderLlmsFullTxt(): string {
  const guides = [...loadGuides().values()].sort((a, b) => a.slug.localeCompare(b.slug, "sv"));
  const header = `# Allarop – komplett guidekorpus (llms-full)

> Samtliga Allarop-guider om svenska nätauktioner i ren text, för AI-assistenter och crawlers. Varje guide finns även som HTML-sida på allarop.se/guide/<slug>. Allarop är en aggregator – budgivning sker hos respektive auktionshus.
`;
  const parts = guides.map((g) => {
    const lines = [
      `# ${g.h1}`,
      "",
      `URL: ${SITE}/guide/${g.slug}`,
      `Uppdaterad: ${g.updated ?? GUIDE_PUBLISHED}`,
      "",
    ];
    if (g.snabbsvar) lines.push(g.snabbsvar, "");
    const body = htmlToPlainText(g.bodyHtml);
    if (body) lines.push(body, "");
    if (g.faq.length) {
      lines.push("## Vanliga frågor", "");
      for (const f of g.faq) lines.push(`${f.q}`, `${f.a}`, "");
    }
    return lines.join("\n").trimEnd();
  });
  return `${header}\n${parts.join("\n\n---\n\n")}\n`;
}

/** Namngivna AI-crawlers får explicit Allow utöver wildcarden (funktionellt en no-op, men
 * gör policyn explicit för crawlers som särbehandlar namngivna regler över wildcard). */
const AI_BOTS = [
  "GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "anthropic-ai",
  "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended",
  "Amazonbot", "Bytespider", "CCBot",
];
/** Interna verktyg (ruttplanerare/prisuppslag) - redan admin-gated i klienten, ingen publik
 * länk pekar hit. Utestängda från ALLA User-agent-block (inte bara wildcarden) - en bot med
 * ett eget namngivet block ignorerar annars wildcardens regler helt. */
const DISALLOW_PATHS = ["/rutt", "/priser"];
function renderRobotsTxt(): string {
  const disallow = DISALLOW_PATHS.map((p) => `Disallow: ${p}\n`).join("");
  const wildcard = `User-agent: *\nAllow: /\n${disallow}`;
  const blocks = AI_BOTS.map((ua) => `User-agent: ${ua}\nAllow: /\n${disallow}`).join("\n");
  return `${wildcard}\n${blocks}\nSitemap: ${SITE}/sitemap.xml\n`;
}

// ── Sitemap: index + stabila sidor + objektsidor (paginerat) ─────────────────
/** Statiska app-sidor utöver de SSR-genererade landningssidorna. /villkor,/integritet,
 * /kontakt saknas medvetet - de redirectar numera till /om#<sektion> (duplicate-content-fix).
 * /rutt,/priser saknas medvetet - interna admin-gated verktyg, ska inte crawlas/indexeras
 * (samma skäl som DISALLOW_PATHS ovan). */
const APP_PAGES = ["/", "/om"];
const ITEMS_PER_SITEMAP = 45_000; // sitemap-spec-taket är 50 000 URL:er/fil

type SitemapRow = { house: string; external_id: string; last_seen: Date | null };
/** Alla aktiva objekt för sitemap-paginering. EGEN mager fråga (bara house/external_id/
 * last_seen) - listActive()/ITEM_SELECT drar 3 korrelerade subqueries per rad (bild, lat,
 * lon), fint vid limit:60 men ~45s vid 58k rader (mätt live, gav CF 502). Sitemapen behöver
 * ingen av de kolumnerna. Samma ACTIVE_COND-villkor som repo.ts (status='active' AND
 * (ends_at IS NULL OR ends_at > now())), så items_active_ends_idx täcker frågan. Anropas
 * separat per request (index vs. en specifik sida); cache-control gör det sällsynt nog. */
async function activeItemsForSitemap(): Promise<SitemapRow[]> {
  // Respektera admin-dolda hus (settings.hidden_houses i repo.ts) - de ska inte heller
  // crawlas/indexeras via sitemapen (synlighetsläget gäller överallt, inte bara UI:t).
  const hidden = await getHiddenHouses().catch(() => [] as string[]);
  const q = await pool.query<SitemapRow>(
    `SELECT house, external_id, last_seen FROM items
     WHERE status='active' AND (ends_at IS NULL OR ends_at > now())
       AND ($1::text[] IS NULL OR house <> ALL($1::text[]))
     ORDER BY ends_at ASC NULLS LAST`,
    [hidden.length ? hidden : null],
  );
  return q.rows;
}
function urlEntry(loc: string, lastmod: string, changefreq: string, priority: string): string {
  return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
}
/** XSL-stilmall så sitemapsen renderas som en läsbar sida i webbläsaren (för människor) -
 * crawlers ignorerar processing-instruktionen och läser XML:en som vanligt. Utan denna
 * visar webbläsaren rå-XML med "no style information"-varning, vilket ser trasigt ut. */
const XSL_PI = `<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>\n`;
function renderPagesSitemap(): string {
  const all = [...APP_PAGES.map((u) => SITE + u), ...seoSitemapUrls()];
  const seen = new Set<string>();
  const now = new Date().toISOString();
  const body = all
    .filter((u) => !seen.has(u) && seen.add(u))
    .map((u) => urlEntry(u, now, "hourly", u === `${SITE}/` ? "1.0" : "0.8"))
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${XSL_PI}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
async function renderSitemapIndex(): Promise<string> {
  const items = await activeItemsForSitemap();
  const pages = Math.max(1, Math.ceil(items.length / ITEMS_PER_SITEMAP));
  const now = new Date().toISOString();
  const entries = [
    `  <sitemap><loc>${SITE}/sitemap-pages.xml</loc><lastmod>${now}</lastmod></sitemap>`,
    ...Array.from({ length: pages }, (_, i) =>
      `  <sitemap><loc>${SITE}/sitemap-items-${i + 1}.xml</loc><lastmod>${now}</lastmod></sitemap>`),
  ].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${XSL_PI}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
}
/** null = sidan finns inte (bortom antal objekt) → server.ts 404. */
async function renderItemsSitemap(page: number): Promise<string | null> {
  const items = await activeItemsForSitemap();
  const start = (page - 1) * ITEMS_PER_SITEMAP;
  if (page < 1 || start >= items.length) return null;
  const slice = items.slice(start, start + ITEMS_PER_SITEMAP);
  const now = new Date().toISOString();
  const body = slice
    .map((r) => urlEntry(itemUrl(r), r.last_seen ? new Date(r.last_seen).toISOString() : now, "hourly", "0.5"))
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${XSL_PI}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/** Stilmallen som /sitemap.xsl serverar (cache:as dygnet; ändras sällan). */
const SITEMAP_XSL = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9">
<xsl:output method="html" encoding="UTF-8" />
<xsl:template match="/">
<html lang="sv">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sitemap – Allarop</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f3ef;color:#14201e;margin:0;padding:26px 18px;line-height:1.5}
  .wrap{max-width:1100px;margin:0 auto}
  header{display:flex;align-items:center;gap:10px;margin-bottom:20px}
  header .mark{width:26px;height:26px;border-radius:8px;background:#14201e;display:inline-block}
  header b{font-size:19px;letter-spacing:-.02em}
  header span{color:#68746d;font-size:14px}
  h1{font-size:26px;letter-spacing:-.03em;margin:0 0 6px}
  .sub{color:#68746d;margin:0 0 20px;font-size:14.5px}
  .card{background:#fff;border:1px solid #e5e2d8;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(20,32,30,.05)}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th{background:#e2f1ec;color:#0a5e4a;text-align:left;padding:10px 14px;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
  td{padding:9px 14px;border-top:1px solid #f0eee7;vertical-align:top}
  tr:hover td{background:#f9f8f4}
  a{color:#0a5e4a;text-decoration:none;word-break:break-all}
  a:hover{text-decoration:underline}
  .count{font-weight:800;color:#0a5e4a}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
</style>
</head>
<body><div class="wrap">
<header><span class="mark"></span><b>allarop.se</b><span>Sitemap</span></header>
<xsl:choose>
  <xsl:when test="s:sitemapindex">
    <h1>Sitemap-index</h1>
    <p class="sub"><span class="count"><xsl:value-of select="count(s:sitemapindex/s:sitemap)" /></span> undersitemaps. Crawlers läser dessa maskinellt – den här vyn är för människor.</p>
    <div class="card"><table>
      <tr><th>Undersitemap</th><th>Senast ändrad</th></tr>
      <xsl:for-each select="s:sitemapindex/s:sitemap">
        <tr>
          <td><a href="{s:loc}"><xsl:value-of select="s:loc" /></a></td>
          <td class="num"><xsl:value-of select="s:lastmod" /></td>
        </tr>
      </xsl:for-each>
    </table></div>
  </xsl:when>
  <xsl:otherwise>
    <h1>Sitemap</h1>
    <p class="sub"><span class="count"><xsl:value-of select="count(s:urlset/s:url)" /></span> sidor totalt.<xsl:if test="count(s:urlset/s:url) &gt; 500"> Visar de första 500 här – crawlers läser alla.</xsl:if></p>
    <div class="card"><table>
      <tr><th>URL</th><th>Senast ändrad</th><th>Frekvens</th><th>Prio</th></tr>
      <xsl:for-each select="s:urlset/s:url[position() &lt;= 500]">
        <tr>
          <td><a href="{s:loc}"><xsl:value-of select="s:loc" /></a></td>
          <td class="num"><xsl:value-of select="s:lastmod" /></td>
          <td class="num"><xsl:value-of select="s:changefreq" /></td>
          <td class="num"><xsl:value-of select="s:priority" /></td>
        </tr>
      </xsl:for-each>
    </table></div>
  </xsl:otherwise>
</xsl:choose>
</div></body>
</html>
</xsl:template>
</xsl:stylesheet>
`;

/**
 * Hanterar SEO-SSR-rutter. Returnerar true om rutten hanterades (svaret är skickat),
 * annars false (server.ts fortsätter med sina egna rutter).
 */
export async function handleSeoPage(pathname: string, res: ServerResponse): Promise<boolean> {
  if (pathname === "/robots.txt") {
    sendText(res, "text/plain; charset=utf-8", renderRobotsTxt(), 86400); return true;
  }
  if (pathname === "/llms.txt") {
    sendText(res, "text/markdown; charset=utf-8", renderLlmsTxt(), 86400); return true;
  }
  if (pathname === "/llms-full.txt") {
    sendText(res, "text/markdown; charset=utf-8", renderLlmsFullTxt(), 86400); return true;
  }
  if (pathname === "/sitemap.xsl") {
    sendText(res, "text/xsl; charset=utf-8", SITEMAP_XSL, 86400); return true;
  }
  if (pathname === "/sitemap.xml") {
    sendText(res, "application/xml; charset=utf-8", await renderSitemapIndex(), 3600); return true;
  }
  if (pathname === "/sitemap-pages.xml") {
    sendText(res, "application/xml; charset=utf-8", renderPagesSitemap(), 3600); return true;
  }
  const itemsSitemapMatch = pathname.match(/^\/sitemap-items-(\d+)\.xml$/);
  if (itemsSitemapMatch && itemsSitemapMatch[1]) {
    const xml = await renderItemsSitemap(Number(itemsSitemapMatch[1]));
    if (xml == null) return false; // → server.ts 404
    sendText(res, "application/xml; charset=utf-8", xml, 3600); return true;
  }

  const parts = pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));

  if (parts[0] === "guide" && parts[1] === "vad-ar-natauktioner" && parts.length === 2) {
    sendHtml(res, 200, renderGuide(), 3600); return true;
  }
  if (parts[0] === "guide" && parts.length === 1) {
    sendHtml(res, 200, renderGuideIndex(), 3600); return true;
  }
  if (parts[0] === "guide" && parts.length === 2) {
    const html = renderGuidePage(parts[1]!);
    if (html == null) return false;
    sendHtml(res, 200, html, 3600); return true;
  }
  if (parts[0] === "kategori" && (parts.length === 2 || parts.length === 3)) {
    const key = parts.slice(1).join("/");
    const hit = CAT_BY_KEY.get(key);
    if (!hit) return false;
    sendHtml(res, 200, await renderCategory(hit), 900); return true;
  }
  if (parts[0] === "auktioner" && parts.length === 2) {
    const house = (parts[1] ?? "").toLowerCase();
    if (!HOUSE_LABELS[house]) return false;
    sendHtml(res, 200, await renderHouse(house), 900); return true;
  }
  if (parts[0] === "plats" && parts.length === 2) {
    const city = CITY_BY_SLUG.get((parts[1] ?? "").toLowerCase());
    if (!city) return false;
    sendHtml(res, 200, await renderCity(city), 900); return true;
  }
  if (parts[0] === "objekt" && parts.length === 3 && parts[1] && parts[2]) {
    const html = await renderItem(parts[1], parts[2]);
    if (html == null) return false; // → server.ts 404
    sendHtml(res, 200, html, 300); return true;
  }
  return false;
}

/** Alla stabila landnings-URL:er för sitemap.xml (objektsidor upptäcks via interna länkar). */
export function seoSitemapUrls(): string[] {
  const urls: string[] = [`${SITE}/guide`, `${SITE}/guide/vad-ar-natauktioner`];
  for (const slug of loadGuides().keys()) urls.push(`${SITE}/guide/${slug}`);
  for (const m of TAXONOMY) {
    urls.push(`${SITE}/kategori/${m.key}`);
    for (const s of m.subs) urls.push(`${SITE}/kategori/${m.key}/${s.key}`);
  }
  for (const h of HOUSE_KEYS) urls.push(`${SITE}/auktioner/${h}`);
  for (const c of CITIES) urls.push(`${SITE}/plats/${slugify(c)}`);
  return urls;
}
