/**
 * Minimalt läs-API (v0) ovanpå Postgres. Ren Node http — inga ramverk.
 * Endpoints:
 *   GET /health
 *   GET /items?q=<sök>&limit=<n>   → fuzzy-sök bland objekt
 *   GET /items/:house/:externalId  → ett objekt med media och budhistorik
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "../db/pool.ts";
import {
  categoryFacets,
  getHiddenHouses,
  hasMatchVerdict,
  invalidateHidden,
  listActive,
  listHouses,
  listSellers,
  hybridSearch,
  loadMatchVerdicts,
  locationFacets,
  priceHistory,
  priceStats,
  saveMatchVerdict,
  setHiddenHouses,
} from "../db/repo.ts";
import { hasApiKey, verifySameObject } from "../ai/imageverify.ts";
import { ItemAttrs } from "../db/similar.ts";
import { loadVehicleData, regnrForItem } from "../vehicle/enrich.ts";
import { alprAvailable, decodeVec, embedImage, encodeVec } from "../ai/embed.ts";
import { visualSimilar } from "../ai/visual-index.ts";
import { semanticTopK } from "../ai/text-index.ts";
import { expandQuery } from "../ai/search-expand.ts";
import { sekRates } from "../fx/rates.ts";
import { TAXONOMY } from "../categories/taxonomy.ts";
import { optimizeRoute, RouteReqIn } from "../route/optimize.ts";
import { getMaxSpeed, setSetting } from "../db/settings.ts";
import { geocodeSuggest } from "../geo/geocode.ts";
import {
  decideCategorization, decideComparison, nextCategorizationCard, nextComparisonCard, priceLookup,
} from "../db/repo.ts";
import {
  addWatch, createSearch, deleteSearch, listNotifications, listSearches,
  listWatchItems, markAllRead, markRead, removeWatch, watchedKeys,
} from "../db/watch.ts";
import {
  isPushEnabled, vapidPublicKey, saveSubscription, deleteSubscription,
} from "../db/push.ts";
import {
  assertAuthConfig, adminConfigured, isAdmin, requireAdmin,
  checkPassword, setAdminCookie, clearAdminCookie,
} from "./auth.ts";
import { rateLimit } from "./ratelimit.ts";
import { handleSeoPage } from "./seo-pages.ts";
import { INDEXNOW_KEY } from "../scheduler/indexnow.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../web");

// Säkerhetsheaders på HTML-svar (klickjacking, MIME-sniffning, referrer-läckage).
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  // CSP i REPORT-ONLY-läge (audit E6, steg 1): loggar brott utan att blockera
  // något — kan aldrig bryta SPA:n. SPA:n fetchar samma origin och laddar inga
  // externa scripts; typsnitt via Google Fonts, bilder/media från källhusen (https:).
  // Verifiera i rapport-loggen innan byte till tvingande "content-security-policy".
  "content-security-policy-report-only":
    "default-src 'self'; img-src 'self' https: data:; media-src 'self' https:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};

async function serveHtmlFile(res: ServerResponse, file: string, extraHeaders?: Record<string, string>): Promise<void> {
  try {
    const html = await readFile(join(WEB_DIR, file));
    // no-store: HTML:en bär all inline-JS/CSS och byts vid varje ombygge → aldrig cacha,
    // annars ser man en gammal version tills man hård-laddar (Ctrl+Shift+R).
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    });
    res.end(html);
  } catch {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`web/${file} saknas`);
  }
}

function serveApp(res: ServerResponse, extraHeaders?: Record<string, string>): Promise<void> {
  return serveHtmlFile(res, "index.html", extraHeaders);
}

/** Läs hela request-body:n (max 256 kB) som text. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "", size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 262144) { reject(new Error("body för stor")); req.destroy(); return; }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(json);
}

interface EmbeddingProgress {
  text: { ok: number; sentinel: number; remaining: number; total: number; ratePerSec: number };
  image: { ok: number; remaining: number; total: number; ratePerSec: number };
}

/** /status-sidan: embedding-progress (semantisk sök + bild-retention) + husstatus, live-
 * uppdaterande. All rendering sker klient-sida av render(DATA) så pollingen bara byter data. */
