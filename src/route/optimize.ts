/**
 * Ruttoptimering ("RouteXL fast eget och gratis"). Användaren fyller i startpunkt +
 * stopp (adress eller koordinat, ev. servicetid och tidsfönster); vi räknar bästa
 * ordning + en tidslinje + FAKTISK vägrutt.
 *
 * TVÅ motorer:
 *   1. OpenRouteService /optimization (VROOM) - om ORS_API_KEY finns. Äkta VRPTW: hårda
 *      tidsfönster, servicetid, och optimeraren VÄLJER starttid (fönstren respekteras,
 *      total tid inkl. väntan minimeras) + riktig väggeometri. Detta är förstahandsvalet.
 *   2. Lokal fallback (om ingen nyckel): OSRM/haversine-matris + nearest-neighbor + 2-opt
 *      (enkel-bil-TSP). Tidsfönster FLAGGAS men tvingar ej om ordningen; väggeometri via OSRM.
 *
 * Källan rapporteras (source) så UI:t vet hur exakt rutten är - aldrig fejkad precision.
 */

import { geocodeAddress } from "../geo/geocode.ts";

const ORS_KEY = process.env.ORS_API_KEY || "";
const AVG_MS = Number(process.env.ROUTE_AVG_KMH ?? 70) / 3.6; // m/s för haversine-fallback
const OSRM = process.env.OSRM_URL || "https://router.project-osrm.org";

export interface RouteStopIn {
  label: string;
  lat?: number;
  lon?: number;
  address?: string;
  service?: number; // minuter på plats
  windowStart?: number; // absoluta minuter på dygnet, öppnar (t.ex. 13:00 = 780)
  windowEnd?: number; // absoluta minuter på dygnet, stänger
  house?: string;
  id?: string;
}

export interface RouteReqIn {
  depot: { label?: string; lat?: number; lon?: number; address?: string };
  stops: RouteStopIn[];
  returnToStart?: boolean;
  startTime?: string; // "HH:MM", default 08:00
  autoStart?: boolean; // låt optimeraren välja starttid (kräver ORS)
}

export interface RouteStopOut {
  seq: number;
  label: string;
  lat: number;
  lon: number;
  depot?: boolean;
  house?: string;
  id?: string;
  arrival: number; // absoluta minuter på dygnet (körankomst, före ev. väntan)
  wait: number; // väntan om vi kommer före öppning
  service: number;
  departure: number;
  legDistance: number; // meter från föregående
  legDuration: number; // minuter från föregående
  late: boolean; // ankom efter windowEnd (bara lokal fallback; ORS tvingar in i fönstret)
}

export interface RouteResult {
  ok: true;
  source: "ors" | "osrm" | "estimering";
  startTime: string;
  returnToStart: boolean;
  autoStart: boolean;
  stops: RouteStopOut[];
  geometry: [number, number][]; // [lat,lon] faktisk vägrutt
  unassigned: string[]; // stopp som inte kunde schemaläggas inom sina tidsfönster
  totalDistance: number; // meter
  travelDuration: number; // minuter (enbart körning)
  totalDuration: number; // minuter (körning + service + väntan)
}

interface Pt {
  lat: number;
  lon: number;
  label: string;
  service: number;
  windowStart?: number;
  windowEnd?: number;
  depot: boolean;
  house?: string;
  id?: string;
}

interface Matrix {
  dur: number[][]; // sekunder
  dist: number[][]; // meter
  source: "ors" | "osrm" | "estimering";
}

