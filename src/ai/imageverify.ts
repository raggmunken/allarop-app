/**
 * AI-bildverifiering av prisjämförelser: "är objekt A och B samma typ av föremål?"
 * Bedöms av en GRATIS vision-modell via OpenRouter (bild + titel för båda objekten).
 * Kräver OPENROUTER_API_KEY (gratis konto på openrouter.ai). Utan nyckel → null (av).
 *
 * Modellval (gratis, vision, juli 2026 - env-styrbart via OPENROUTER_VISION_MODEL):
 * google/gemma-4-31b-it:free (bäst) med fallback till mindre gratis VL-modeller vid
 * rate-limit/fel. Gratisnivån är hårt rate-limitad (~20 anrop/min) → anropen är få
 * (topp-N per objekt), sekventiellt begränsade, och verdikten CACHAS permanent i
 * match_verdicts (ett par bedöms EN gång, någonsin).
 *
 * Bilderna hämtas server-side och skickas som data-URL:er - auktionshusens CDN:er
 * hotlink-skyddar/bot-blockerar ibland, och OpenRouters egna fetch får inte vara
 * felkällan. För stora bilder (>2,5 MB) skickas URL:en i stället.
 */

import { PAID_MODEL, paidAllowed } from "./budget.ts";

const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
// Betald billig vision-modell först (snabb + träffsäker, ~0,2 öre/par); gratis som
// fallback och när budgetvakten slår till.
const MODELS = [
  process.env.OPENROUTER_VISION_MODEL,
  PAID_MODEL,
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-nano-12b-v2-vl:free",
].filter((m): m is string => !!m);

const MAX_IMAGE_BYTES = 2_500_000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface VerifyInput {
  title: string;
  image: string; // bild-URL
  desc?: string | null;
}

export interface MatchVerdict {
  same: boolean;
  reason: string;
  model: string;
}

export function hasApiKey(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

/** Hämta bild → data-URL (undviker CDN-hotlink-skydd). Stor/ohämtbar → originet-URL. */
export async function toDataUrl(url: string, maxBytes = MAX_IMAGE_BYTES): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return url;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) return url;
    const ct = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];
    if (!ct?.startsWith("image/")) return url;
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return url;
  }
}

function buildPrompt(a: VerifyInput, b: VerifyInput): string {
  const cut = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return [
    "Du jämför två svenska auktionsannonser för PRISSTATISTIK. Avgör om det är SAMMA TYP av föremål",
    "(samma sak/modell/variant och jämförbart antal - t.ex. är NES-spelstillbehör INTE samma som svetstillbehör,",
    "och 4 stolar är inte samma som 1 stol). Första bilden = objekt A, andra bilden = objekt B.",
    `Objekt A: "${cut(a.title)}"${a.desc ? ` - ${cut(a.desc)}` : ""}`,
    `Objekt B: "${cut(b.title)}"${b.desc ? ` - ${cut(b.desc)}` : ""}`,
    'Svara med ENDAST kompakt JSON utan kodblock: {"same": true|false, "reason": "kort svensk motivering (max 12 ord)"}',
  ].join("\n");
}

function parseVerdict(text: string, model: string): MatchVerdict | null {
  const m = /\{[^{}]*"same"\s*:\s*(true|false)[^{}]*\}/i.exec(text);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { same?: boolean; reason?: string };
    if (typeof j.same !== "boolean") return null;
    return { same: j.same, reason: String(j.reason ?? "").slice(0, 200), model };
  } catch {
    return null;
  }
}

/**
 * Bedöm ETT par (A = målet, B = jämförelsen). Null vid saknad nyckel, rate-limit eller
 * obrukbart svar från alla modeller - anroparen cachar då INGET och kan försöka senare.
 */
export async function verifySameObject(a: VerifyInput, b: VerifyInput): Promise<MatchVerdict | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const [imgA, imgB] = await Promise.all([toDataUrl(a.image), toDataUrl(b.image)]);
  const content = [
    { type: "text", text: buildPrompt(a, b) },
    { type: "image_url", image_url: { url: imgA } },
    { type: "image_url", image_url: { url: imgB } },
  ];
  // Budgetvakt: över taket → bara gratis-modeller kvar i kedjan.
  const usable = (await paidAllowed()) ? MODELS : MODELS.filter((m) => m.endsWith(":free"));
  for (const model of usable) {
    try {
      const res = await fetch(OR_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://allarop.local",
          "X-Title": "Allarop prisjamforelse",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content }],
          max_tokens: 120,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (res.status === 429) continue; // rate-limitad → prova nästa gratis-modell
      if (!res.ok) continue;
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = j.choices?.[0]?.message?.content ?? "";
      const verdict = parseVerdict(text, model);
      if (verdict) return verdict;
    } catch {
      /* timeout/nätfel → prova nästa modell */
    }
  }
  return null;
}