function renderStatusPage(embedding: EmbeddingProgress, houses: unknown[], maxSpeed: boolean, gpu: boolean, priceHistory: unknown): string {
  const initial = JSON.stringify({ embedding, houses, maxSpeed, gpu, priceHistory }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="sv"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Allarop - status</title>
<style>
:root{--bg:#faf8f4;--fg:#1c1a17;--muted:#8a8377;--line:#e5e0d8;--card:#fff;--accent:#2f7d4f;--accent2:#b07a2c}
*{box-sizing:border-box}body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
.wrap{max-width:1120px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 2px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:28px 0 12px}
.sub{color:var(--muted);font-size:12px;margin-bottom:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px}
.card .top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.card .name{font-weight:600}.card .pct{font-size:26px;font-variant-numeric:tabular-nums;font-weight:700}
.track{height:10px;background:#efeae2;border-radius:6px;overflow:hidden;margin:12px 0 10px}
.fill{height:100%;border-radius:6px;transition:width .6s ease}
.fill.t{background:var(--accent)}.fill.i{background:var(--accent2)}
.meta{display:flex;flex-wrap:wrap;gap:4px 18px;color:var(--muted);font-size:12.5px}
.meta b{color:var(--fg);font-weight:600;font-variant-numeric:tabular-nums}
.done{color:var(--accent);font-weight:600}
/* Tabellerna kan bli breda (husstatus = 10 kolumner) - låt dem scrolla i sidled inuti sin
   behållare på mobil i stället för att tvinga hela sidan bredare än skärmen. */
#houses,#phHouses{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
#houses table{min-width:680px}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:#fbfaf7}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
tr.warn{background:#fff7ed}tr.bad{background:#fdf0ee}
@media(max-width:600px){.wrap{padding:18px 14px}}
.foot{color:var(--muted);font-size:12px;margin-top:14px}
.live{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-right:6px;vertical-align:middle;animation:p 2s infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
a{color:var(--accent)}
.speed{display:flex;align-items:center;gap:12px;margin:16px 0 4px;padding:13px 16px;background:var(--card);border:1px solid var(--line);border-radius:12px;cursor:pointer;font-size:13.5px;max-width:760px}
.speed input{position:absolute;opacity:0;width:0;height:0}
.speed .sw{flex:none;width:42px;height:24px;border-radius:12px;background:#d9d4ca;position:relative;transition:background .2s}
.speed .sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.speed input:checked+.sw{background:var(--accent2)}
.speed input:checked+.sw::after{transform:translateX(18px)}
.speed b{font-weight:700}
.gpubadge{font-size:12px;color:var(--muted)}.gpubadge b{color:var(--accent2)}
.card.stat{padding:16px 20px}
.statv{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.statl{color:var(--muted);font-size:12.5px;margin-top:2px}
.stats{color:var(--accent);font-size:12px;margin-top:7px;font-variant-numeric:tabular-nums}
</style>
<div class="wrap">
  <h1>Driftstatus</h1>
  <div class="sub"><span class="live"></span><span id="ts">live</span> · <a href="/">till söket</a> · <span id="gpuBadge" class="gpubadge"></span></div>
  <label class="speed" id="speedWrap"><input type="checkbox" id="maxSpeed"><span class="sw"></span>
    <span><b>⚡ Maxa hastighet</b> - kör bild-embeddingen med datorns fulla kraft (mycket snabbare backlog, men sök kan bli trögare under tiden).</span></label>
  <h2>Embedding-progress</h2>
  <div class="cards" id="cards"></div>
  <h2>Avslutade auktioner (prishistorik)</h2>
  <div class="cards" id="phStats"></div>
  <div id="phHouses"></div>
  <h2>Husstatus</h2>
  <div id="houses"></div>
  <p class="foot">* aktiva objekt vars sluttid passerade &gt;45 min sedan utan finalisering - ska vara ~0.
  🟢 uppdaterad &lt;45 min · 🟡 &lt;3 h · 🔴 äldre = kolla connectorn. Uppdateras var 10:e sekund.</p>
</div>
<script>
const INITIAL = ${initial};
const ni = (x)=>Math.round(x).toLocaleString('sv-SE');
function eta(rem, rate){ if(rem<=0) return '<span class="done">klart</span>'; if(rate<=0) return 'okänd takt';
  let s=Math.round(rem/rate); if(s<90) return '~'+s+' s'; let m=Math.round(s/60); if(m<90) return '~'+m+' min';
  let h=Math.floor(m/60); return '~'+h+' h '+(m%60)+' min'; }
function card(cls,name,note,d){
  const pct = d.total>0 ? Math.round(100*d.ok/d.total) : 0;
  const rate = d.ratePerSec||0;
  const done = d.remaining<=0;
  return '<div class="card"><div class="top"><span class="name">'+name+'</span><span class="pct">'+pct+'%</span></div>'+
    '<div class="track"><div class="fill '+cls+'" style="width:'+pct+'%"></div></div>'+
    '<div class="meta"><span><b>'+ni(d.ok)+'</b> / '+ni(d.total)+' klara</span>'+
    '<span><b>'+(rate>0?rate.toFixed(1):'0')+'</b> /s</span>'+
    '<span>kvar: <b>'+ni(d.remaining)+'</b></span>'+
    '<span>ETA '+eta(d.remaining,rate)+'</span>'+
    (d.sentinel?'<span>'+ni(d.sentinel)+' utan text</span>':'')+
    '</div><div class="meta" style="margin-top:4px">'+note+'</div></div>';
}
function houseRows(hs){
  const td=(s)=>'<td>'+s+'</td>';
  const head='<tr><th></th><th>hus</th><th class="num">aktiva</th><th class="num">med bud</th><th>uppdaterad</th><th class="num">förfallna*</th><th class="num">bild %</th><th class="num">beskr %</th><th class="num">total %</th><th class="num">AI-kat %</th></tr>';
  const body=hs.map(h=>{const age=h.ageMin;const upd=age==null?'aldrig':age<60?age+' min sedan':Math.round(age/60)+' h sedan';
    const cls=h.status==='🔴'?'bad':h.status==='🟡'?'warn':'';
    return '<tr class="'+cls+'">'+td(h.status)+td(h.house)+'<td class="num">'+h.aktiva+'</td><td class="num">'+h.med_bud+'</td>'+td(upd)+'<td class="num">'+h.forfallna+'</td><td class="num">'+h.bild_pct+'</td><td class="num">'+h.desc_pct+'</td><td class="num">'+h.total_pct+'</td><td class="num">'+h.ai_pct+'</td></tr>';
  }).join('');
  return '<table>'+head+body+'</table>';
}
function statCard(label,val,sub){ return '<div class="card stat"><div class="statv">'+val+'</div><div class="statl">'+label+'</div>'+(sub?'<div class="stats">'+sub+'</div>':'')+'</div>'; }
function phStats(p){
  if(!p) return '';
  const tr=p.tradera||{};
  const crawl = tr.soldRoot!=null ? ('djup-crawl rot '+tr.soldRoot+'/'+(tr.soldTotal||33)) : 'djup-crawl -';
  return statCard('Avslutade auktioner totalt', ni(p.total), p.houses+' hus')+
    statCard('Varav sålda (med slutbud)', ni(p.sold), p.total>0?Math.round(100*p.sold/p.total)+'% av alla':'')+
    statCard('Tradera avslutade', ni(tr.count||0), crawl);
}
function phHouseTable(p){
  if(!p||!p.byHouse) return '';
  const td=(s)=>'<td>'+s+'</td>';
  const head='<tr><th>hus</th><th class="num">avslutade auktioner</th><th class="num">andel</th></tr>';
  const body=p.byHouse.map(h=>'<tr>'+td(h.house)+'<td class="num">'+ni(h.n)+'</td><td class="num">'+(p.total>0?(Math.round(1000*h.n/p.total)/10):0)+' %</td></tr>').join('');
  return '<table>'+head+body+'</table>';
}
function render(d){
  const t=d.embedding.text,i=d.embedding.image;
  document.getElementById('cards').innerHTML =
    card('t','Text-embedding','semantisk sök (e5-base) - titel+beskrivning',t)+
    card('i','Bild-embedding','visuell gate + retention (DINOv2) - huvudbild',i);
  document.getElementById('phStats').innerHTML = phStats(d.priceHistory);
  document.getElementById('phHouses').innerHTML = phHouseTable(d.priceHistory);
  document.getElementById('houses').innerHTML = houseRows(d.houses);
  const ms=document.getElementById('maxSpeed'); if(ms && document.activeElement!==ms) ms.checked = !!d.maxSpeed;
  const gb=document.getElementById('gpuBadge'); if(gb) gb.innerHTML = d.gpu ? 'Bild-modell: <b>GPU (CUDA) ⚡</b>' : 'Bild-modell: <b>CPU</b>';
  document.getElementById('ts').textContent = new Date().toLocaleTimeString('sv-SE');
}
render(INITIAL);
document.getElementById('maxSpeed').addEventListener('change', async (e)=>{
  try{ await fetch('/settings/max-speed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:e.target.checked})}); }catch(err){}
});
async function poll(){ try{ const r=await fetch('/status?json=1',{cache:'no-store'}); if(r.ok) render(await r.json()); }catch(e){} }
setInterval(poll, 10000);
</script>
</html>`;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // Kanonisering: www → apex, trailing slash bort (utom roten "/"). x-forwarded-host
  // speglar den riktiga Host-headern (satt av gateway, se gateway/index.js) - http→https
  // hanteras separat av Cloudflares "Always Use HTTPS"-zoninställning, eftersom
  // x-forwarded-proto genom tunneln alltid är "https" och inte går att lita på här.
  // Utan detta svarade http/www/trailing-slash alla 200 (4 dubblettversioner av
  // varje sida) - bekräftat av SEO-audit 2026-07-29.
  {
    const fwdHost = ((req.headers["x-forwarded-host"] as string) || req.headers.host || "").split(":")[0];
    let path = url.pathname;
    let redirect = false;
    if (fwdHost === "www.allarop.se") redirect = true;
    if (path.length > 1 && path.endsWith("/")) { path = path.replace(/\/+$/, ""); redirect = true; }
    if (redirect) {
      res.writeHead(301, { location: `https://allarop.se${path}${url.search}` });
      res.end();
      return;
    }
  }

  const parts = url.pathname.split("/").filter(Boolean);

  // Global grovsäkring per IP (generös): stoppar hamring men stör aldrig normal användning
  // (statussidan pollar 6/min, en sökning är några anrop). Statiska asset-svar undantas.
  const isAsset = url.pathname === "/sw.js" || url.pathname === "/favicon.png"
    || url.pathname === `/${INDEXNOW_KEY}.txt`;
  if (!isAsset && !rateLimit(req, res, "global", 600, 60_000)) return;

  // IndexNow-nyckelfil (audit E11): IndexNow/Bing hämtar denna för att verifiera att
  // vi äger nyckeln i ping-payloaden. Nyckeln är PUBLIK by design (protokollet kräver
  // att filen är hämtbar) — sätt INDEXNOW_KEY i miljön för att styra den.
  if (url.pathname === `/${INDEXNOW_KEY}.txt`) {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    });
    res.end(INDEXNOW_KEY);
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    // Sök-/filter-URL:er (?q=, ?house=, ?category= osv) är tunt/dubblettinnehåll av samma
    // SPA-skal - oändligt många nästan-identiska sidor späder ut sajtkvaliteten i Googles
    // ögon. noindex via header, men follow så länkar från sökresultat ändå upptäcks.
    if (url.search) return serveApp(res, { "x-robots-tag": "noindex, follow" });
    return serveApp(res);
  }
  // Ruttplanerare/prisuppslag: interna verktyg, redan låsta bakom admin-inlogg i klienten
  // (showAdminGate). Ingen publik länk pekar hit och de ska inte indexeras/synas i sök -
  // noindex via HTTP-header (funkar oavsett JS-rendering, till skillnad från en meta-tagg
  // som skulle krävt path-specifik HTML). Fortsatt nåbara om man skriver URL:en direkt.
  if (url.pathname === "/rutt" || url.pathname === "/priser" || url.pathname === "/admin" || url.pathname === "/swipe") {
    return serveApp(res, { "x-robots-tag": "noindex, nofollow" });
  }
  // Juridisk sida (publik): Om, Villkor, Integritetspolicy, Kontakt/takedown är EN sida
  // med ankarsektioner. /om är kanonisk URL; de tre andra var tidigare separata paths som
  // serverade identisk HTML (duplicate content) - redirecta dem till /om#<sektion> istället.
  if (url.pathname === "/villkor" || url.pathname === "/integritet" || url.pathname === "/kontakt") {
    res.writeHead(301, { location: `/om#${url.pathname.slice(1)}` });
    res.end();
    return;
  }
  if (url.pathname === "/om") {
    return serveHtmlFile(res, "juridik.html");
  }

  // ---- Admin-auth: login/logout + sessionskoll (för klientens UI-gating) ----
  if (url.pathname === "/admin/session" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ admin: isAdmin(req), configured: adminConfigured() }));
    return;
  }
  if (url.pathname === "/admin/login" && req.method === "POST") {
    // Hård kvot mot lösenordsgissning: 10 försök / 5 min / IP.
    if (!rateLimit(req, res, "login", 10, 300_000)) return;
    let pw = "";
    try { pw = String(JSON.parse(await readBody(req))?.password ?? ""); } catch { /* tom */ }
    if (!adminConfigured()) return send(res, 400, { error: "admin ej konfigurerad på servern" });
    if (!checkPassword(pw)) return send(res, 401, { error: "fel lösenord" });
    setAdminCookie(res);
    return send(res, 200, { ok: true, admin: true });
  }
  if (url.pathname === "/admin/logout" && req.method === "POST") {
    clearAdminCookie(res);
    return send(res, 200, { ok: true, admin: false });
  }
  // Service worker (Web Push): måste serveras från roten för root-scope.
  if (url.pathname === "/sw.js") {
    try {
      const js = await readFile(join(WEB_DIR, "sw.js"));
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store, must-revalidate",
        "service-worker-allowed": "/",
      });
      res.end(js);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("sw.js saknas");
    }
    return;
  }
  if (url.pathname === "/favicon.png") {
    try {
      const png = await readFile(join(WEB_DIR, "favicon.png"));
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      res.end(png);
    } catch {
      res.writeHead(404); res.end();
    }
    return;
  }
  // --- SSR SEO-sidor + SEO/PWA-statik/robots/sitemap/manifest (allarop-seo) ---
  if ((req.method === "GET" || req.method === "HEAD") && await handleSeoPage(url.pathname, res)) return;
  {
    const staticPng: Record<string, string> = {
      "/og-image.png": "og-image.png",
      "/apple-touch-icon.png": "apple-touch-icon.png",
      "/icon-512.png": "icon-512.png",
    };
    const pngFile = staticPng[url.pathname];
    if (pngFile) {
      try {
        const buf = await readFile(join(WEB_DIR, pngFile));
        res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=604800" });
        res.end(buf);
      } catch { res.writeHead(404); res.end(); }
      return;
    }
  }
  // Guide-hero-bilder (SVG) från web/guide-images/ som /guide-images/*.
  {
    const imgMatch = url.pathname.match(/^\/guide-images\/(.+)$/);
    if (imgMatch && imgMatch[1]) {
      const imgFile = imgMatch[1].replace(/\\/g, "/");
      if (imgFile.includes("..")) { res.writeHead(404); res.end(); return; }
      try {
        const buf = await readFile(join(WEB_DIR, "guide-images", imgFile));
        const ext = imgFile.split(".").pop()?.toLowerCase();
        const ct = ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream";
        res.writeHead(200, { "content-type": ct, "cache-control": "public, max-age=604800" });
        res.end(buf);
      } catch { res.writeHead(404); res.end(); }
      return;
    }
  }
  // robots.txt, llms.txt och sitemap.xml/-pages.xml/-items-N.xml hanteras nu av
  // handleSeoPage() ovan (seo-pages.ts) - sitemapen är en index + paginerade
  // objektsidor istället för en enda platt fil, se digitalbyra-specen 2026-07-29.
  if (url.pathname === "/site.webmanifest") {
    res.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=86400" });
    res.end(JSON.stringify({
      name: "Allarop", short_name: "Allarop",
      description: "Sök alla Sveriges nätauktioner på ett ställe.",
      start_url: "/", display: "standalone",
      background_color: "#f5f4f1", theme_color: "#141613",
      icons: [
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        { src: "/favicon.png", sizes: "192x192", type: "image/png" },
      ],
    }));
    return;
  }
  if (url.pathname === "/health") return send(res, 200, { ok: true });

  // Objekt-djuplänk /objekt/<hus>/<id> (SPA-rutt): klienten pushState:ar hit när en
  // detaljvy öppnas, och IndexNow-pingarna (audit E11) pekar hit. VIKTIGT: denna ligger
  // EFTER SSR-dispatchen (handleSeoPage, injiceras av setup-skriptet före /health) så
  // kända objekt serveras som SSR med Product-schema — denna fallback (200 + app-skal)
  // gäller bara objekt som SSR inte känner igen (okända/borttagna), i stället för 404.
  if (parts[0] === "objekt" && parts.length === 3) return serveApp(res);

  // Växelkurser (SEK per enhet) för att visa ungefärligt SEK-pris på utländska objekt.
  if (url.pathname === "/rates") return send(res, 200, await sekRates());

  // Kategoritaxonomi + antal aktiva objekt per nyckel (för kategorifilter med räknare).
  if (url.pathname === "/categories") {
    const facets = await categoryFacets();
    const cats = TAXONOMY.map((m) => {
      const subs = m.subs.map((s) => ({ ...s, count: facets[`${m.key}/${s.key}`] ?? 0 }));
      return { key: m.key, label: m.label, icon: m.icon, count: subs.reduce((a, s) => a + s.count, 0), subs };
    });
    return send(res, 200, { categories: cats });
  }

  // Vanligaste orterna (för ort-filter med räknare).
  if (url.pathname === "/locations") {
    return send(res, 200, { locations: await locationFacets(40) });
  }

  // "Vad har liknande gått för?" - prisstatistik för ett objekt (min/snitt/median/max).
  // ?verify=1 → AI-bildverifiering av de visade jämförelserna (gratis vision-modell via
  // OpenRouter; kräver OPENROUTER_API_KEY). Verdikt cachas permanent i match_verdicts.
  if (url.pathname === "/price-stats") {
    if (!rateLimit(req, res, "pricestats", 90, 60_000)) return;
    const house = url.searchParams.get("house") ?? "";
    const id = url.searchParams.get("id") ?? "";
    // Källorna bakom prisindikationen (vilka sålda objekt/hus/Tradera) visas ALDRIG publikt
    // - bara aggregatet (spann + typiskt värde). AI-bildgranskningen (kostar) är också admin.
    const admin = isAdmin(req);
    const verify = admin && url.searchParams.get("verify") === "1";
    const it = await pool.query<{ title: string; cur: string | null; currency: string | null; category: string | null; description: string | null; image: string | null; lot_count: number | null; attrs: ItemAttrs | null; emb: Buffer | null }>(
      `SELECT title, COALESCE(current_bid, min_bid) cur, currency, category, description, lot_count, attrs,
              (SELECT m.url FROM media m WHERE m.house=items.house AND m.owner_type='item'
                 AND m.owner_external_id=items.external_id AND m.kind='image'
               ORDER BY m.sort NULLS LAST LIMIT 1) image,
              (SELECT m.embedding FROM media m WHERE m.house=items.house AND m.owner_type='item'
                 AND m.owner_external_id=items.external_id AND m.kind='image' AND m.embedding IS NOT NULL
               ORDER BY m.sort NULLS LAST LIMIT 1) emb
       FROM items WHERE house=$1 AND external_id=$2 LIMIT 1`,
      [house, id],
    );
    const row = it.rows[0];
    if (!row) return send(res, 404, { error: "objekt saknas" });
    // Målets eget bud till SEK (statistiken är i SEK) - utländskt objekt jämförs annars fel.
    const rates = await sekRates();
    const rate = rates[(row.currency ?? "SEK").toUpperCase()] ?? null;
    const currentSek = row.cur != null && rate != null ? Math.round(Number(row.cur) * rate) : null;
    // Visuell gate: målets embedding (lagrad); saknas den → embedda EN gång live och skriv
    // tillbaka (best-effort, aldrig blockerande) så interaktiva öppningar snabbt får gaten.
    let targetEmbedding = decodeVec(row.emb);
    if (targetEmbedding == null && row.image != null && (await alprAvailable())) {
      // KORT timeout (1,5s): live-embeddingen får ALDRIG hänga detaljvyn på en upptagen
      // sidecar (DINOv3 bakgrunds-embed). Timeout → targetEmbedding null → gaten hoppas
      // (missing-safe); objektet embeddas ändå av bakgrundspasset snart.
      const v = await Promise.race([
        embedImage(row.image).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 1500)),
      ]);
      if (v != null) {
        targetEmbedding = v;
        void pool.query(
          `UPDATE media SET embedding=$3, embedded_at=now()
           WHERE house=$1 AND owner_type='item' AND owner_external_id=$2 AND kind='image'
             AND url=$4 AND embedding IS NULL`,
          [house, id, encodeVec(v), row.image],
        ).catch(() => {});
      }
    }
    const stats = await priceStats(row.title, {
      exclHouse: house,
      exclId: id,
      current: currentSek,
      category: row.category,
      lotCount: row.lot_count,
      attrs: row.attrs,
      targetEmbedding,
    });
    if (!stats) return send(res, 200, { stats: null, aiAvailable: false });
    // Publikt: strippa källorna (samples = vilka sålda objekt/hus statistiken bygger på).
    // Kvar blir bara aggregatet (spann/median/typiskt) som driver "under pris"-indikatorn.
    if (!admin) {
      return send(res, 200, {
        stats: {
          count: stats.count, min: stats.min, max: stats.max, avg: stats.avg,
          median: stats.median, p25: stats.p25, p75: stats.p75,
          current: stats.current, loose: stats.loose,
        },
        aiAvailable: false,
      });
    }
    if (!verify) return send(res, 200, { stats, aiAvailable: hasApiKey() });

    // AI-granskning: cache-först, sedan högst VERIFY_MAX nya bedömningar (gratisnivån är
    // rate-limitad). Sekventiellt med samtidighet 2 - snabbt nog för en detaljvy.
    const VERIFY_MAX = Number(process.env.AI_VERIFY_MAX ?? 8);
    const candidates = stats.samples.filter((s) => s.image != null);
    const cached = await loadMatchVerdicts(house, id, candidates.map((s) => ({ house: s.house, id: s.id })));
    const fresh = candidates.filter((s) => !cached.has(`${s.house}/${s.id}`)).slice(0, hasApiKey() ? VERIFY_MAX : 0);
    let idx = 0;
    await Promise.all(Array.from({ length: Math.min(2, fresh.length) }, async () => {
      for (;;) {
        const s = fresh[idx++];
        if (!s) return;
        if (await hasMatchVerdict(house, id, s.house, s.id)) continue; // redan avgjort (AI eller människa) - fråga inte igen
        const v = await verifySameObject(
          { title: row.title, image: row.image ?? "", desc: row.description },
          { title: s.title, image: s.image!, desc: s.desc },
        );
        if (v) {
          await saveMatchVerdict(house, id, s.house, s.id, v);
          cached.set(`${s.house}/${s.id}`, { same: v.same, reason: v.reason });
        }
      }
    }));

    // Verdikt per sample + omräknad statistik över samples som INTE underkänts.
    const samples = stats.samples.map((s) => {
      const v = cached.get(`${s.house}/${s.id}`);
      return { ...s, ai: v ? (v.same ? "same" : "different") : "unknown", aiReason: v?.reason ?? null };
    });
    const kept = samples.filter((s) => s.ai !== "different").map((s) => s.price).sort((a, b) => a - b);
    // aiStats returneras så fort NÅGOT verdikt finns - även när 0-2 återstår. Annars
    // står ursprungssnittet kvar i UI:t trots att AI:n underkänt träffarna bakom det
    // (Transit-fyndet 2026-07-06: 3 av 4 underkända → null → orörd "snitt"-stapel).
    const reviewed = samples.some((s) => s.ai !== "unknown");
    const aiStats = !reviewed
      ? null
      : {
          count: kept.length,
          min: kept[0] ?? null,
          max: kept[kept.length - 1] ?? null,
          avg: kept.length ? Math.round(kept.reduce((a, b) => a + b, 0) / kept.length) : null,
          median: kept.length ? kept[Math.floor(kept.length / 2)]! : null,
        };
    return send(res, 200, { stats: { ...stats, samples }, aiStats, aiAvailable: hasApiKey() });
  }

  // /hus flyttad till /status (embedding-progress + husstatus samlat). Behåll gammal länk.
  if (url.pathname === "/hus") {
    if (!requireAdmin(req, res)) return;
    const qs = url.search ? url.search : "";
    res.writeHead(302, { location: `/status${qs}` });
    res.end();
    return;
  }

  // /status - driftstatus: EMBEDDING-progress (semantisk sök + bild-retention) med antal,
  // takt (/s senaste 60s) och ETA, PLUS husstatus per auktionshus (färskhet + täckning).
  // Live-uppdaterande HTML; ?json=1 för rådata. Admin-gatad (exponerar intern drift).
  if (url.pathname === "/status") {
    if (!requireAdmin(req, res)) return;
    const [emb, img, houses, phAgg, phByHouse, tJobs] = await Promise.all([
      pool.query<{ active_total: string; text_ok: string; text_sentinel: string; text_remaining: string; text_rate60: string }>(
        `SELECT
           (SELECT count(*) FROM items WHERE status='active') active_total,
           (SELECT count(*) FROM items WHERE status='active' AND text_embedding IS NOT NULL AND octet_length(text_embedding)>0) text_ok,
           (SELECT count(*) FROM items WHERE status='active' AND text_embedding IS NOT NULL AND octet_length(text_embedding)=0) text_sentinel,
           (SELECT count(*) FROM items WHERE status='active' AND text_embedding IS NULL) text_remaining,
           (SELECT count(*) FROM items WHERE status='active' AND text_embedded_at > now() - interval '60 seconds') text_rate60`,
      ),
      pool.query<{ img_total: string; img_ok: string; img_remaining: string; img_rate60: string }>(
        `WITH a AS (
           SELECT bool_or(m.embedding IS NOT NULL AND octet_length(m.embedding)>0) has_emb,
                  bool_or(m.embedding IS NOT NULL) processed
           FROM items i JOIN media m ON m.house=i.house AND m.owner_type='item'
             AND m.owner_external_id=i.external_id AND m.kind='image'
           WHERE i.status='active'
           GROUP BY i.house, i.external_id)
         SELECT (SELECT count(*) FROM a) img_total,
                (SELECT count(*) FROM a WHERE has_emb) img_ok,
                (SELECT count(*) FROM a WHERE NOT processed) img_remaining,
                (SELECT count(*) FROM media WHERE embedded_at > now() - interval '60 seconds') img_rate60`,
      ),
      pool.query<{
        house: string; aktiva: string; med_bud: string; senast: string | null;
        forfallna: string; bild_pct: string; desc_pct: string; total_pct: string; ai_pct: string;
      }>(
        `SELECT i.house,
                count(*) aktiva,
                count(*) FILTER (WHERE i.current_bid > 0) med_bud,
                max(i.last_seen)::text senast,
                count(*) FILTER (WHERE i.ends_at < now() - interval '45 minutes') forfallna,
                round(100.0*count(*) FILTER (WHERE EXISTS (SELECT 1 FROM media m
                  WHERE m.house=i.house AND m.owner_type='item' AND m.owner_external_id=i.external_id))/count(*)) bild_pct,
                round(100.0*count(i.description)/count(*)) desc_pct,
                round(100.0*count(*) FILTER (WHERE i.total_basis IN ('source','percentage','estimate'))/count(*)) total_pct,
                round(100.0*count(*) FILTER (WHERE i.category_conf IN ('llm','learned','human'))/count(*)) ai_pct
         FROM items i WHERE i.status='active'
         GROUP BY i.house ORDER BY count(*) DESC`,
      ),
      pool.query<{ total: string; sold: string; houses: string }>(
        `SELECT count(*) total, count(*) FILTER (WHERE sold) sold, count(DISTINCT house) houses FROM price_history`,
      ),
      pool.query<{ house: string; n: string }>(
        `SELECT house, count(*) n FROM price_history GROUP BY house ORDER BY count(*) DESC LIMIT 14`,
      ),
      pool.query<{ job: string; cursor_offset: number; total: number | null }>(
        `SELECT job, cursor_offset, total FROM job_state WHERE job LIKE 'tradera%'`,
      ),
    ]);
    const e = emb.rows[0]!;
    const im = img.rows[0]!;
    const n = (s: string) => Number(s);
    const embedding = {
      text: {
        ok: n(e.text_ok), sentinel: n(e.text_sentinel), remaining: n(e.text_remaining),
        total: n(e.active_total), ratePerSec: n(e.text_rate60) / 60,
      },
      image: {
        ok: n(im.img_ok), remaining: n(im.img_remaining), total: n(im.img_total),
        ratePerSec: n(im.img_rate60) / 60,
      },
    };
    const rows = houses.rows.map((h) => {
      const ageMin = h.senast ? Math.round((Date.now() - new Date(h.senast).getTime()) / 60_000) : null;
      const status = ageMin == null ? "🔴" : ageMin < 45 ? "🟢" : ageMin < 180 ? "🟡" : "🔴";
      return { ...h, ageMin, status };
    });
    // Prishistorik/avslutade auktioner + Tradera-crawlens läge (job_state-cursor per rot).
    const pa = phAgg.rows[0]!;
    const jobs: Record<string, { cursor_offset: number; total: number | null }> = {};
    for (const j of tJobs.rows) jobs[j.job] = { cursor_offset: j.cursor_offset, total: j.total };
    const priceHistory = {
      total: n(pa.total), sold: n(pa.sold), houses: n(pa.houses),
      byHouse: phByHouse.rows.map((r) => ({ house: r.house, n: n(r.n) })),
      tradera: {
        count: phByHouse.rows.find((r) => r.house === "tradera") ? n(phByHouse.rows.find((r) => r.house === "tradera")!.n) : 0,
        soldRoot: jobs["tradera-sold"] ? jobs["tradera-sold"].cursor_offset : null,
        soldTotal: jobs["tradera-sold"]?.total ?? 33,
        freshRoot: jobs["tradera-fresh"]?.cursor_offset ?? null,
        activeRoot: jobs["tradera-active"]?.cursor_offset ?? null,
      },
    };
    const maxSpeed = await getMaxSpeed();
    // Sidecar-hälsa (bild-modell på GPU eller CPU) - kort timeout, tyst fallback.
    let gpu = false;
    try {
      const h = await fetch(`${process.env.ALPR_URL ?? "http://alpr:8000"}/health`, { signal: AbortSignal.timeout(1500) });
      if (h.ok) gpu = ((await h.json()) as { gpu?: boolean }).gpu === true;
    } catch { /* sidecar nere → CPU-antagande */ }
    if (url.searchParams.get("json") === "1") {
      return send(res, 200, { embedding, houses: rows, maxSpeed, gpu, priceHistory, generatedAt: new Date().toISOString() });
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderStatusPage(embedding, rows, maxSpeed, gpu, priceHistory));
    return;
  }

  // Max-speed-toggle (settings.max_speed): schemaläggaren maxar embedding-takten.
  if (url.pathname === "/settings/max-speed" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    let on = false;
    try { on = (JSON.parse(await readBody(req)) as { on?: boolean }).on === true; } catch { /* default av */ }
    await setSetting("max_speed", on ? "1" : "0");
    return send(res, 200, { max_speed: on ? 1 : 0 });
  }

  // Källor (auktionshus) med antal aktiva objekt — för datadrivna källfilter.
  if (url.pathname === "/houses") {
    const house = url.searchParams.get("house") || undefined;
    const [houses, sellers] = await Promise.all([listHouses(), listSellers(house)]);
    return send(res, 200, { houses, sellers });
  }

  // Admin: hus-synlighet (vilka hus som syns i UI:t). GET listar alla registrerade hus
  // med aktiv-räkning + hidden-flagga (dolda syns HÄR - det är ju här man slår på dem igen).
  if (url.pathname === "/admin/houses" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const hidden = await getHiddenHouses();
    const { rows } = await pool.query<{ key: string; name: string; active_count: string }>(
      `SELECT ah.key, ah.name,
              (SELECT count(*) FROM items i WHERE i.house=ah.key AND i.status='active'
                AND (i.ends_at IS NULL OR i.ends_at > now())) AS active_count
       FROM auction_houses ah ORDER BY active_count DESC, ah.name`,
    );
    return send(res, 200, {
      houses: rows.map((r) => ({
        house: r.key, name: r.name, activeCount: Number(r.active_count),
        hidden: hidden.includes(r.key),
      })),
    });
  }

  // Admin: slå av/på ett hus. Body: {house, hidden} - eller {houses: [...]} (hela listan).
  if (url.pathname === "/admin/houses/visibility" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    try {
      const b = JSON.parse(await readBody(req)) as { house?: string; hidden?: boolean; houses?: string[] };
      if (Array.isArray(b.houses)) {
        await setHiddenHouses(b.houses);
      } else if (typeof b.house === "string" && typeof b.hidden === "boolean") {
        const cur = new Set(await getHiddenHouses());
        if (b.hidden) cur.add(b.house); else cur.delete(b.house);
        await setHiddenHouses([...cur]);
      } else {
        return send(res, 400, { error: "ange {house, hidden} eller {houses: [...]}" });
      }
      invalidateHidden();
      return send(res, 200, { ok: true, hidden: await getHiddenHouses() });
    } catch {
      return send(res, 400, { error: "ogiltig JSON" });
    }
  }

  if (url.pathname === "/items") {
    const q = url.searchParams.get("q") ?? "";
    // Sökningar med fritext kan trigga LLM-expansion + semantisk embedding (kostar) - hårdare
    // kvot per IP. Ren listning/bläddring (utan q) skyddas bara av den globala grovsäkringen.
    if (q && !rateLimit(req, res, "search", 60, 60_000)) return;
    // house kan vara ett hus eller flera kommaseparerade (fler-val).
    const houseRaw = url.searchParams.get("house") || "";
    const houseList = houseRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const house = houseList.length ? houseList : undefined;
    const seller = url.searchParams.get("seller") || undefined;
    const includeEnded = url.searchParams.get("ended") === "1";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    const SORTS = ["ending", "newest", "price_high", "price_low", "bids", "fewest", "fynd"] as const;
    const sortParam = url.searchParams.get("sort");
    const sort = SORTS.includes(sortParam as never)
      ? (sortParam as (typeof SORTS)[number])
      : undefined;
    // Fynd-läge: "sort=fynd" ELLER "fynd=1" → visa BARA objekt minst FYND_MIN % under
    // uppskattat värde (annars vore listan meningslös), rankade efter störst rabatt.
    const FYND_MIN = Number(process.env.FYND_MIN_PCT ?? 15);
    const fyndMin = sort === "fynd" || url.searchParams.get("fynd") === "1" ? FYND_MIN : undefined;
    const RESERVES = ["met", "not_met", "none"] as const;
    const reserveParam = url.searchParams.get("reserve");
    const reserve = RESERVES.includes(reserveParam as never)
      ? (reserveParam as (typeof RESERVES)[number])
      : undefined;
    const category = url.searchParams.get("category") || undefined;
    const priceMin = url.searchParams.get("pris_min") ? Number(url.searchParams.get("pris_min")) : undefined;
    const priceMax = url.searchParams.get("pris_max") ? Number(url.searchParams.get("pris_max")) : undefined;
    const location = url.searchParams.get("ort") || undefined;
    // "slutar": 24h / 3d / 7d → sluttid-tak.
    const slutar = url.searchParams.get("slutar");
    const H = 3600_000;
    const endsBefore = slutar === "24h" ? new Date(Date.now() + 24 * H).toISOString()
      : slutar === "3d" ? new Date(Date.now() + 72 * H).toISOString()
      : slutar === "7d" ? new Date(Date.now() + 168 * H).toISOString()
      : undefined;
    const konkurs = url.searchParams.get("konkurs") === "1";
    const skickParam = url.searchParams.get("skick");
    const skick: "ny" | "otestad" | undefined =
      skickParam === "ny" ? "ny" : skickParam === "otestad" ? "otestad" : undefined;
    const opts = { limit, offset, house, seller, includeEnded, sort, reserve, category, priceMin, priceMax, location, endsBefore, fyndMin, konkurs, skick };
    // Smart sök: LLM-expansion (synonymer + relaterat + kategori), permanent cache per
    // unik fråga. ?smart=0 stänger av. Fel/timeout → vanlig sökning (aldrig blockerande).
    let expansion = null;
    if (q && url.searchParams.get("smart") !== "0") {
      try {
        expansion = await expandQuery(q);
      } catch {
        expansion = null;
      }
    }
    // Semantisk hybrid: e5-text-embeddings (mening) fuserat med lexikala söken via RRF.
    // ?semantic=0 stänger av. Sidecar nere/tomt index → tom lista → ren lexikal sök.
    let semantic: { house: string; external_id: string }[] = [];
    if (q && url.searchParams.get("semantic") !== "0") {
      try {
        semantic = await semanticTopK(q, offset + limit + 400);
      } catch {
        semantic = [];
      }
    }
    // Standard: bara aktiva. ?ended=1 inkluderar avslutade.
    const rows = q
      ? await hybridSearch(q, { ...opts, expansion, semantic })
      : await listActive(opts);
    return send(res, 200, {
      query: q,
      house: house ?? null,
      seller: seller ?? null,
      ended: includeEnded,
      sort: sort ?? null,
      offset,
      limit,
      count: rows.length,
      expansion,
      items: rows,
    });
  }

  // Visuell bildsök: aktiva objekt som är visuellt lika (house,id) via DINOv2-embeddings.
  if (url.pathname === "/similar-visual") {
    if (!rateLimit(req, res, "similar", 90, 60_000)) return;
    const house = url.searchParams.get("house") ?? "";
    const id = url.searchParams.get("id") ?? "";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 12), 40);
    const hits = await visualSimilar(house, id, limit);
    return send(res, 200, { count: hits.length, items: hits });
  }

  if (url.pathname === "/price-history") {
    if (!requireAdmin(req, res)) return; // avslöjar källrader (hus/datum/pris)
    const q = url.searchParams.get("q") ?? "";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const rows = await priceHistory(q, limit);
    return send(res, 200, { query: q, count: rows.length, history: rows });
  }

  // ---- Bevakning + notiser (personliga funktioner - admin) ----
  if (url.pathname === "/watchlist" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const [keys, items] = await Promise.all([watchedKeys(), listWatchItems()]);
    return send(res, 200, { keys, items });
  }
  if (url.pathname === "/watchlist" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    let b: { house?: string; id?: string; on?: boolean };
    try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "ogiltig JSON" }); }
    if (!b.house || !b.id) return send(res, 400, { error: "house + id krävs" });
    if (b.on === false) await removeWatch(b.house, String(b.id));
    else await addWatch(b.house, String(b.id));
    return send(res, 200, { watched: b.on !== false });
  }
  if (url.pathname === "/searches" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    return send(res, 200, { searches: await listSearches() });
  }
  if (url.pathname === "/searches" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    let b: { name?: string; params?: Record<string, unknown> };
    try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "ogiltig JSON" }); }
    if (!b.name || !b.params) return send(res, 400, { error: "name + params krävs" });
    return send(res, 200, { search: await createSearch(b.name, b.params) });
  }
  if (url.pathname === "/searches/delete" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    let b: { id?: number };
    try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "ogiltig JSON" }); }
    if (b.id == null) return send(res, 400, { error: "id krävs" });
    await deleteSearch(Number(b.id));
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/notifications" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    return send(res, 200, await listNotifications(Math.min(Number(url.searchParams.get("limit") ?? 60), 200)));
  }
  if (url.pathname === "/notifications/read" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    // Med ?id / body.id: markera EN notis läst (klick på notis/toast). Utan: alla.
    let id = Number(url.searchParams.get("id") ?? 0);
    if (!id) { try { id = Number(JSON.parse(await readBody(req))?.id ?? 0); } catch { /* tom body = alla */ } }
    if (id) await markRead(id); else await markAllRead();
    return send(res, 200, { ok: true });
  }

  // Web Push: publik VAPID-nyckel + prenumerationshantering.
  if (url.pathname === "/push/vapid" && req.method === "GET") {
    return send(res, 200, { enabled: isPushEnabled(), publicKey: vapidPublicKey() });
  }
  if (url.pathname === "/push/subscribe" && req.method === "POST") {
    // Endast admin: annars skulle en främling prenumerera och få DINA bevakningsnotiser
    // (sendPushToAll går till alla lagrade prenumerationer).
    if (!requireAdmin(req, res)) return;
    try {
      const sub = JSON.parse(await readBody(req));
      await saveSubscription(sub);
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }
  if (url.pathname === "/push/unsubscribe" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    try {
      const { endpoint } = JSON.parse(await readBody(req));
      if (endpoint) await deleteSubscription(endpoint);
      return send(res, 200, { ok: true });
    } catch { return send(res, 400, { error: "ogiltig JSON" }); }
  }

  // Prisuppslag: "vad går X för?" över hela price_history. Admin - avslöjar källorna
  // (vilka sålda objekt/hus/Tradera) med rader, bilder och datum.
  if (url.pathname === "/price-lookup") {
    if (!requireAdmin(req, res)) return;
    const q = url.searchParams.get("q") ?? "";
    const months = Math.max(0, Math.min(Number(url.searchParams.get("months") ?? 0), 120));
    const house = url.searchParams.get("house") || undefined;
    // CSV-export (handlar-feature): alla comps för valet, som nedladdningsbar fil.
    if (url.searchParams.get("format") === "csv") {
      const { rows } = await priceLookup(q, { limit: 5000, months, house });
      const esc = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
      const csv = ["titel,hus,datum,bud_kr,total_kr", ...rows.map((r) =>
        [esc(r.item_title), esc(r.house), esc((r.ended_at ?? "").slice(0, 10)), r.final_bid, r.final_total ?? r.final_bid].join(","))].join("\n");
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="prisuppslag-${q.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.csv"`,
      });
      res.end("﻿" + csv); // BOM så Excel läser å/ä/ö rätt
      return;
    }
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 40), 200);
    const r = await priceLookup(q, { limit, months, house });
    return send(res, 200, { query: q, months, house: house ?? null, ...r });
  }

  // Swipe-granskning (admin): kategorisering + prisjämförelse-matchning via svep-kort.
  if (url.pathname === "/swipe/next" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const mode = url.searchParams.get("mode");
    if (mode === "comparison") return send(res, 200, await nextComparisonCard());
    if (mode === "categorization") {
      // skip=<house>/<external_id>: hoppa över kortet som just besvarades (ett avvisat
      // kort sorterar först igen). Delas på FÖRSTA '/' - external_id kan innehålla '/'.
      const skip = url.searchParams.get("skip") ?? "";
      const slash = skip.indexOf("/");
      const exclude = slash > 0
        ? { house: skip.slice(0, slash), externalId: skip.slice(slash + 1) }
        : undefined;
      return send(res, 200, await nextCategorizationCard(exclude));
    }
    return send(res, 400, { error: "mode måste vara 'categorization' eller 'comparison'" });
  }
  if (url.pathname === "/swipe/decide" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* tom */ }
    // use_house: ENDAST categorization ("husets kategori har rätt, min gissning inte" -
    // saknar motsvarighet i comparison, se kollen längre ned).
    const decision = body.decision === "approve" || body.decision === "reject" || body.decision === "use_house"
      ? body.decision : null;
    if (!decision) return send(res, 400, { error: "decision måste vara 'approve', 'reject' eller 'use_house'" });
    if (!body.house || !body.external_id) return send(res, 400, { error: "house + external_id krävs" });
    if (body.mode === "categorization") {
      await decideCategorization(String(body.house), String(body.external_id), decision);
      return send(res, 200, { ok: true });
    }
    if (body.mode === "comparison") {
      if (decision === "use_house") return send(res, 400, { error: "use_house gäller bara categorization" });
      if (!body.cmp_house || !body.cmp_external_id) return send(res, 400, { error: "cmp_house + cmp_external_id krävs" });
      await decideComparison(
        String(body.house), String(body.external_id),
        String(body.cmp_house), String(body.cmp_external_id), decision,
      );
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: "mode måste vara 'categorization' eller 'comparison'" });
  }

  // Adressförslag medan man skriver (ruttplaneraren) - ORS autocomplete, Nominatim-fallback.
  // Admin: ruttplaneraren är en personlig funktion och anropen kostar ORS-kvot.
  if (url.pathname === "/geocode/suggest") {
    if (!requireAdmin(req, res)) return;
    if (!rateLimit(req, res, "geocode", 60, 60_000)) return;
    const q = url.searchParams.get("q") ?? "";
    return send(res, 200, { suggestions: await geocodeSuggest(q) });
  }

  // Ruttoptimering: användaren skickar depå + stopp → bästa ordning + tidslinje.
  if (url.pathname === "/route/optimize" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    if (!rateLimit(req, res, "route", 30, 60_000)) return;
    let body: RouteReqIn;
    try {
      body = JSON.parse(await readBody(req)) as RouteReqIn;
    } catch {
      return send(res, 400, { error: "ogiltig JSON-body" });
    }
    try {
      const result = await optimizeRoute(body);
      return send(res, 200, result);
    } catch (e) {
      return send(res, 400, { error: String(e instanceof Error ? e.message : e) });
    }
  }

  // /items/:house/:externalId
  if (parts.length === 3 && parts[0] === "items") {
    const [, house, externalId] = parts;
    const item = await pool.query(
      `SELECT * FROM items WHERE house=$1 AND external_id=$2`,
      [house, externalId],
    );
    if (item.rowCount === 0) return send(res, 404, { error: "okänt objekt" });
    // Publikt: bara källans URL (m.url) skickas - aldrig vår lokala spegel (local_path).
    // Speglingen finns kvar på disk för AI/embedding men serveras/exponeras inte utåt.
    const media = await pool.query(
      `SELECT kind, url, sort FROM media
       WHERE house=$1 AND owner_type='item' AND owner_external_id=$2 ORDER BY sort`,
      [house, externalId],
    );
    const bids = await pool.query(
      `SELECT external_id, value, type, bidder_id, bidder_name, created_at FROM bids
       WHERE house=$1 AND item_external_id=$2 ORDER BY value DESC LIMIT 100`,
      [house, externalId],
    );
    const row = item.rows[0] as { leader_name?: string | null; raw?: unknown; title?: string | null; description?: string | null; attrs?: ItemAttrs | null; category?: string | null };
    const me = process.env.MY_BIDDER?.toLowerCase();
    const youLead =
      me != null && (row.leader_name ?? "").toLowerCase() === me;
    // Fordonsdata (biluppgifter-cachen) via objektets regnr - BARA för fordon (annars
    // kan ett spuriöst regnr-attribut på ett icke-fordon (Svenskt Tenn-fyndet 2026-07-06)
    // slå upp en tillfälligt matchande bils data). null om ej fordon/ej slaget.
    const isVehicle = (row.category ?? "").startsWith("fordon");
    const reg = isVehicle ? regnrForItem({ title: row.title ?? null, description: row.description ?? null, attrs: row.attrs ?? null }) : null;
    const vehicleRaw = reg != null ? await loadVehicleData(reg) : null;
    const vehicle = vehicleRaw != null && !("notFound" in vehicleRaw) ? vehicleRaw : null;
    // Vi lagrar hela råpayloaden, men dumpar den bara på begäran (?raw=1).
    if (url.searchParams.get("raw") !== "1") delete row.raw;
    return send(res, 200, {
      item: row,
      leader: row.leader_name ?? null,
      youLead,
      vehicle,
      media: media.rows,
      bids: bids.rows,
    });
  }

  send(res, 404, { error: "okänd route" });
}

export function startApi(port = Number(process.env.PORT ?? 3000)): void {
  // Vägrar starta i produktion utan admin-lösenord (annars vore skyddet öppet).
  assertAuthConfig();
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: String(e) }));
  });
  server.listen(port, () => {
    console.log(`API lyssnar på http://localhost:${port}`);
    console.log(`  prova: http://localhost:${port}/items?q=truck`);
  });
}
