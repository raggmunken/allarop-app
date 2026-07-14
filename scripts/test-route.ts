/** Offline-test av ruttlösaren (tvingar haversine via oåtkomlig OSRM). Kör:
 *   npx tsx scripts/test-route.ts */
process.env.OSRM_URL = "http://localhost:1"; // connection refused direkt → haversine
delete process.env.ORS_API_KEY;
import { optimizeRoute } from "../src/route/optimize.ts";

const fmt = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;

const r = await optimizeRoute({
  depot: { label: "Hem (Sthlm)", lat: 59.33, lon: 18.07 },
  stops: [
    { label: "Uppsala", lat: 59.86, lon: 17.64, service: 15, windowStart: 60, windowEnd: 120 },
    { label: "Södertälje", lat: 59.2, lon: 17.63, service: 10 },
    { label: "Västerås", lat: 59.61, lon: 16.55, service: 20 },
    { label: "Enköping", lat: 59.64, lon: 17.08, service: 5 },
  ],
  returnToStart: true,
  startTime: "08:00",
});

console.log(`source=${r.source}  totalDist=${(r.totalDistance / 1000).toFixed(1)}km  travel=${r.travelDuration}min  total=${r.totalDuration}min`);
let mono = true, prev = -1;
for (const s of r.stops) {
  console.log(`  #${s.seq} ${s.label.padEnd(14)} ank ${fmt(s.arrival)} ${s.wait ? `vänta ${s.wait}m ` : ""}svc ${s.service}m avr ${fmt(s.departure)} leg ${(s.legDistance / 1000).toFixed(1)}km${s.late ? "  SENT!" : ""}`);
  if (s.arrival < prev - 0.01) mono = false;
  prev = s.arrival;
}
const nonDepot = r.stops.filter((s) => !s.depot).length;
console.log("monoton tidslinje:", mono);
console.log("depå först+sist:", r.stops[0]!.depot === true && r.stops[r.stops.length - 1]!.depot === true);
console.log("alla 4 stopp med:", nonDepot === 4);
process.exit(0);
