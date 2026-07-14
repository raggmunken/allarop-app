/**
 * LLM-klassning av ALLA objekt (LLM = auktoritet, inga manuella nyckelord) med ett
 * SJÄLVLÄRANDE lexikon som accelererar: varje LLM-beslut lär lexikonet titel-tokens →
 * kategori, och objekt lexikonet är säkert på klassas DIREKT (conf 'learned') utan
 * API-anrop. Passet arbetar sig igenom alla aktiva objekt som ännu inte är llm/learned
 * (sämst konfidens först: none → mixed → house → text), batchat ~40/anrop; nyckelords-
 * klassningen fungerar bara som PRELIMINÄR etikett tills LLM/lexikonet hunnit ikapp.
 *
 * Modellen väljer en nyckel ur VÅR taxonomi och svaret valideras hårt (okända nycklar
 * kastas). conf-rang (cat_conf_rank i schema.sql) ser till att llm/learned aldrig
 * skrivs över av svagare klassningar. Objekt som modellen inte lyckas klassa markeras
 * försökta (in-memory) så samma batch inte loopar; nytt försök efter omstart.
 *
 * Kräver OPENROUTER_API_KEY. Modellkedja (gratis, text, juli 2026 - env-styrbar via
 * OPENROUTER_TEXT_MODEL): nemotron-3-super-120b → gpt-oss-120b → llama-3.3-70b →
 * gemma-4-31b. 429/fel → nästa modell.
 */

import { pool } from "../db/pool.ts";
import { TAXONOMY } from "../categories/taxonomy.ts";
import { ItemAttrs } from "../db/similar.ts";
import { regnrFrom } from "../vehicle/biluppgifter.ts";
import { lexicon } from "../categories/learned.ts";
import { toDataUrl } from "./imageverify.ts";
import { PAID_MODEL, paidAllowed, currentUsage } from "./budget.ts";

const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
/**
 * BETALD huvudmodell (billig, stark, vision): gemini-2.5-flash-lite ≈ $0,04/1000 objekt
 * → hela beståndet för ett par dollar. Gratis-modeller som fallback + när BUDGETVAKTEN
 * (src/ai/budget.ts) slår till plockas betalmodeller bort ur kedjan automatiskt.
 * Icke-reasoning-gratismodeller först i fallback (reasoning bränner max_tokens på
 * tankekedjan och trunkerar stora batchar).
 */
const MODELS = [
  process.env.OPENROUTER_TEXT_MODEL,
  PAID_MODEL,
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-4-31b-it:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "openai/gpt-oss-120b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
].filter((m): m is string => !!m);

export interface LlmItem {
  title: string;
  desc?: string | null;
  /** Auktionshusets visningsnamn - hint (t.ex. Pantbanken ≈ smycken/klockor). */
  house?: string | null;
}

/** Alla giltiga taxonominycklar ("huvud/under"). */
export function validKeys(): Set<string> {
  const out = new Set<string>();
  for (const m of TAXONOMY) for (const s of m.subs) out.add(`${m.key}/${s.key}`);
  return out;
}

/** Bygg batch-prompten: taxonomin + numrerade objekt → strikt JSON-svar. */
export function buildClassifyPrompt(items: LlmItem[]): string {
  const cut = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const tax = TAXONOMY.map(
    (m) => `${m.key}: ${m.label} → ${m.subs.map((s) => `${m.key}/${s.key} (${s.label})`).join(", ")}`,
  ).join("\n");
  // Allt annonsen ger: titel + innehållstext + auktionshus (specialiserade hus är en
  // stark hint, t.ex. Pantbanken ≈ smycken/klockor).
  const rows = items
    .map(
      (it, i) =>
        `${i}: "${cut(it.title, 140)}"${it.desc ? ` - ${cut(it.desc, 450)}` : ""}${it.house ? ` [hus: ${cut(it.house, 30)}]` : ""}`,
    )
    .join("\n");
  return [
    "Du klassificerar svenska auktionsobjekt i en fast taxonomi. Välj för varje objekt den",
    "BÄSTA nyckeln på formen huvud/under ur listan nedan (exakt stavning, inga egna nycklar).",
    "Blandade partier som spänner över flera helt olika kategorier → ovrigt/partier.",
    "Passar inget alls → ovrigt/diverse.",
    "",
    "TAXONOMI:",
    tax,
    "",
    "OBJEKT:",
    rows,
    "",
    "För varje objekt: k = taxonominyckel, n = antal LIKADANA huvudföremål i lotten",
    "(4 stolar → 4, ett par ljusstakar → 2, en byrå → 1; utelämna n om det är oklart).",
    ATTRS_INSTRUCTION,
    'Svara med ENDAST en kompakt JSON-array utan kodblock: [{"i":0,"k":"huvud/under","n":1,"b":"Ford","m":"Transit 1100","t":"veteranhusbil","y":1971},...] - en post per objekt.',
  ].join("\n");
}

