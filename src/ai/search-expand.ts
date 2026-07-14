/**
 * Smart sök: LLM-expansion av sökfrågor. "diskho" heter också ho/vask/diskbänk; den som
 * söker "dykning" vill se våtdräkt/cyklop/regulator också. En billig LLM expanderar
 * frågan EN gång (synonymer + relaterade föremål + taxonomikategorier), svaret cachas
 * PERMANENT i search_expansions → varje unik fråga kostar ~$0,0001 en gång, sen gratis.
 * Sökningen rankar i nivåer: direktträffar → synonymer → relaterat/kategori.
 */

import { pool } from "../db/pool.ts";
import { TAXONOMY } from "../categories/taxonomy.ts";
import { callLlm } from "./classify-llm.ts";

export interface QueryExpansion {
  synonyms: string[]; // andra ord för SAMMA sak (inkl. eng/varianter)
  related: string[]; // nära relaterade föremål/tillbehör
  categories: string[]; // taxonominycklar ("huvud/under")
}

const MAX_SYN = 8;
const MAX_REL = 14;
const MAX_CAT = 3;

function taxonomyKeys(): Set<string> {
  const out = new Set<string>();
  for (const m of TAXONOMY) for (const s of m.subs) out.add(`${m.key}/${s.key}`);
  return out;
}

export function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Värd att expandera? Korta/pågående inmatningar och siffror ger bara cache-skräp. */
export function worthExpanding(q: string): boolean {
  const n = normalizeQuery(q);
  return n.length >= 4 && /[a-zåäö]{4,}/i.test(n) && n.length <= 60;
}

export function buildExpandPrompt(q: string): string {
  const tax = TAXONOMY.map(
    (m) => `${m.key}: ${m.subs.map((s) => `${m.key}/${s.key}`).join(", ")}`,
  ).join("\n");
  return [
    `En användare söker på en svensk auktionssajt efter: "${q}"`,
    "Hjälp sökningen att hitta rätt och mer:",
    `1. synonyms: andra ord/stavningar för SAMMA sak på svenska (och vanlig engelska), max ${MAX_SYN}.`,
    `   Exempel: "diskho" → ["ho","vask","diskbänk","rostfri ho"].`,
    `   VIKTIGT: om frågan är flera ord som TILLSAMMANS betyder en sak (t.ex. "ram minne" =`,
    `   datorns arbetsminne), ge synonymer för HELHETEN - aldrig de enskilda orden var för sig`,
    `   (ge "ram-minne","arbetsminne","ddr4","minnesmodul", INTE bara "ram" eller bara "minne").`,
    `2. related: nära relaterade FÖREMÅL/tillbehör en sådan sökare ofta också vill se, max ${MAX_REL}.`,
    `   Exempel: "dykning" → ["våtdräkt","cyklop","regulator","dykflaska","snorkel","torrdräkt","dykdator"].`,
    `3. categories: mest relevanta taxonominycklar ur listan nedan (exakt stavning), max ${MAX_CAT}.`,
    "",
    "TAXONOMI:",
    tax,
    "",
    'Svara med ENDAST kompakt JSON utan kodblock: {"synonyms":[...],"related":[...],"categories":[...]}',
  ].join("\n");
}

/** Parsa + sanera LLM-svaret (okända kategorinycklar och skräptermer kastas). */
export function parseExpansion(text: string, q: string): QueryExpansion | null {
  const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/gi, ""));
  if (!m) return null;
  let j: { synonyms?: unknown; related?: unknown; categories?: unknown };
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const keys = taxonomyKeys();
  const norm = normalizeQuery(q);
  // Enskilda ord ur en flerords-fråga är MISLEDANDE synonymer ("ram minne" → bara "ram"
  // matchar ramar/tavlor, bara "minne" matchar minnestallrikar) → filtrera bort dem.
  const queryWords = new Set(norm.split(/\s+/).filter((w) => w.length >= 2));
  const isBareComponent = (s: string) => queryWords.size > 1 && queryWords.has(s);
  const clean = (v: unknown, max: number): string[] =>
    (Array.isArray(v) ? v : [])
      .map((s) => normalizeQuery(String(s)))
      .filter((s) => s.length >= 2 && s.length <= 40 && s !== norm && !isBareComponent(s))
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .slice(0, max);
  return {
    synonyms: clean(j.synonyms, MAX_SYN),
    related: clean(j.related, MAX_REL),
    categories: (Array.isArray(j.categories) ? j.categories : [])
      .map((s) => String(s))
      .filter((s) => keys.has(s))
      .slice(0, MAX_CAT),
  };
}

/** Kort deadline på LLM-rundan (env-styrbar) - sökningens kritiska väg är sekventiell
 * (expandQuery → semanticTopK → hybridSearch) så en trög/hängande modell adderas rakt av. */
const EXPAND_TIMEOUT_MS = 2500;

/**
 * Expandera en sökfråga: permanent cache → annars EN billig LLM-runda med kort deadline.
 *  - Timeout/anropsfel (trög modell, alla nere): null UTAN cache → transient, försök igen
 *    nästa sökning (sökningen kör vidare lexikalt under tiden).
 *  - LLM svarar men ger inget brukbart (oparsbart, eller allt bortfiltrerat - t.ex. "klocka"):
 *    cacha en TOM expansion så termen betalar LLM-rundan EN gång, aldrig varje sökning.
 */
export async function expandQuery(q: string): Promise<QueryExpansion | null> {
  if (!worthExpanding(q)) return null;
  const norm = normalizeQuery(q);
  const cached = await pool.query<{ synonyms: string[]; related: string[]; categories: string[] }>(
    "SELECT synonyms, related, categories FROM search_expansions WHERE query=$1",
    [norm],
  );
  if (cached.rows[0]) return cached.rows[0];
  if (!process.env.OPENROUTER_API_KEY) return null;

  const deadline = AbortSignal.timeout(Number(process.env.SEARCH_EXPAND_TIMEOUT_MS) || EXPAND_TIMEOUT_MS);
  const text = await callLlm(buildExpandPrompt(norm), deadline);
  // Ingen färdig LLM-runda (deadline slog till eller alla modeller nere) → transient, cacha
  // ALDRIG (en tillfällig svacka får inte permanent döda expansionen för termen).
  if (deadline.aborted || text == null) return null;
  // LLM svarade: parsat resultat, annars TOM expansion (negativ cache). Tomma arrayer =
  // "ingen expansion" i söket (termsRegex → null), så cache-träffen kör lexikalt men gratis.
  const exp = parseExpansion(text, norm) ?? { synonyms: [], related: [], categories: [] };
  await pool.query(
    `INSERT INTO search_expansions (query, synonyms, related, categories, model)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (query) DO NOTHING`,
    [norm, exp.synonyms, exp.related, exp.categories, "llm"],
  );
  return exp;
}
