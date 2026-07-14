/**
 * Junora slagavgift - UNGEFÄRLIG modell. Avgiften publiceras inte; den syns bara
 * inloggat och beräknas i deras klient. Vi bevisade (logged-in harvest) att den är
 * DETERMINISTISK på reservationspriset (inte bud, inte kategori, inte moms), med ett
 * golv på ~130 kr och inget tak - en regressiv trapp-tabell (avgift ~ 131 x n).
 *
 * Nedan: empiriskt harvestade (reservpris -> slagavgift)-punkter. Mellan punkterna
 * linjärinterpolerar vi → en UNGEFÄRLIG avgift (UI markerar totalen med "≈"). Värdet
 * tolkas som det köparen betalar i slagavgift (inkl. ev. moms) → läggs på rakt.
 *
 * Harvestat 2026-06-29 (inloggad browser). Fler punkter → bättre approximation.
 */

/** Sorterade (reservpris, slagavgift)-par. Avgiften är icke-avtagande i reservpriset. */
const TABLE: ReadonlyArray<readonly [number, number]> = [
  [0, 130], [100, 130], [250, 130],
  [500, 265], [1000, 265], [2000, 265],
  [3000, 525], [4000, 525],
  [5500, 790], [7000, 790], [8000, 895], [9000, 1050],
  [11500, 1310], [14000, 1310],
  [16000, 1840], [18000, 1840],
  [20000, 2100], [24000, 2100],
  [25000, 2785], [28000, 2785],
  [32500, 3415], [40000, 3415],
  [50000, 4465], [60000, 4465],
  [65000, 5515], [97200, 5515],
  [108000, 6565], [120000, 6565],
  [160000, 7090], [200000, 7770], [225000, 8085],
  [490000, 12390], [2650000, 37485],
];

/**
 * Ungefärlig slagavgift (kr) för ett givet reservpris, via linjärinterpolation över
 * de harvestade punkterna. Under tabellens golv → golvavgiften; över taket →
 * extrapolering med sista segmentets lutning. null om reservpriset saknas/orimligt.
 */
export function slagavgiftForReserve(reserve: number | null | undefined): number | null {
  if (reserve == null || !Number.isFinite(reserve) || reserve < 0) return null;
  const first = TABLE[0]!;
  const last = TABLE[TABLE.length - 1]!;
  if (reserve <= first[0]) return first[1];
  if (reserve >= last[0]) {
    // Extrapolera med sista segmentets lutning (avgiften fortsätter stiga, inget tak).
    const prev = TABLE[TABLE.length - 2]!;
    const slope = (last[1] - prev[1]) / (last[0] - prev[0]);
    return Math.round(last[1] + (reserve - last[0]) * slope);
  }
  for (let i = 1; i < TABLE.length; i++) {
    const lo = TABLE[i - 1]!;
    const hi = TABLE[i]!;
    if (reserve <= hi[0]) {
      const t = (reserve - lo[0]) / (hi[0] - lo[0]);
      return Math.round(lo[1] + t * (hi[1] - lo[1]));
    }
  }
  return last[1];
}
