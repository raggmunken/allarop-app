/**
 * Självlärande klassningslexikon - "eleven" som lär sig av LLM:ens beslut ("läraren").
 * Varje LLM-klassning lär lexikonet titelns tokens → kategori (learned_tokens). Ett nytt
 * objekt vars tokens tydligt pekar på EN kategori klassas direkt ur minnet (conf
 * 'learned') utan API-anrop - så systemet blir bättre och billigare för varje beslut.
 *
 * Konservativa trösklar (hellre LLM-kö än fel): vinnaren måste ha ≥ MIN_EVIDENCE
 * observationer OCH ≥ MIN_SHARE av rösterna. Env-styrbara.
 */

import { pool } from "../db/pool.ts";

const MIN_EVIDENCE = Number(process.env.LEARNED_MIN_EVIDENCE ?? 12);
const MIN_SHARE = Number(process.env.LEARNED_MIN_SHARE ?? 0.75);
const RELOAD_MS = Number(process.env.LEARNED_RELOAD_MS ?? 600_000); // 10 min

/** Stoppord som bär noll kategorisignal (vanliga i auktionstitlar). Mått-/storleks-/
 * skickord är viktiga att stoppa - de finns i ALLA kategorier och förgiftar rösterna
 * (verifierat: "stl"/"bredd" i en ringtitel röstade mot kläder). */
const STOP = new Set([
  "och", "med", "för", "från", "samt", "utan", "till", "the", "and",
  "st", "styck", "stycken", "par", "set", "div", "diverse", "objekt",
  "auktion", "parti", "obs", "inkl", "exkl", "cirka", "över", "under",
  "stl", "strl", "storlek", "bredd", "höjd", "hojd", "längd", "langd",
  "djup", "diameter", "vikt", "mått", "matt", "gram", "skick", "nyskick",
  "begagnad", "begagnat", "oanvänd", "oanvänt", "fungerande", "testad",
]);

/** Normalisera titel → betydelsebärande tokens (gemener, ≥3 tecken, dedupe, max 12). */
export function tokensOf(title: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of title.toLowerCase().split(/[^a-zåäöéü]+/)) {
    const t = raw.trim();
    if (t.length < 3 || STOP.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

export interface LearnedHit {
  category: string;
  evidence: number; // vinnarens observationer
  share: number; // vinnarens andel av alla röster
}

/** Ren röstning över en token→kategori→seen-karta (testbar utan DB).
 *
 * KONCENTRATIONSVIKTNING: varje tokens röst skalas med hur KONCENTRERAD den är (top-
 * kategorins andel av tokenens observationer). Ett särskiljande ord ("metallica" 96 %
 * media/vinyl) väger tungt; ett generiskt ord ("master", spritt över tio kategorier)
 * dämpas - annars drog generiska ord ner den starka signalens ANDEL under MIN_SHARE
 * ("Metallica Master of Puppets" klassades ej trots metallica→vinyl 213). MIN_EVIDENCE
 * mäts fortfarande på RÅA observationer (viktade talen är småbrutna). */
export function voteTokens(
  tokens: string[],
  lex: Map<string, Map<string, number>>,
): LearnedHit | null {
  const votes = new Map<string, number>();
  let total = 0;
  for (const t of tokens) {
    const dist = lex.get(t);
    if (!dist) continue;
    let tokTotal = 0, tokMax = 0;
    for (const seen of dist.values()) { tokTotal += seen; if (seen > tokMax) tokMax = seen; }
    const conc = tokTotal > 0 ? tokMax / tokTotal : 0; // 0..1
    for (const [cat, seen] of dist) {
      const w = seen * conc;
      votes.set(cat, (votes.get(cat) ?? 0) + w);
      total += w;
    }
  }
  if (total === 0) return null;
  let winCat = "";
  let winVotes = 0;
  for (const [cat, v] of votes) if (v > winVotes) { winCat = cat; winVotes = v; }
  const share = winVotes / total;
  // Vinnarens RÅA observationssumma över frågans tokens (för MIN_EVIDENCE-gaten).
  let winRaw = 0;
  for (const t of tokens) { const d = lex.get(t); if (d?.has(winCat)) winRaw += d.get(winCat)!; }
  if (winRaw < MIN_EVIDENCE || share < MIN_SHARE) return null;
  return { category: winCat, evidence: winRaw, share };
}

class Lexicon {
  private map = new Map<string, Map<string, number>>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  /** Ladda/uppdatera från DB (cachas RELOAD_MS; parallella anrop delar samma load). */
  async ensureLoaded(): Promise<void> {
    if (Date.now() - this.loadedAt < RELOAD_MS) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const res = await pool.query<{ token: string; category: string; seen: number }>(
          "SELECT token, category, seen FROM learned_tokens",
        );
        const next = new Map<string, Map<string, number>>();
        for (const r of res.rows) {
          let dist = next.get(r.token);
          if (!dist) next.set(r.token, (dist = new Map()));
          dist.set(r.category, Number(r.seen));
        }
        this.map = next;
        this.loadedAt = Date.now();
      } catch {
        this.loadedAt = Date.now() - RELOAD_MS + 60_000; // fel → nytt försök om 1 min
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Klassa ur minnet (kräver ensureLoaded först). Null = ej tillräcklig evidens. */
  classify(title: string): LearnedHit | null {
    return voteTokens(tokensOf(title), this.map);
  }

  /** Lär in LLM-beslut: titelns tokens → kategori. Batchad upsert + uppdatera minnet. */
  async learn(entries: { title: string; category: string }[]): Promise<void> {
    const rows: { token: string; category: string }[] = [];
    for (const e of entries) for (const t of tokensOf(e.title)) rows.push({ token: t, category: e.category });
    if (rows.length === 0) return;
    // ORDER BY → alla samtidiga writers låser raderna i samma ordning (annars
    // deadlock 40P01 när parallella vision-workers upsertar överlappande tokens).
    // Retry som hängsle - deadlock kan ändå uppstå mot ANDRA frågor på tabellen.
    for (let attempt = 1; ; attempt++) {
      try {
        await pool.query(
          `INSERT INTO learned_tokens (token, category, seen)
           SELECT t, c, count(*) FROM unnest($1::text[], $2::text[]) AS u(t, c)
           GROUP BY t, c ORDER BY t, c
           ON CONFLICT (token, category) DO UPDATE SET seen = learned_tokens.seen + EXCLUDED.seen`,
          [rows.map((r) => r.token), rows.map((r) => r.category)],
        );
        break;
      } catch (e) {
        if ((e as { code?: string }).code === "40P01" && attempt < 3) {
          await new Promise((r) => setTimeout(r, 100 * attempt + Math.random() * 200));
          continue;
        }
        throw e;
      }
    }
    // Spegla direkt i minnet så nästa pass i samma process ser den nya kunskapen.
    for (const r of rows) {
      let dist = this.map.get(r.token);
      if (!dist) this.map.set(r.token, (dist = new Map()));
      dist.set(r.category, (dist.get(r.category) ?? 0) + 1);
    }
  }

  /** Antal kända tokens (för loggning). */
  size(): number {
    return this.map.size;
  }
}

/** Process-singleton (scheduler + api delar mönstret; laddas lat, uppdateras var 10:e min). */
export const lexicon = new Lexicon();
