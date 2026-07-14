/**
 * Enkel in-memory rate-limiter (fast fönster per IP). En Node-process → en Map räcker.
 *
 * Skyddar mot att en enskild besökare tömmer AI-budgeten (sök-expansion, prisstatistik),
 * hamrar geokodning/ORS eller överbelastar Postgres-söket. Bakom en reverse-proxy (Caddy)
 * ser alla requests ut att komma från proxyn - sätt TRUST_PROXY=1 så läses X-Forwarded-For.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";

export function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (raw) {
      const first = raw.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

interface Window {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Window>();
let lastSweep = Date.now();

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, w] of buckets) if (w.resetAt <= now) buckets.delete(k);
}

/** true = tillåten inom kvoten, false = översteg. */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now);
  const w = buckets.get(key);
  if (!w || w.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (w.count >= limit) return false;
  w.count++;
  return true;
}

/**
 * Kollar kvoten för (bucket, klient-IP). Vid överskridande: skickar 429 + Retry-After och
 * returnerar false (anroparen ska då returnera direkt). Annars true.
 */
export function rateLimit(
  req: IncomingMessage,
  res: ServerResponse,
  bucket: string,
  limit: number,
  windowMs: number,
): boolean {
  if (allow(`${bucket}:${clientIp(req)}`, limit, windowMs)) return true;
  res.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "retry-after": String(Math.ceil(windowMs / 1000)),
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "för många förfrågningar - vänta en stund och försök igen" }));
  return false;
}