/** Attribut-instruktionen (delad text- och vision-prompt): bara BELAGDA fält, aldrig gissningar. */
const ATTRS_INSTRUCTION = [
  "Extrahera även attribut per objekt - UTELÄMNA varje fält som inte uttryckligen framgår, GISSA ALDRIG:",
  "b = märke/tillverkare, m = modellnamn/serie, d = designer/formgivare (person),",
  't = objekttyp som ETT precist svenskt substantiv (t.ex. "veteranhusbil", "gitarrförstärkare", "matbord"),',
  "y = tillverkningsår/årsmodell (heltal), mat = huvudmaterial,",
  'reg = svenskt registreringsnummer för fordon (format ABC123 eller ABC12D) - ur texten eller AVLÄST på registreringsskylten i bilden.',
].join("\n");

export interface ClassifyVerdict {
  key: string; // taxonominyckel
  n: number | null; // antal likadana huvudföremål (null = okänt)
  attrs: ItemAttrs | null; // belagda attribut (null = inga extraherade)
}

/** Validera/trimma attributfälten ur ett svarsobjekt (okända/oskäliga värden kastas). */
export function attrsFromObj(o: Record<string, unknown>): ItemAttrs | null {
  const str = (v: unknown, max = 60): string | undefined => {
    if (typeof v !== "string") return undefined;
    const s = v.replace(/\s+/g, " ").trim().slice(0, max);
    return s.length >= 2 ? s : undefined;
  };
  const out: ItemAttrs = {};
  const b = str(o.b);
  const m = str(o.m);
  const d = str(o.d);
  const t = str(o.t, 40);
  const mat = str(o.mat, 40);
  const yRaw = Number(o.y);
  if (b) out.b = b;
  if (m) out.m = m;
  if (d) out.d = d;
  if (t) out.t = t;
  if (mat) out.mat = mat;
  if (Number.isInteger(yRaw) && yRaw >= 1000 && yRaw <= 2100) out.y = yRaw;
  // Regnr valideras mot svenskt format (regnrFrom normaliserar + kastar skräp).
  const reg = typeof o.reg === "string" ? regnrFrom(o.reg) : null;
  if (reg) out.reg = reg;
  return Object.keys(out).length ? out : null;
}

/**
 * Parsa svaret → index → {taxonominyckel, antal} (ogiltiga/dubbletter kastas).
 * Trunkerings-tålig: plockar enskilda {...}-objekt i stället för att kräva en hel
 * JSON-array (varje helt objekt räddas), och tål godtycklig nyckelordning.
 */