const R = 6371000;
function haversine(a: Pt, b: Pt): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Google-encoded polyline (precision 5) → [lat,lon][]. ORS/OSRM-geometri. */
function decodePolyline(str: string, precision = 5): [number, number][] {
  const factor = Math.pow(10, precision);
  let i = 0, lat = 0, lon = 0;
  const out: [number, number][] = [];
  while (i < str.length) {
    let result = 0, shift = 0, b: number;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0; shift = 0;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

function haversineMatrix(pts: Pt[]): Matrix {
  const n = pts.length;
  const dur: number[][] = [], dist: number[][] = [];
  for (let i = 0; i < n; i++) {
    dur[i] = []; dist[i] = [];
    for (let j = 0; j < n; j++) {
      const m = i === j ? 0 : haversine(pts[i]!, pts[j]!) * 1.3; // 1.3 = grov vägomväg
      dist[i]![j] = m;
      dur[i]![j] = m / AVG_MS;
    }
  }
  return { dur, dist, source: "estimering" };
}

/** OSRM table-tjänst: hela matrisen i ett anrop. null → fallback. */
async function osrmMatrix(pts: Pt[]): Promise<Matrix | null> {
  try {
    const coords = pts.map((p) => `${p.lon},${p.lat}`).join(";");
    const url = `${OSRM}/table/v1/driving/${coords}?annotations=duration,distance`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { durations?: number[][]; distances?: number[][] };
    if (!j.durations || !j.distances) return null;
    return { dur: j.durations, dist: j.distances, source: "osrm" };
  } catch {
    return null;
  }
}

async function buildMatrix(pts: Pt[]): Promise<Matrix> {
  return (await osrmMatrix(pts)) ?? haversineMatrix(pts);
}

/** OSRM route-geometri för en ordnad punktsekvens → [lat,lon][]. [] = misslyckades. */
async function osrmGeometry(ordered: Pt[]): Promise<[number, number][]> {
  try {
    const coords = ordered.map((p) => `${p.lon},${p.lat}`).join(";");
    const url = `${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const j = (await res.json()) as { routes?: { geometry?: { coordinates?: [number, number][] } }[] };
    const coordsOut = j.routes?.[0]?.geometry?.coordinates;
    return Array.isArray(coordsOut) ? coordsOut.map(([lon, lat]) => [lat, lon] as [number, number]) : [];
  } catch {
    return [];
  }
}

/** Kostnad (sekunder) för en ordning. order[0] är alltid depån (fast start). */
function cost(order: number[], dur: number[][], closed: boolean): number {
  let c = 0;
  for (let i = 0; i < order.length - 1; i++) c += dur[order[i]!]![order[i + 1]!]!;
  if (closed && order.length > 1) c += dur[order[order.length - 1]!]![order[0]!]!;
  return c;
}

function nearestNeighbor(n: number, dur: number[][]): number[] {
  const seen = new Array(n).fill(false);
  const order = [0];
  seen[0] = true;
  for (let step = 1; step < n; step++) {
    const cur = order[order.length - 1]!;
    let best = -1, bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (!seen[j] && dur[cur]![j]! < bestD) { bestD = dur[cur]![j]!; best = j; }
    }
    order.push(best); seen[best] = true;
  }
  return order;
}

function twoOpt(order: number[], dur: number[][], closed: boolean): number[] {
  let best = order.slice();
  let bestCost = cost(best, dur, closed);
  let improved = true, guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const c = cost(cand, dur, closed);
        if (c + 1e-6 < bestCost) { best = cand; bestCost = c; improved = true; }
      }
    }
  }
  return best;
}

async function resolvePoint(
  p: { label?: string; lat?: number; lon?: number; address?: string; service?: number; windowStart?: number; windowEnd?: number; house?: string; id?: string },
  fallbackLabel: string,
  depot: boolean,
): Promise<Pt> {
  let lat = p.lat, lon = p.lon;
  if ((lat == null || lon == null) && p.address) {
    const g = await geocodeAddress(p.address);
    if (g) { lat = g.lat; lon = g.lon; }
  }
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`Kunde inte hitta koordinat för "${p.label || p.address || fallbackLabel}"`);
  }
  return {
    lat, lon,
    label: p.label || p.address || fallbackLabel,
    service: Math.max(0, p.service ?? 0),
    windowStart: p.windowStart,
    windowEnd: p.windowEnd,
    depot,
    house: p.house,
    id: p.id,
  };
}

function parseStart(hhmm?: string): { min: number; str: string } {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || "").trim());
  const h = m ? Math.min(23, Number(m[1])) : 8;
  const mm = m ? Math.min(59, Number(m[2])) : 0;
  return { min: h * 60 + mm, str: `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}` };
}

const clockStr = (min: number): string => {
  const m = Math.round(((min % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/**
 * ORS /optimization (VROOM). Löser äkta VRPTW: hårda tidsfönster + servicetid, och
 * optimeraren väljer starttid (om autoStart). Returnerar full RouteResult inkl. geometri.
 * null → nyckel saknas/fel → anroparen faller tillbaka till lokala lösaren.
 */
async function orsOptimize(
  depot: Pt, stops: Pt[], closed: boolean, startMin: number, autoStart: boolean,
): Promise<RouteResult | null> {
  if (!ORS_KEY) return null;
  try {
    const jobs = stops.map((s, i) => {
      const j: Record<string, unknown> = {
        id: i + 1,
        location: [s.lon, s.lat],
        service: Math.round(s.service * 60),
      };
      if (s.windowStart != null || s.windowEnd != null) {
        j.time_windows = [[Math.round((s.windowStart ?? 0) * 60), Math.round((s.windowEnd ?? 1440) * 60)]];
      }
      return j;
    });
    const vehicle: Record<string, unknown> = {
      id: 1,
      profile: "driving-car",
      start: [depot.lon, depot.lat],
      // autoStart → hela dygnet (VROOM väljer avgång); annars tidigast vid starttiden.
      time_window: autoStart ? [0, 24 * 3600] : [startMin * 60, 24 * 3600],
    };
    if (closed) vehicle.end = [depot.lon, depot.lat];
    const res = await fetch("https://api.openrouteservice.org/optimization", {
      method: "POST",
      headers: { Authorization: ORS_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ jobs, vehicles: [vehicle], options: { g: true } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      routes?: { distance: number; duration: number; geometry?: string; steps: {
        type: string; id?: number; arrival: number; duration: number; distance: number;
        service?: number; waiting_time?: number;
      }[] }[];
      unassigned?: { id: number }[];
    };
    const route = j.routes?.[0];
    if (!route?.steps?.length) return null;

    const out: RouteStopOut[] = [];
    let prevDur = 0, prevDist = 0, seq = 0;
    for (const st of route.steps) {
      const legDuration = Math.max(0, (st.duration - prevDur) / 60);
      const legDistance = Math.max(0, st.distance - prevDist);
      prevDur = st.duration; prevDist = st.distance;
      const arrival = st.arrival / 60;
      if (st.type === "job" && st.id != null) {
        const s = stops[st.id - 1]!;
        const wait = (st.waiting_time ?? 0) / 60;
        const service = (st.service ?? 0) / 60;
        out.push({
          seq: ++seq, label: s.label, lat: s.lat, lon: s.lon, house: s.house, id: s.id,
          arrival, wait, service, departure: arrival + wait + service,
          legDistance, legDuration, late: false, // ORS respekterar fönstret hårt
        });
      } else {
        // start/end = depån
        out.push({
          seq: st.type === "start" ? 0 : out.length, label: depot.label, lat: depot.lat, lon: depot.lon,
          depot: true, arrival, wait: 0, service: 0, departure: arrival,
          legDistance, legDuration, late: false,
        });
      }
    }
    const first = out[0]!, last = out[out.length - 1]!;
    const unassigned = (j.unassigned ?? [])
      .map((u) => stops[u.id - 1]?.label)
      .filter((x): x is string => x != null);
    return {
      ok: true,
      source: "ors",
      startTime: clockStr(first.arrival),
      returnToStart: closed,
      autoStart,
      stops: out,
      geometry: route.geometry ? decodePolyline(route.geometry, 5) : [],
      unassigned,
      totalDistance: Math.round(route.distance),
      travelDuration: Math.round(route.duration / 60),
      totalDuration: Math.round(last.arrival - first.arrival),
    };
  } catch {
    return null;
  }
}

/** Lokal lösare (ingen ORS-nyckel): matris → nearest-neighbor + 2-opt + tidslinje. */
async function localSolve(
  depot: Pt, stops: Pt[], closed: boolean, startMin: number,
): Promise<RouteResult> {
  const pts = [depot, ...stops];
  const matrix = await buildMatrix(pts);
  const order = twoOpt(nearestNeighbor(pts.length, matrix.dur), matrix.dur, closed);

  const out: RouteStopOut[] = [];
  let clock = startMin, totalDist = 0, travel = 0;
  out.push({
    seq: 0, label: depot.label, lat: depot.lat, lon: depot.lon, depot: true,
    arrival: startMin, wait: 0, service: 0, departure: startMin, legDistance: 0, legDuration: 0, late: false,
  });
  for (let k = 1; k < order.length; k++) {
    const from = order[k - 1]!, to = order[k]!;
    const p = pts[to]!;
    const legMin = matrix.dur[from]![to]! / 60;
    const legM = matrix.dist[from]![to]!;
    travel += legMin; totalDist += legM;
    const arrival = clock + legMin;
    const wait = p.windowStart != null && arrival < p.windowStart ? p.windowStart - arrival : 0;
    const startService = arrival + wait;
    const departure = startService + p.service;
    out.push({
      seq: k, label: p.label, lat: p.lat, lon: p.lon, house: p.house, id: p.id,
      arrival, wait, service: p.service, departure,
      legDistance: legM, legDuration: legMin,
      late: p.windowEnd != null && startService > p.windowEnd,
    });
    clock = departure;
  }
  if (closed) {
    const from = order[order.length - 1]!;
    const legMin = matrix.dur[from]![0]! / 60, legM = matrix.dist[from]![0]!;
    travel += legMin; totalDist += legM;
    const arrival = clock + legMin;
    out.push({
      seq: out.length, label: depot.label, lat: depot.lat, lon: depot.lon, depot: true,
      arrival, wait: 0, service: 0, departure: arrival, legDistance: legM, legDuration: legMin, late: false,
    });
    clock = arrival;
  }
  const orderedPts = out.map((o) => ({ lat: o.lat, lon: o.lon } as Pt));
  const geometry = await osrmGeometry(orderedPts);
  return {
    ok: true,
    source: matrix.source,
    startTime: clockStr(startMin),
    returnToStart: closed,
    autoStart: false,
    stops: out,
    geometry: geometry.length ? geometry : out.map((o) => [o.lat, o.lon] as [number, number]),
    unassigned: [],
    totalDistance: Math.round(totalDist),
    travelDuration: Math.round(travel),
    totalDuration: Math.round(clock - startMin),
  };
}

export async function optimizeRoute(req: RouteReqIn): Promise<RouteResult> {
  if (!req.stops?.length) throw new Error("Inga stopp angivna.");
  if (req.stops.length > 40) throw new Error("Max 40 stopp per rutt.");

  const depot = await resolvePoint(req.depot, "Start", true);
  const stops: Pt[] = [];
  for (let i = 0; i < req.stops.length; i++) {
    stops.push(await resolvePoint(req.stops[i]!, `Stopp ${i + 1}`, false));
  }
  const closed = req.returnToStart !== false;
  const { min: startMin } = parseStart(req.startTime);
  const autoStart = req.autoStart === true;

  // Förstahandsval: ORS (äkta tidsfönster + auto-starttid + geometri). Fallback: lokal.
  const ors = await orsOptimize(depot, stops, closed, startMin, autoStart);
  if (ors) return ors;
  return localSolve(depot, stops, closed, startMin);
}
