/**
 * Admin-autentisering för en enanvändar-app som ska ligga publikt.
 *
 * Modell: sajten är PUBLIK för läsning (sök, bläddra, länka ut). Personliga funktioner
 * (bevakning, notiser, sparade sökningar, rutt, prisuppslag, driftstatus, inställningar)
 * kräver admin. Admin = kännedom om ADMIN_PASSWORD → signerad httpOnly-cookie.
 *
 * Cookien är stateless: "<utgångstid_ms>.<hmac>" signerad med en serverhemlighet. Ingen
 * sessionslagring behövs (en enda användare). SameSite=Lax skyddar mot CSRF (cookien följer
 * inte med korssajts-POST), HttpOnly hindrar JS-läsning, Secure sätts i produktion.
 */

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const IS_PROD = process.env.NODE_ENV === "production";
const COOKIE = "allarop_admin";
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 dagar

// Signeringshemlighet: explicit ADMIN_SECRET om satt (då överlever cookies en omstart och
// lösenordsbyte oberoende), annars härledd ur lösenordet, annars slumpad per process
// (dev utan lösenord - cookies spelar ändå ingen roll då allt är öppet lokalt).
const SECRET = process.env.ADMIN_SECRET
  ? process.env.ADMIN_SECRET
  : PASSWORD
    ? createHmac("sha256", "allarop-admin-cookie-v1").update(PASSWORD).digest("hex")
    : randomBytes(32).toString("hex");

/**
 * Startspärr: en publik produktionsdrift UTAN admin-lösenord vore ett vidöppet skydd
 * (vem som helst kan ändra dina inställningar, radera bevakningar, tömma AI-budgeten).
 * Vägra då starta. Lokalt (utan NODE_ENV=production) tillåts öppet läge med en varning.
 */
export function assertAuthConfig(): void {
  if (IS_PROD && !PASSWORD) {
    throw new Error(
      "ADMIN_PASSWORD saknas med NODE_ENV=production. Sätt ett starkt lösenord i .env " +
        "innan publik drift - annars är /status, /priser, bevakning och inställningar oskyddade.",
    );
  }
  if (!PASSWORD) {
    // eslint-disable-next-line no-console
    console.warn(
      "⚠ ADMIN_PASSWORD ej satt - admin-skyddet är AVSTÄNGT (allt öppet). OK lokalt, " +
        "men MÅSTE sättas före publik drift.",
    );
  }
}

/** True om ett admin-lösenord över huvud taget är konfigurerat (annars är allt öppet). */
export function adminConfigured(): boolean {
  return PASSWORD.length > 0;
}

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("base64url");
}

function makeToken(): string {
  const payload = String(Date.now() + MAX_AGE_S * 1000);
  return `${payload}.${sign(payload)}`;
}

function tokenValid(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > Date.now();
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** True om requesten är admin. Utan konfigurerat lösenord: allt är admin (dev-läge). */
export function isAdmin(req: IncomingMessage): boolean {
  if (!PASSWORD) return true;
  return tokenValid(parseCookies(req.headers.cookie)[COOKIE]);
}

/** Konstant-tids-jämförelse av inmatat lösenord mot det konfigurerade. */
export function checkPassword(input: string | undefined): boolean {
  if (!PASSWORD || !input) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) {
    timingSafeEqual(b, b); // fast arbete oavsett, undvik trivialt tidsläckage
    return false;
  }
  return timingSafeEqual(a, b);
}

export function setAdminCookie(res: ServerResponse): void {
  const secure = IS_PROD ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}${secure}`,
  );
}

export function clearAdminCookie(res: ServerResponse): void {
  const secure = IS_PROD ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

/** Gate: släpper igenom admin, annars 401 + {needAuth:true}. Returnerar false om blockerad. */
export function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAdmin(req)) return true;
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "admin krävs", needAuth: true }));
  return false;
}