export function parseClassifyResponse(text: string, count: number): Map<number, ClassifyVerdict> {
  const out = new Map<number, ClassifyVerdict>();
  const keys = validKeys();
  const mains = new Set(TAXONOMY.map((m) => m.key));
  const clean = text.replace(/```(?:json)?/gi, "");
  for (const m of clean.matchAll(/\{[^{}]*\}/g)) {
    let o: { i?: unknown; k?: unknown; n?: unknown };
    try {
      o = JSON.parse(m[0]);
    } catch {
      continue;
    }
    const i = Number(o.i);
    let k = String(o.k ?? "");
    // Räddning: modellen hittar ibland på en undernyckel ("elektronik/diverse") -
    // giltig HUVUDkategori räddas till main-nivå i st f att kastas (annars omprövas
    // objektet i evighet, spinn-fyndet 2026-07-06). UI/filter/prisgate kör main-nivå.
    if (!keys.has(k)) {
      const main = k.split("/")[0] ?? "";
      if (!mains.has(main)) continue;
      k = main;
    }
    if (!Number.isInteger(i) || i < 0 || i >= count || out.has(i)) continue;
    const nRaw = Number(o.n);
    const n = Number.isInteger(nRaw) && nRaw >= 1 && nRaw <= 10_000 ? nRaw : null;
    out.set(i, { key: k, n, attrs: attrsFromObj(o as Record<string, unknown>) });
  }
  return out;
}

// Vision-kedja: betald huvudmodell först, gratis som fallback/efter budgettak.
const VISION_MODELS = [
  process.env.OPENROUTER_VISION_MODEL,
  PAID_MODEL,
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-nano-12b-v2-vl:free",
].filter((m): m is string => !!m);

/** Ett OpenRouter-anrop med modell-fallback. Null när alla modeller fallerar.
 * Exporterad - även sök-expansionen (search-expand.ts) använder samma kedja/budgetvakt.
 * signal: valfri EGEN deadline (sök-expansionen ger en kort sådan så en trög modell aldrig
 * blockerar sökningen); utelämnad → per-modell-timeouten (90 s) gäller som förr. */
export async function callLlm(prompt: string, signal?: AbortSignal): Promise<string | null> {
  return callModels(MODELS, [{ type: "text", text: prompt }], signal);
}

/** Som callLlm men med multimodalt innehåll (text + bilder) mot vision-modellerna. */
async function callVision(content: unknown[]): Promise<string | null> {
  return callModels(VISION_MODELS, content);
}

/** Enbart GRATIS vision-modeller (plåtläsning ska aldrig kosta - bred, billig täckning). */
const FREE_VISION_MODELS = VISION_MODELS.filter((m) => m.endsWith(":free"));

/**
 * Läs en svensk registreringsskylt ur EN fordonsbild med GRATIS vision-modeller.
 * Returnerar normaliserat regnr (regnrFrom validerar formatet) eller null när ingen
 * läsbar skylt finns. OBS: läsningen KORSVALIDERAS mot biluppgifters märke i
 * anropande kod (feltolkad skylt → annat fordon → kastas) - "hellre inget än fel".
 */
export async function readPlate(imageDataUrl: string): Promise<string | null> {
  const content = [
    {
      type: "text",
      text:
        "Bilden visar ett fordon på en svensk auktion. Om en svensk registreringsskylt är " +
        "SYNLIG och LÄSBAR, svara med ENBART registreringsnumret (format ABC123 eller ABC12D). " +
        "Syns ingen skylt, eller är den skymd/suddig/oläslig, svara exakt: NONE. Gissa ALDRIG.",
    },
    { type: "image_url", image_url: { url: imageDataUrl } },
  ];
  const text = await callModels(FREE_VISION_MODELS, content);
  if (text == null || /\bNONE\b/i.test(text)) return null;
  return regnrFrom(text);
}

/** Senaste felet från callModels (för fellogg i bulk/pass - gissa aldrig orsak). */
export let lastCallError = "";

async function callModels(models: string[], content: unknown[], signal?: AbortSignal): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  // Budgetvakt: över taket → hoppa betalmodeller (gratis-kedjan, ":free", blir kvar).
  const paid = await paidAllowed();
  const usable = paid ? models : models.filter((m) => m.endsWith(":free"));
  for (const model of usable) {
    try {
      const res = await fetch(OR_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://allarop.local",
          "X-Title": "Allarop kategorisering",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content }],
          // Rymligt: reasoning-modeller i fallback-kedjan bränner tokens på tankekedjan.
          max_tokens: 8000,
          temperature: 0,
        }),
        // Egen deadline (samma signal över hela modellkedjan = totalt budget) eller, som
        // förr, 90 s per modell. Aborteras signalen fångas felet nedan → nästa modell/null.
        signal: signal ?? AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        lastCallError = `${model} HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 220)}`;
        continue; // 429/4xx/5xx → nästa modell
      }
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
      const text = j.choices?.[0]?.message?.content;
      if (text) return text;
      lastCallError = `${model} tomt svar${j.error?.message ? `: ${String(j.error.message).slice(0, 180)}` : ""}`;
    } catch (e) {
      lastCallError = `${model} ${(e as Error).message.slice(0, 180)}`;
    }
  }
  return null;
}

/** Objekt som redan försökts denna process (LLM:en gav inget svar) → loopa inte. */
const attempted = new Set<string>();

export interface LlmPassResult {
  sent: number; // objekt skickade till LLM
  classified: number; // LLM-klassade i DB
  learned: number; // klassade direkt ur lexikonet (inget API-anrop)
  remaining: number; // kvarvarande ej llm/learned (efter passet)
  lexiconSize: number; // antal kända tokens (växer med varje pass)
}

/**
 * Ett klassningspass mot ALLA aktiva objekt som ännu inte är llm/learned (sämst
 * konfidens först). Steg 1: lexikonet klassar det den är säker på (gratis). Steg 2:
 * resten (upp till batch-taket) går till LLM; besluten skrivs som conf='llm' och LÄRS
 * in i lexikonet. Null när nyckel saknas eller alla modeller fallerar.
 */
export async function llmClassifyPass(limit = Number(process.env.AI_CLASSIFY_BATCH ?? 40)): Promise<LlmPassResult | null> {
  if (!process.env.OPENROUTER_API_KEY) return null;
  if (attempted.size > 20_000) attempted.clear(); // tak - hellre omförsök än obegränsad tillväxt
  await lexicon.ensureLoaded();

  // Hämta mer än batch-taket - lexikonet betar av sin del gratis först. BARA objekt
  // UTAN bild: bild+text-passet (vision) är huvudvägen för allt som har bild.
  const { rows } = await pool.query<{ house: string; external_id: string; title: string; description: string | null }>(
    `SELECT house, external_id, title, left(description, 500) AS description
     FROM items i
     WHERE status='active' AND title IS NOT NULL
       AND (category_conf IS NULL OR category_conf NOT IN ('llm','learned'))
       AND NOT (house || '/' || external_id = ANY($2::text[]))
       AND NOT EXISTS (SELECT 1 FROM media m WHERE m.house=i.house AND m.owner_type='item'
                         AND m.owner_external_id=i.external_id AND m.kind='image')
     ORDER BY cat_conf_rank(category_conf) ASC, ends_at ASC NULLS LAST
     LIMIT $1`,
    [limit * 5, [...attempted]],
  );
  const remaining = async (): Promise<number> => {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM items WHERE status='active'
         AND (category_conf IS NULL OR category_conf NOT IN ('llm','learned'))`,
    );
    return Number(r.rows[0]?.n ?? 0);
  };
  if (rows.length === 0) return { sent: 0, classified: 0, learned: 0, remaining: 0, lexiconSize: lexicon.size() };

  // Steg 1: lexikonet (eleven) klassar det den är säker på - inga API-anrop.
  let learnedCount = 0;
  const forLlm: typeof rows = [];
  for (const r of rows) {
    const hit = lexicon.classify(r.title);
    if (hit) {
      await pool.query(
        `UPDATE items SET category=$1, category_conf='learned'
         WHERE house=$2 AND external_id=$3
           AND cat_conf_rank(category_conf) < cat_conf_rank('learned')`,
        [hit.category, r.house, r.external_id],
      );
      learnedCount++;
    } else if (forLlm.length < limit) {
      forLlm.push(r);
    }
  }
  if (forLlm.length === 0) {
    return { sent: 0, classified: 0, learned: learnedCount, remaining: await remaining(), lexiconSize: lexicon.size() };
  }

  // Steg 2: LLM:en (läraren) klassar resten av batchen - och lexikonet lär sig.
  const prompt = buildClassifyPrompt(forLlm.map((r) => ({ title: r.title, desc: r.description, house: r.house })));
  const text = await callLlm(prompt);
  if (text == null) return null;
  const verdicts = parseClassifyResponse(text, forLlm.length);

  let classified = 0;
  const toLearn: { title: string; category: string }[] = [];
  for (let i = 0; i < forLlm.length; i++) {
    const r = forLlm[i]!;
    const v = verdicts.get(i);
    if (v) {
      await writeVerdict(r, v, toLearn);
      classified++;
    } else {
      attempted.add(`${r.house}/${r.external_id}`);
    }
  }
  await lexicon.learn(toLearn);
  return { sent: forLlm.length, classified, learned: learnedCount, remaining: await remaining(), lexiconSize: lexicon.size() };
}

