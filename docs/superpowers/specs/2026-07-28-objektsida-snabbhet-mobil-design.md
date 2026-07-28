# Objektsidan: snabbare öppning + enkel scroll på mobil

## Bakgrund

När man öppnar ett auktionsobjekt (`openDetail()` i `web/index.html`) tar det
märkbart lång tid innan något visas förutom "Laddar…", och på mobil tar
bilden en stor del av skärmen med bara lite utrymme kvar att scrolla i för
beskrivning, budhistorik osv.

Root-cause-analys (uppmätt live mot allarop.se, 2026-07-28):

- `GET /items/{house}/{id}` ≈ 230 ms.
- `GET /price-stats?house=...&id=...` ≈ 900 ms, och `openDetail()` väntar in
  BÅDA sekventiellt innan `sheet.innerHTML` sätts med annat än "Laddar…".
- I `/price-stats`-hanteraren (`src/api/server.ts`) försöker koden, om
  objektets bild saknar en cachad AI-embedding, embedda bilden live via
  ALPR-sidecaren (`embedImage()` → hämtar bilden + POST:ar till
  `${ALPR_URL}/embed`), racead mot ett 1.5s-tak
  (`Promise.race([embedImage(...), timeout(1500)])`).
- ALPR-sidecaren (`alpr`) är **permanent avstängd** i digitalbyra-driften
  (ingen GPU på servern, se `services/allarop/README.md`). Det betyder att
  detta försök **aldrig kan lyckas** där, och nästan varje objektöppning
  betalar upp till 1.5 s i onödan.
- Kodbasen har redan ett cachat health-check-mönster för precis detta
  (`alprAvailable()`, cachar svaret 60 s) och använder det på samma sätt i
  `ocr-enrich.ts` och `embed-enrich.ts` — men inte i `/price-stats`-flödet.
- På mobil (`@media(max-width:768px)`) är `.vmain{height:44vh}` inuti
  `.sheet{max-height:94vh}`, med en separat scrollbar `.vinfo`-region under.
  Nästlade scroll-regioner känns styva på touch, och `vh` (istället för
  `dvh`) räknas mot mobilens största möjliga viewport (adressfält infällt),
  inte den faktiskt synliga — vilket gör bildsektionen proportionerligt
  större och scroll-utrymmet för resten mindre än CSS:en ser ut att säga.

## Mål

- Objektets bild, titel, pris och beskrivning ska synas nästan direkt efter
  tryck — inte vänta in ett andra, tyngre anrop som ändå bara berikar med en
  "fynd"-indikator.
- På mobil ska hela objektkortet vara EN scrollbar yta, utan nästlad scroll.

Inget kvantitativt tidsmål utöver detta — de identifierade orsakerna
(embed-taxen + serialiserade anrop) är tillräckligt tydliga att åtgärda för
att avgöra om det räcker.

## Ändringar

### A. `src/api/server.ts` — hoppa embed-försöket när sidecaren är nere

I `/price-stats`-hanteraren, runt den befintliga
`if (targetEmbedding == null && row.image != null) { ... }`-blocket: lägg
till en `await alprAvailable()`-guard innan `embedImage()` anropas, samma
mönster som `ocr-enrich.ts`/`embed-enrich.ts` redan använder. `alprAvailable()`
cachar redan svaret i 60 s, så kostnaden är i praktiken noll efter första
anropet per driftsperiod.

Ingen ändring av public-svaret eller av beteendet när sidecaren FAKTISKT är
uppe (t.ex. lokal dev med GPU) — embed-försöket görs precis som idag.

### B. `web/index.html` — sluta blockera rendering på `/price-stats`

I `openDetail()`: rendera `sheet.innerHTML` (bild, titel, prisnedbrytning,
beskrivning, budhistoria, CTA) direkt efter att `/items/{house}/{id}` har
resolvat. Flytta `/price-stats`-anropet till att köras parallellt/efteråt och
injicera `#psbox`-innehållet (och trigga `aiVerify()`-timeouten) när det är
klart — samma icke-blockerande mönster som redan används för
`loadVisualSimilar()` i samma funktion. Om `/price-stats` failar eller är
långsam ska resten av vyn redan vara synlig och användbar.

### C. `web/index.html` — prefetch på touch, inte bara hover

Kortens `prefetchDetail()`-anrop triggas idag bara av `mouseenter` (rad
~125). Lägg till samma anrop på `touchstart` för korten, så mobilanvändare
får samma huvudstart som desktop-användare med hover redan har. Ingen extra
nätverkstrafik jämfört med idag — `touchstart` föregår alltid `click`/tap,
det är bara en tidigare start av samma fetch.

### D. `web/index.html` CSS — enda scrollytan på mobil, bild i naturlig proportion

I `@media(max-width:768px)`-blocket för `.sheet`/`.viewer`/`.vmain`:

- Ta bort den separata scrollregionen: `.vinfo` ska inte längre ha sin egen
  `overflow-y:auto` på mobil — hela `.sheet` scrollar som en enhet.
- `.vmain` byter från `height:44vh` till `aspect-ratio:4/3` som del av det
  normala dokumentflödet, inte en viewport-andel (matchar hur de flesta
  auktionsbilder är beskurna hos källorna; justera vid implementation om
  underlaget visar att kvadratisk sitter bättre).
- `.vthumbs` (miniatyrraden) döljs på mobil till förmån för svep på
  huvudbilden (befintlig `GAL`/`vStep`/`setImg`-logik återanvänds) + en liten
  punktindikator för antal bilder, för att spara vertikalt utrymme.
- `.sheet{max-height:94vh}` byts till `94dvh` med `94vh` som fallback för
  äldre browsers utan `dvh`-stöd.
- Lightboxen (fullskärms-zoom vid tryck på bilden) ändras inte.

Desktop-layouten (`min-width:769px`, sida-vid-sida-vy) rörs inte alls — bara
mobil-media-queryn ändras.

## Utanför scope

- Själva `/price-stats`-DB-frågans prestanda (utöver embed-taxen) rörs inte
  — om den fortfarande känns långsam efter A+B får det bli ett eget varv.
  Nu blir den i alla fall icke-blockerande för huvudvyn.
- Bildoptimering/komprimering av auktionshusens originalbilder rörs inte —
  bilderna kommer från källornas egna CDN:er, utanför vår kontroll.
- Ingen ändring i hur ALPR-sidecaren fungerar när den FAKTISKT är
  tillgänglig (t.ex. lokal dev) — bara ett snabbare "nej" när den inte är
  det.

## Verifiering

- **A:** `curl -s -o /dev/null -w '%{time_total}\n' 'https://allarop.se/price-stats?house=<hus>&id=<id>'`
  före/efter på ett objekt utan cachad embedding — ska gå från ~0.9s till
  DB-frågans egen tid (embed-försöket bortfaller).
- **B+C:** manuell koll i webbläsarens nätverksflik att `sheet.innerHTML`
  fylls i direkt efter `/items`-svaret, utan att vänta på `/price-stats`.
- **D:** manuell mobilkoll (riktig telefon eller devtools-emulering, inkl.
  med adressfältet synligt) att hela objektkortet scrollar som en enda yta
  ner till budhistoriken.

Inga nya enhetstester — det här är nätverkstajming och CSS/DOM-beteende,
inget grenande logik att fånga i `vitest`. Befintlig testsvit (`npm test`)
ska fortsätta gå grönt eftersom `src/api/server.ts`-ändringen bara lägger
till en tidig-return-guard.
