/**
 * Budgetvakt för OpenRouter: betalmodellen (billig, stark) används av klassningen,
 * sök-expansionen och bildgranskningen - men ALDRIG förbi taket. total_usage hämtas
 * från /credits (5 min cache); över AI_USAGE_MAX_USD → anroparna faller tillbaka till
 * gratis-modellerna. Baslinje 13,15 USD vid start 2026-07-05 + användarens max 15 → 28.
 */

export const PAID_MODEL = process.env.OPENROUTER_PAID_MODEL ?? "google/gemini-2.5-flash-lite";

/**
 * Taket läses LAT (vid anrop, inte vid import): ES-imports hoistas före modulkod, så
 * scriptens inline .env-laddare hinner inte sätta AI_USAGE_MAX_USD innan modulen
 * initieras - en modul-konstant frös taket på defaulten 28 i alla tsx-scripts
 * (upptäckt 2026-07-06 när förbrukningen passerade $28 och betalmodellen tvärdog
 * i scripten trots höjt tak i .env; Docker-containrarna påverkades inte - compose
 * sätter env före processstart).
 */
const usageMaxUsd = (): number => Number(process.env.AI_USAGE_MAX_USD ?? 28);

let usageCache = { at: 0, usage: 0 };

/** Kontots totala förbrukning (USD), cachad 5 min. 0 vid fel/saknad nyckel. */
export async function currentUsage(): Promise<number> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return 0;
  if (Date.now() - usageCache.at > 300_000) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const j = (await res.json()) as { data?: { total_usage?: number } };
        usageCache = { at: Date.now(), usage: Number(j.data?.total_usage ?? 0) };
      } else {
        usageCache = { at: Date.now(), usage: usageCache.usage };
      }
    } catch {
      usageCache = { at: Date.now(), usage: usageCache.usage };
    }
  }
  return usageCache.usage;
}

/** Får betalmodeller användas? Fel vid hämtning → ja (gratiskedjan finns ändå bakom). */
export async function paidAllowed(): Promise<boolean> {
  return (await currentUsage()) < usageMaxUsd();
}
