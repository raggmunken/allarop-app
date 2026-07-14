/**
 * Minimal parser för React Server Components "Flight"-formatet som Tovek
 * returnerar (Content-Type: text/x-component) från sina Next.js Server Actions.
 *
 * Formatet är en ström av "rows" på formen `<id>:<payload>`:
 *   - JSON-row:  `1:{"auctions":[...]}`        (avslutas av radbrytning)
 *   - Text-row:  `2:T835,<råtext om 0x835 byte>` (längd-delimiterad, kan
 *                innehålla radbrytningar och kommatecken)
 *
 * Värden kan referera andra rows:
 *   - "$@1"  → (lat) referens till row 1
 *   - "$2"   → referens till row 2 (t.ex. en textblob)
 *   - "$$x"  → escapead literal som blir strängen "$x"
 *
 * Server Action-svaret lägger sitt returvärde i row "0" fält "a", t.ex.
 *   0:{"a":"$@1","f":"","b":"..."}
 * så det faktiska resultatet nås via den referensen.
 *
 * Vi parsar över UTF-8-bytes eftersom T-längden anges i byte (svenska tecken
 * som å/ä/ö är 2 byte i UTF-8 men 1 kodenhet i en JS-sträng).
 */

const COLON = 0x3a; // ':'
const COMMA = 0x2c; // ','
const NEWLINE = 0x0a; // '\n'
const T_TAG = 0x54; // 'T'

export type FlightChunks = Map<string, unknown>;

/** Parsa en hel Flight-respons till en map: row-id → råvärde (oresolverad). */
export function parseFlight(input: string | Buffer): FlightChunks {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  const chunks: FlightChunks = new Map();
  let pos = 0;
  const len = buf.length;

  while (pos < len) {
    // Hoppa över ev. inledande radbrytningar.
    if (buf[pos] === NEWLINE) {
      pos++;
      continue;
    }

    const colon = buf.indexOf(COLON, pos);
    if (colon === -1) break;
    const id = buf.toString("utf8", pos, colon);
    pos = colon + 1;

    if (buf[pos] === T_TAG) {
      // Text-row: T<hexlen>,<bytes>
      pos++; // hoppa 'T'
      const comma = buf.indexOf(COMMA, pos);
      const byteLen = parseInt(buf.toString("ascii", pos, comma), 16);
      pos = comma + 1;
      const text = buf.toString("utf8", pos, pos + byteLen);
      chunks.set(id, text);
      pos += byteLen;
      if (buf[pos] === NEWLINE) pos++;
    } else {
      // JSON-row: läs till radbrytning.
      let nl = buf.indexOf(NEWLINE, pos);
      if (nl === -1) nl = len;
      const raw = buf.toString("utf8", pos, nl).trim();
      if (raw.length > 0) {
        try {
          chunks.set(id, JSON.parse(raw));
        } catch {
          // Lämna oparsat råvärde om det inte är giltig JSON.
          chunks.set(id, raw);
        }
      }
      pos = nl + 1;
    }
  }

  return chunks;
}

/**
 * Lös upp referenser (`$N`, `$@N`, `$$x`) rekursivt mot chunk-mappen.
 * Cyklar skyddas via `seen`.
 */
export function resolveValue(
  value: unknown,
  chunks: FlightChunks,
  seen: Set<string> = new Set(),
): unknown {
  if (typeof value === "string") {
    if (value.startsWith("$")) {
      // Escapead literal: "$$foo" → "$foo"
      if (value.startsWith("$$")) return value.slice(1);
      // Referens: "$@1", "$1", "$L1" m.fl. Plocka ut row-id (siffror/hex).
      const ref = value.startsWith("$@") ? value.slice(2) : value.slice(1);
      // Specialvärden vi inte bryr oss om → null.
      if (/^[0-9a-f]+$/i.test(ref)) {
        if (seen.has(ref)) return null;
        seen.add(ref);
        if (chunks.has(ref)) {
          return resolveValue(chunks.get(ref), chunks, seen);
        }
        return null;
      }
      // t.ex. "$undefined" → null
      return null;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, chunks, new Set(seen)));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, chunks, new Set(seen));
    }
    return out;
  }

  return value;
}

/**
 * Hämta ett Server Action-svars faktiska returvärde, fullt resolverat.
 * Letar i row "0" efter fältet "a" (referens till resultatet); faller annars
 * tillbaka på row "1" och därefter row "0" självt.
 */
export function getActionResult(input: string | Buffer): unknown {
  const chunks = parseFlight(input);
  const row0 = chunks.get("0");
  if (row0 && typeof row0 === "object" && "a" in (row0 as object)) {
    return resolveValue((row0 as { a: unknown }).a, chunks);
  }
  if (chunks.has("1")) return resolveValue(chunks.get("1"), chunks);
  if (row0 !== undefined) return resolveValue(row0, chunks);
  return null;
}