/**
 * Attribut-ONLY-prompt (text, ingen taxonomi) - för backfill av redan klassade objekt
 * (historik + aktiva). Objekt utan belagda fält ska svaras {"i":N} (tom post) så att
 * raden markeras försökt ('{}') och inte hämtas om i evighet.
 */
export function buildAttrsPrompt(items: LlmItem[]): string {
  const cut = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const rows = items
    .map((it, i) => `${i}: "${cut(it.title, 140)}"${it.desc ? ` - ${cut(it.desc, 450)}` : ""}`)
    .join("\n");
  return [
    "Du extraherar produktattribut ur svenska auktionsannonser (titel + text).",
    ATTRS_INSTRUCTION,
    "",
    "OBJEKT:",
    rows,
    "",
    'Svara med ENDAST en kompakt JSON-array utan kodblock, EN post per objekt (även utan fält):',
    '[{"i":0,"b":"Ford","m":"Transit 1100","t":"veteranhusbil","y":1971},{"i":1,"t":"matta"},{"i":2},...]',
  ].join("\n");
}

/** Parsa attribut-only-svaret → index → ItemAttrs ({} = försökt men inget belagt). */
export function parseAttrsResponse(text: string, count: number): Map<number, ItemAttrs> {
  const out = new Map<number, ItemAttrs>();
  const clean = text.replace(/```(?:json)?/gi, "");
  for (const m of clean.matchAll(/\{[^{}]*\}/g)) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(m[0]);
    } catch {
      continue;
    }
    const i = Number(o.i);
    if (!Number.isInteger(i) || i < 0 || i >= count || out.has(i)) continue;
    out.set(i, attrsFromObj(o) ?? {});
  }
  return out;
}

/** Bild-försökta objekt denna process (vision-modellen gav inget/oparsbart verdict) →
 * loopa inte. EXPORTERAD så bulk-scripts (classify-ended) kan skippa dem i sin kö -
 * annars refetchas ett verdictlöst objekt i evighet (spinn-fyndet 2026-07-06). */
export const imageAttempted = new Set<string>();

/** Prompt för bild-klassning: taxonomin + numrerade objekt (titel+text) vars BILDER följer i ordning. */
export function buildImageClassifyPrompt(items: LlmItem[]): string {
  const cut = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const tax = TAXONOMY.map(
    (m) => `${m.key}: ${m.label} → ${m.subs.map((s) => `${m.key}/${s.key} (${s.label})`).join(", ")}`,
  ).join("\n");
  const rows = items
    .map((it, i) => `${i}: "${cut(it.title, 140)}"${it.desc ? ` - ${cut(it.desc, 300)}` : ""}${it.house ? ` [hus: ${cut(it.house, 30)}]` : ""}`)
    .join("\n");
  return [
    "Du klassificerar svenska auktionsobjekt i en fast taxonomi utifrån BÅDE text och bild",
    "(bild 1 hör till objekt 0, bild 2 till objekt 1, osv i ordning). Välj för varje objekt",
    "den BÄSTA nyckeln på formen huvud/under ur listan nedan (exakt stavning).",
    "Blandade partier över flera helt olika kategorier → ovrigt/partier.",
    "Passar inget alls → ovrigt/diverse.",
    "",
    "TAXONOMI:",
    tax,
    "",
    "OBJEKT:",
    rows,
    "",
    "För varje objekt: k = taxonominyckel, n = antal LIKADANA huvudföremål i lotten -",
    "RÄKNA i bilden och läs texten (4 stolar → 4, ett par → 2, en byrå → 1; utelämna n om oklart).",
    ATTRS_INSTRUCTION,
    "Läs även märkesskyltar/loggor/modellbeteckningar SYNLIGA I BILDEN.",
    'Svara med ENDAST en kompakt JSON-array utan kodblock: [{"i":0,"k":"huvud/under","n":1,"b":"Ford","m":"Transit 1100","t":"veteranhusbil","y":1971},...] - en post per objekt.',
  ].join("\n");
}

export interface LlmImagePassResult {
  sent: number;
  classified: number;
  remaining: number; // kvarvarande ej-llm med bild
}

export interface VisionRow {
  house: string;
  external_id: string;
  title: string;
  description: string | null;
  /** Bild-URL, eller null (objekt helt utan bild) → text-klassas i samma batch. */
  image: string | null;
}

/**
 * Nästa bild+text-kandidater. includeLearned styr ekonomin:
 *  - true (bulk-ikappkörning): ÄVEN lexikon-klassade görs om → enhetligt LLM-facit på allt.
 *  - false (löpande underhåll): lexikonets 'learned' räknas som FÄRDIGT → ju mer eleven
 *    lärt sig, desto färre betalanrop behövs framöver (målet: nära noll).
 */
async function selectVisionCandidates(limit: number, includeLearned: boolean): Promise<VisionRow[]> {
  const { rows } = await pool.query<VisionRow>(
    `SELECT i.house, i.external_id, i.title, left(i.description, 400) AS description,
            (SELECT m.url FROM media m WHERE m.house=i.house AND m.owner_type='item'
               AND m.owner_external_id=i.external_id AND m.kind='image'
             ORDER BY m.sort NULLS LAST LIMIT 1) AS image
     FROM items i
     WHERE i.status='active' AND i.title IS NOT NULL
       AND (i.category_conf IS NULL OR i.category_conf <> 'llm')
       AND ($3 OR i.category_conf IS DISTINCT FROM 'learned')
       AND NOT (i.house || '/' || i.external_id = ANY($2::text[]))
     ORDER BY cat_conf_rank(i.category_conf) ASC, i.ends_at ASC NULLS LAST
     LIMIT $1`,
    [limit, [...imageAttempted], includeLearned],
  );
  return rows.filter((r) => r.image != null);
}

/** Skriv ett LLM-facit (kategori + antal i lotten) + samla till lexikonet. */
async function writeVerdict(
  r: { house: string; external_id: string; title: string },
  v: ClassifyVerdict,
  toLearn: { title: string; category: string }[],
): Promise<void> {
  // Även ovrigt/diverse skrivs - med full kontext ÄR det facit (omprövas ej i evighet).
  // lot_count: nytt värde vinner, annars behålls ev. tidigare (COALESCE). attrs: nya
  // belagda fält MERGAS in (gamla fält behålls); inga attrs → rör inte kolumnen.
  await pool.query(
    `UPDATE items SET category=$1, category_conf='llm', lot_count=COALESCE($4, lot_count),
            attrs=CASE WHEN $5::jsonb IS NOT NULL
                       THEN COALESCE(items.attrs, '{}'::jsonb) || $5::jsonb
                       ELSE items.attrs END
     WHERE house=$2 AND external_id=$3`,
    [v.key, r.house, r.external_id, v.n, v.attrs ? JSON.stringify(v.attrs) : null],
  );
  if (v.key !== "ovrigt/diverse" && v.key !== "ovrigt/partier") toLearn.push({ title: r.title, category: v.key });
}

/**
 * Kärnan: klassa EN batch rader med bild+text (exporterad - även classify-ended.ts
 * använder den). Objekt vars bild inte går att hämta (CDN nere/hotlink/för stor)
 * klassas på TEXTEN direkt - en oprövbar bild får inte blockera. Misslyckas
 * vision-anropet markeras raderna som försökta (annars ligger de kvar först i kön
 * och samma batch failar i evighet).
 */
export async function classifyVisionBatch(batch: VisionRow[]): Promise<{ sent: number; classified: number } | null> {
  if (batch.length === 0) return { sent: 0, classified: 0 };
  const fetched = await Promise.all(
    batch.map(async (r) => ({ r, url: r.image != null ? await toDataUrl(r.image, 900_000) : "" })),
  );
  // Bara riktiga data-URL:er skickas - rå-URL-fallback betyder att INTE ENS VI kunde
  // hämta bilden → leverantören lär inte heller kunna → text-klassa de raderna.
  const withImage = fetched.filter((f) => f.url.startsWith("data:"));
  const textOnly = fetched.filter((f) => !f.url.startsWith("data:")).map((f) => f.r);

  let classified = 0;
  const toLearn: { title: string; category: string }[] = [];

  if (textOnly.length > 0) {
    const t = await callLlm(buildClassifyPrompt(textOnly.map((r) => ({ title: r.title, desc: r.description, house: r.house }))));
    const v = t != null ? parseClassifyResponse(t, textOnly.length) : new Map<number, ClassifyVerdict>();
    for (let i = 0; i < textOnly.length; i++) {
      const verdict = v.get(i);
      if (verdict) {
        await writeVerdict(textOnly[i]!, verdict, toLearn);
        classified++;
      } else imageAttempted.add(`${textOnly[i]!.house}/${textOnly[i]!.external_id}`);
    }
  }

  if (withImage.length > 0) {
    const content: unknown[] = [
      {
        type: "text",
        text: buildImageClassifyPrompt(withImage.map((f) => ({ title: f.r.title, desc: f.r.description, house: f.r.house }))),
      },
      ...withImage.map((f) => ({ type: "image_url", image_url: { url: f.url } })),
    ];
    const text = await callVision(content);
    if (text == null) {
      // Markera så kön rullar vidare (nytt försök efter omstart); backoff sköts av anroparen.
      for (const f of withImage) imageAttempted.add(`${f.r.house}/${f.r.external_id}`);
      return null;
    }
    const verdicts = parseClassifyResponse(text, withImage.length);
    for (let i = 0; i < withImage.length; i++) {
      const r = withImage[i]!.r;
      const verdict = verdicts.get(i);
      if (verdict) {
        await writeVerdict(r, verdict, toLearn);
        classified++;
      } else imageAttempted.add(`${r.house}/${r.external_id}`);
      attempted.delete(`${r.house}/${r.external_id}`);
    }
  }
  await lexicon.learn(toLearn);
  return { sent: batch.length, classified };
}

async function remainingVision(): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) n FROM items WHERE status='active'
       AND (category_conf IS NULL OR category_conf <> 'llm')`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * HUVUDPASSET: bild+text-klassning av nästa batch aktiva objekt som inte är LLM-facit.
 * Resultat conf='llm' + lärs in i lexikonet. Null när nyckel saknas/alla modeller fallerar.
 */
export async function llmClassifyImagePass(limit = Number(process.env.AI_IMAGE_CLASSIFY_BATCH ?? 10)): Promise<LlmImagePassResult | null> {
  if (!process.env.OPENROUTER_API_KEY) return null;
  if (imageAttempted.size > 20_000) imageAttempted.clear();
  await lexicon.ensureLoaded();
  // Löpande underhåll: lexikonets 'learned' är färdigt → betala bara för det eleven inte kan.
  const batch = (await selectVisionCandidates(limit * 3, false)).slice(0, limit);
  if (batch.length === 0) return { sent: 0, classified: 0, remaining: await remainingVision() };
  const r = await classifyVisionBatch(batch);
  if (r == null) return null;
  return { ...r, remaining: await remainingVision() };
}

/**
 * Bulk-ikappkörning: hämtar stora kandidatsjok, kör `workers` batchar parallellt
 * (disjunkta - ingen dubbelklassning/dubbelkostnad). Rapporterar via onProgress.
 */
export async function visionClassifyBulk(opts: {
  workers?: number;
  batchSize?: number;
  onProgress?: (msg: string) => void;
} = {}): Promise<void> {
  const workers = opts.workers ?? 4;
  const batchSize = opts.batchSize ?? Number(process.env.AI_IMAGE_CLASSIFY_BATCH ?? 10);
  const log = opts.onProgress ?? (() => {});
  await lexicon.ensureLoaded();
  let total = 0;
  for (;;) {
    // Bulk = enhetligt facit: även lexikon-klassade görs om med bild+text.
    const candidates = await selectVisionCandidates(workers * batchSize * 10, true);
    if (candidates.length === 0) break;
    const chunks: VisionRow[][] = [];
    for (let i = 0; i < candidates.length; i += batchSize) chunks.push(candidates.slice(i, i + batchSize));
    let next = 0;
    let consecFails = 0; // TILLFÄLLIGA 429-svackor → backoff; bara ihållande fel avbryter
    let aborted = false;
    await Promise.all(
      Array.from({ length: Math.min(workers, chunks.length) }, async () => {
        for (;;) {
          if (aborted) return;
          const chunk = chunks[next++];
          if (!chunk) return;
          const r = await classifyVisionBatch(chunk);
          if (r == null) {
            consecFails++;
            if (consecFails >= 8) {
              aborted = true; // ihållande (budget slut/alla modeller nere) → avbryt snyggt
              return;
            }
            // Chunkens objekt markeras försökta → kön rullar vidare.
            log(`batch misslyckades [${lastCallError}] - backoff 20 s (${consecFails}/8)`);
            await new Promise((res) => setTimeout(res, 20_000));
            continue;
          }
          consecFails = 0;
          total += r.classified;
        }
      }),
    );
    const rem = await remainingVision();
    log(`bild+text-klassning: ${total} klassade totalt, ~${rem} kvar (lexikon ${lexicon.size()} tokens, förbrukning $${(await currentUsage()).toFixed(2)})`);
    if (aborted) {
      log("ihållande fel (budgettak/alla modeller nere) - avbryter (schemaläggaren fortsätter i lugn takt)");
      break;
    }
  }
}
