/**
 * Kategori-klassning. Per objekt: TITEL (+ beskrivning) klassas med nyckelordsregler (mest
 * pålitliga per-objekt-signalen, house-agnostisk). Hus-kategorin används bara som fallback
 * när texten är tvetydig, och ignoreras om den är en catch-all ("Övrigt/Diverse/Varuparti").
 * Returnerar en taxonomi-nyckel "huvud/under" (se taxonomy.ts) eller "ovrigt/diverse".
 *
 * Mönster matchar STAMMAR som delsträng (fångar svenska pluraler + sammansättningar:
 * "cykel"→sportcykel/cyklar, "väsk"→väska/väskor) - INGEN avslutande ordgräns. Korta/tvetydiga
 * ord får ledande \b (t.ex. \bring, \bbil) för att undvika falska träffar. Nordiska stavningar
 * (da/no: maleri, bordlampe, sofa) täcks där Auctionet-utbudet kräver det.
 */

import { OVRIGT } from "./taxonomy.ts";

function norm(s: string | null | undefined): string {
  return ` ${String(s ?? "").toLowerCase().replace(/\s+/g, " ")} `;
}

/** [regel, "huvud/under"] i PRIORITETSORDNING (specifik före generell). Första träff vinner. */
const RULES: [RegExp, string][] = [
  // --- Fordon (a-traktor & tunga fordon först) ---
  [/a-?traktor|epatraktor/, "fordon/atraktor"],
  [/husbil|integrerad husbil/, "fordon/husbil-husvagn"],
  [/husvagn|husvagnar|campingvagn/, "fordon/husbil-husvagn"],
  [/sk[åa]pbil|sk[åa]psbil|transportbil|pickup|budbil|servicebil/, "fordon/transportbil"],
  [/lastbil|dragbil|lastv[äa]xlare|tippbil|kranbil|flakbil|lastbilar/, "fordon/lastbil-buss"],
  [/minibuss|\bbuss/, "fordon/lastbil-buss"],
  [/sl[äa]pvagn|sl[äa]pk[äa]rra|\btrailer|sl[äa]pk|\bsl[äa]p\b|b[åa]tvagn/, "fordon/slap-trailer"],
  [/motorcykel|\bmc\b|\bmoped|scooter|vespa|fyrhjuling|\batv\b|sn[öo]skoter|snöscoter|crosshoj/, "fordon/mc-moped-atv"],
  [/d[äa]ck|f[äa]lg|bildel|stötf[åa]ngare|bilstereo|\breservdel|avgassystem|kamrem|piggkedjor|sn[öo]kedjor|dragkrok/, "fordon/bildelar"],
  [/personbil|\bsuv\b|halvkombi|st[äa]tionsvagn|cabriolet|\bsedan\b|\bkombi\b|laddhybrid|elbil|\bsaloon\b|veteranbil/, "fordon/personbilar"],
  [/\b(volvo|volkswagen|\bvw\b|audi|\bbmw|mercedes|toyota|\bkia\b|hyundai|skoda|\bford\b|renault|peugeot|nissan|tesla|porsche)\b/, "fordon/personbilar"],

  // --- Båt & marint ---
  [/utombordare|utombordsmotor|inombordare|b[åa]tmotor|utombords/, "bat/batmotor"],
  [/flytv[äa]st|r[äa]ddningsv[äa]st|b[åa]ttillbeh[öo]r|f[öo]rt[öo]jning|\bankare|b[åa]tdel|b[åa]tkapell|akterspegel/, "bat/battillbehor"],
  [/motorb[åa]t|segelb[åa]t|daycruiser|roddb[åa]t|gummib[åa]t|\bjolle|vattenskoter|\bb[åa]t\b|b[åa]tar|snipa|\bkajak|\bkanot/, "bat/batar"],

  // --- Entreprenad & industri ---
  [/gr[äa]vmaskin|minigr[äa]v|hjulgr[äa]v|b[äa]ltegr[äa]v|gr[äa]vlastare|\bdumper|bandgr[äa]v/, "entreprenad/gravmaskin-lastare"],
  [/hjullastare|lastmaskin|hjulladdare|kompaktlastare|redskapsb[äa]rare|minilastare/, "entreprenad/gravmaskin-lastare"],
  [/gaffeltruck|motviktstruck|st[åa]truck|ledstaplare|\btruck|skjutstativtruck/, "entreprenad/truck"],
  [/industrimaskin|verkstadsmaskin|\bcnc|pelarborr|metallsvarv|kantpress|plasmask[äa]r|generator|elverk/, "entreprenad/industri-verkstad"],
  [/entreprenad|\bskopa|planeringsskopa|smalskopa|grusskopa|palletgafflar|redskapsf[äa]ste/, "entreprenad/redskap"],

  // --- Lantbruk & skog ---
  [/skogsmaskin|sk[öo]rdare|\bskotare|vedklyv|vedmaskin|timmerv[äa]gn|flishugg|motors[åa]g/, "lantbruk/skogsmaskin"],
  [/traktor/, "lantbruk/traktor"],
  [/\bharv|\bpl[öo]g|s[åa]maskin|g[öo]dselspridare|balpress|tallriksredskap|vallsk[öo]rd|jordbearbet|gr[öo]dor/, "lantbruk/jordbruk"],
  [/gr[äa]sklippare|[åa]kgr[äa]sklippare|robotgr[äa]sklippare|\btrimmer|l[öo]vbl[åa]s|jordfr[äa]s|sn[öo]slunga|gr[öo]nyta/, "lantbruk/gronyta"],

  // --- Verktyg & maskiner ---
  [/kompressor|luftkompressor|h[öo]gtryckstv[äa]tt|dr[äa]nkbar pump|vattenpump|\bpump\b/, "verktyg/kompressor-pump"],
  [/\bsvets|verktygsvagn|verktygssk[åa]p|arbetsb[äa]nk|skruvst[äa]d|b[äa]nkslip|slipmaskin|slipsten/, "verktyg/verkstad"],
  [/borrmaskin|vinkelslip|cirkels[åa]g|sticks[åa]g|kaps[åa]g|skruvdragare|mutterdragare|handverktyg|hylsnyckel|\bverktyg|slagborr|mejsel|hyvel|listhyvel|f[äa]rgspruta|h[öo]gtryckspruta|spikpistol|tigers[åa]g|trappstege|arbetsbock|\bstege\b|batteri.*(milwaukee|makita|bosch|dewalt|hilti|ryobi)|\bslipband/, "verktyg/handverktyg"],

  // --- Bygg & trädgård ---
  [/\bkakel|klinker|\bgolv|parkett|laminatgolv|badrum|\bdusch|handfat|toalett|blandare|\bwc\b|badkar|kommod/, "bygg/golv-kakel-bad"],
  [/byggmaterial|gipsskiva|reglar|\bvirke|isolering|takpl[åa]t|taksten|takstege|armering|\bbetong|c-profil|lagervara|\bplank|skruv|\bbult\b|\bmutter|\bspik\b|inf[äa]stning|g[åa]ngj[äa]rn|\bbeslag|ytterd[öo]rr|innerd[öo]rr|paneld[öo]rr|\bd[öo]rr\b|karmm[åa]tt/, "bygg/byggmaterial"],
  [/tr[äa]dg[åa]rd|pergola|utem[öo]bel|utem[öo]bl|v[äa]xthus|\bstaket|uteplats|\bgrill|markis|studsmatta|sols[äa]ng|vils[äa]ng|grensax|sekat[öo]r|h[äa]cksax/, "bygg/tradgard"],

  // --- Smycken, guld & klockor ---
  [/armbandsur|\bfickur|herrur|damur|v[äa]ggur|golvur|bordsur|\brolex|\bomega\b|tag heuer|\bpatek|breitling|longines|\bseiko|tissot|chronograf|\bur i guld/, "smycken/klockor"],
  [/diamantring|f[öo]rlovningsring|vigselring|guldring|\bring\b|\bringar/, "smycken/smycken-sub"],
  [/halsband|halskedja|guldkedja|silverkedja|collier|\barmband|[öo]rh[äa]nge|berlock|\bh[äa]nge|\bsmycke|\bbrosch|manschettknapp|\bkedja i guld/, "smycken/smycken-sub"],
  [/guldtacka|silvertacka|guldmynt|[äa]delsten|\bsafir|\brubin|smaragd|vitguld|r[öo]dguld|18k|14k|925 silver|\bbriljant|nysilver|silverbestick|silversked|silverfat|silverskål/, "smycken/guld-silver"],

  // --- Samla: mynt/frimärke före antikt (mynt har ofta årtal → skulle annars bli "antikt") ---
  [/frim[äa]rke|frim[äa]rkssamling|\bmaerker\b|briefmarke/, "samla/frimarken"],
  [/mynt\b|\bsedel\b|sedlar|numismatik|myntsamling|\bmedalj|\bpolletter/, "samla/mynt"],

  // --- Konst & antikt (nordiska + eng/tyska stavningar för Auctionet) ---
  [/oljem[åa]lning|oljor? p[åa] duk|akvarell|litografi|\btavla|tavlor|\bm[åa]lning|konstverk|skulptur|\betsning|serigrafi|\bsignerad|gouache|\bblyerts|\bteckning|\bpastell|tr[äa]snitt|\bmaleri|oil on canvas|oil painting|\bpainting|watercolo|lithograph|\bsculpture|\bgem[äa]lde|\bgrafik|collage|vy [öo]ver/, "konst/konst-tavlor"],
  [/orientmatta|persisk matta|\bkelim|\brya\b|handkn[uy]ten|\bmatta\b|mattor|\bteppich|\bcarpet|\brug\b/, "konst/mattor"],
  [/antikvitet|\bantik\b|1600-tal|1700-tal|1800-tal|gustaviansk|allmoge|\bbarock|\brokoko|jugend/, "konst/antikt"],

  // --- Möbler & inredning ---
  [/taklampa|golvlampa|bordslampa|bordlampe|gulvlampe|ljuskrona|takkrona|kristallkrona|\blampa|\blampor|\bpendel|v[äa]gglampa|belysning|armatur|lysestage/, "mobler/belysning"],
  [/porslin|servis|kristall|\bvas\b|\bvaser|karaff|keramik|stengods|kosta boda|orrefors|r[öo]rstrand|gustavsberg|\bterrin|\bkarott|\bfat\b|tallrik|glas\b|glasbruk|snapsglas|vinglas|champagneglas|dricksglas|[öo]lglas|\bremmare|\bpokal|\bskål\b|figurin|\bbowl\b/, "mobler/porslin-glas"],
  [/\bspegel|speglar|spegelram/, "mobler/prydnad"],
  [/\bsoffa|\bsofa\b|f[åa]t[öo]lj|matbord|soffbord|\bs[äa]ng\b|byr[åa]|garderob|bokhylla|\bsk[äa]nk|vitrin|matgrupp|\bstol\b|\bstolar|\bbord\b|sekret[äa]r|kommod|pinnstol|karmstol|h[öo]rnsk[åa]p|kl[äa]dsk[åa]p|pl[åa]tsk[åa]p|st[åa]lsk[åa]p|lampbord|avlastningsbord|sidobord|tv-?b[äa]nk|tv-?bord|mediab[äa]nk/, "mobler/mobler-sub"],

  // --- Hem & hushåll ---
  [/kylsk[åa]p|\bkyl\b|\bfrys\b|tv[äa]ttmaskin|torktumlare|diskmaskin|\bspis\b|\bugn\b|mikrov[åa]gsugn|vitvaror|induktionsh[äa]ll|kokplatta/, "hem/vitvaror"],
  [/kastrull|stekpanna|k[öo]ksredskap|\bbestick|husger[åa]d|kaffebryggare|kaffemaskin|espressomaskin|\bmixer|matberedare|glassmaskin|\bblender/, "hem/husgerad-kok"],
  [/pallst[äa]ll|lagerhylla|f[öo]rvaringssk[åa]p|hyllst[äa]ll|f[öo]rvaring|\bhylla|hyllor|\bskohylla/, "hem/forvaring"],

  // --- Data & elektronik ---
  [/3d-?skrivare|3d-?printer|3d printer/, "elektronik/datorer"],
  [/\bdator(?!spel)|\blaptop|b[äa]rbar dator|station[äa]r|bildsk[äa]rm|\bsk[äa]rm|tangentbord|\bskrivare|\bserver|\brouter|\bswitch\b|n[äa]tverk/, "elektronik/datorer"],
  [/\bkamera|systemkamera|objektiv|\bcanon\b|\bnikon\b|dr[öo]nare|\bgopro|\bblixt\b|hasselblad/, "elektronik/foto"],
  // \btv\b(?!...): "tv" men INTE "tv-spel" (→ media/tvspel) eller "tv-bänk/bord" (→ möbler). Datorspel likaså ovan.
  [/\btv\b(?!-?(spel|b[äa]nk|bord))|television|h[öo]gtalare|f[öo]rst[äa]rkare|receiver|soundbar|hemmabio|\bstereo|skivspelare|vinylspelare|\bradio/, "elektronik/ljud-bild-tv"],
  [/\bmobil|smartphone|\biphone|surfplatta|\bipad\b|samsung galaxy/, "elektronik/mobil"],

  // --- Sport & fritid ---
  [/dykutrustning|dykset|dykdr[äa]kt|v[åa]tdr[äa]kt|torrdr[äa]kt|dykflaska|simf[öo]tter|snorkel|paddleboard|\bsup\b|windsurf|wakeboard/, "sport/vattensport"],
  [/l[öo]pband|crosstrainer|motionscykel|spinningcykel|skivst[åa]ng|\bhantlar|tr[äa]ningsmaskin|benpress|multigym|\bgym\b|romaskin|magb[äa]nk|träningsb[äa]nk/, "sport/gym"],
  [/mountainbike|\belcykel|racercykel|\bcykel|cyklar/, "sport/cykel"],
  [/\bjakt|vapensk[åa]p|kikarsikte|\bfiske|fiskesp[öo]|kastsp[öo]|\bt[äa]lt|s[öo]vs[äa]ck|friluft|\bskidor|snowboard/, "sport/jakt-fiske"],

  // --- Restaurang, butik & kontor ---
  [/fris[öo]r|beh[äa]ndlingsb[äa]nk|sk[öo]nhetssalong|solarium|frisörvagn|nagelbord/, "restaurang/frisor-skonhet"],
  [/storkök|proffsk[öo]k|kombiugn|kyldisk|frysdisk|storkoksutrustning|serveringsvagn|\bproffs/, "restaurang/restaurang-storkok"],
  [/kontorsm[öo]bler|kontorsstol|skrivbord|konferensbord|kontorssk[åa]p/, "restaurang/kontor"],
  [/butiksinredning|kassadisk|butikshyll|skyltdocka|kl[äa]dst[äa]ll|butiksdisk|klädställning/, "restaurang/butik"],

  // --- Skönhet & hälsa (konsument) ---
  [/parfym|eau de (?:toilette|parfum)|\bdoft\b|aftershave/, "skonhet/parfym"],
  [/\bsmink|make-?up|l[äa]ppstift|mascara|foundation|[öo]gonskugga|nagellack|highlighter/, "skonhet/smink"],
  [/hudv[åa]rd|ansiktskr[äa]m|\bserum\b|schampo|\bbalsam\b|h[åa]rv[åa]rd|body lotion|ansiktsmask/, "skonhet/hudvard"],

  // --- Kläder, mode & accessoarer ---
  [/barnkl[äa]der|barnskor|babykl[äa]der|\bbody\b.*barn|barnjacka/, "klader/barnklader"],
  [/handv[äa]sk|resv[äa]sk|ryggs[äa]ck|louis vuitton|\bgucci|\bv[äa]ska|v[äa]skor|plånb[öo]|\bkoffert/, "klader/vaskor"],
  [/solglas[öo]gon|\bb[äa]lte|\bsjal\b|accessoar|\bscarf/, "klader/accessoarer"],
  [/jacka|\bkappa|kl[äa]nning|\bkostym|\bskor\b|k[äa]ng|\bst[öo]vlar|\bkl[äa]der|\bpäls|byxor|tr[öo]ja|skjorta|kalsonger|underkl[äa]der|\bstrumpor/, "klader/klader-skor"],

  // --- Musik, film & spel (media) ---
  [/vinyl|lp-?skiva|vinylskiva|grammofonskiva|\b7"?-?singel|\blp-?box/, "media/vinyl"],
  [/\bcd-?skiva|\bcd-?box|musikkassett|kassettband|\bmc-?band/, "media/cd-kassett"],
  [/\bdvd\b|blu-?ray|\bvhs\b|laserdisc|filmsamling/, "media/film"],
  [/tv-?spel|datorspel|nintendo|playstation|\bxbox|\bnes\b|\bsnes\b|game ?boy|gamecube|\bwii\b|\bps[1-5]\b|megadrive|mega drive|dreamcast|sega (?:mega|master|saturn|genesis)|spelkassett|game genie/, "media/tvspel"],
  [/spelkonsol|\bkonsol\b|handkontroll|arkadspel|arkadmaskin|pinball|flipperspel|jukebox/, "media/konsol"],

  // --- Böcker & tidningar ---
  [/serietidning|seriealbum|seriemagasin|\bfantomen\b|kalle anka|\bbamse\b|\btintin\b|mangaalbum|\bmanga\b/, "samla/serietidningar"],
  [/veckotidning|\btidning|\bmagasin\b|[åa]rg[åa]ng.*(tidning|magasin)/, "bocker/tidningar"],
  [/\bkarta\b|\bkartor\b|sj[öo]kort|kopparstick|litografisk karta/, "bocker/kartor-tryck"],
  [/\bbok\b|b[öo]cker|f[öo]rstautg[åa]va|antikvariat|bokverk|\binbunden|bibel\b/, "bocker/bocker-sub"],

  // --- Samla & hobby ---
  [/samlarkort|\btcg\b|pok[eé]mon-?kort|magic the gathering|hockeykort|fotbollskort|\bpanini/, "samla/samlarkort"],
  [/militaria|\buniform|hj[äa]lm m\/|\bbajonett|\bordnar\b|\bregemente|milit[äa]r.*(hj[äa]lm|k[åa]rd|medalj)/, "samla/militaria"],
  [/vykort|\bansiktskort|\bstereobild/, "samla/vykort"],
  [/gitarr|\bpiano|\bflygel|\bfiol|trumset|keyboard|\bsynt\b|musikinstrument|dragspel|\bbanjo|\bcello\b/, "samla/instrument"],
  [/modellbygge|modellbil|modellflyg|skalmodell|\bairfix|warhammer|diecast|byggsats.*modell/, "samla/modell-hobby"],
  [/\blego\b|barbie|br[äa]dspel|\bpussel|\bleksak|docksk[åa]p|\bnalle\b|gosedjur|actionfigur|playmobil|\bbrio\b/, "samla/leksaker"],
  [/vintage|\bretro\b|samlarobjekt|emaljskylt|nostalgi|reklamskylt/, "samla/vintage"],

  // --- Djur & lantliv ---
  [/\bh[äa]st\b|ridutrustning|\bsadel|hoppsadel|schabrak|\bgrimma|\bbetsel|ridsport/, "djur/hastsport"],
  [/hundbur|kattträd|akvarium|djurtillbeh[öo]r|hundgrind|\bfoder/, "djur/djurtillbehor"],
];

/** Hus-kategorier som är catch-all → ignorera, låt titeln bestämma. */
const CATCHALL = /^(övrigt|ovrigt|diverse|varuparti|konkurslager|blandat|other|misc)/i;

/**
 * TYPLÖST blandade signaler → "Blandat" ENBART när ingen specifik kategori hittats (t.ex.
 * "dödsbo, diverse föremål", tom blandlåda). En "blandlåda med bult" eller "parti tallrikar"
 * fångas av kategori-reglerna först och blir bult/husgeråd - INTE Blandat. "Blandade
 * dimensioner/storlekar/färger" = variation inom EN typ → aldrig Blandat.
 */
const GENERIC_DIVERSE = /blandl[åa]d|\bd[öo]dsbo|diverse f[öo]rem|diverse saker|diverse prylar|blandat inneh[åa]ll|blandade f[öo]rem|flyttlass|\bdiverse\b|mixed lot|job lot/;

export const PARTIER = "ovrigt/partier";

/**
 * Klassa ur text. En lott hör till EN kategori om alla dess varor gör det (även "parti/blandade
 * storlekar"). Bara lotter som spänner ≥3 VITT SKILDA huvudkategorier = äkta blandlåda → partier.
 * 1-2 kategorier → den mest sannolika (första regelträffen = prioritetsordning). Ingen kategori
 * alls men typlöst-blandat-signal (dödsbo/diverse) → partier. Null om inget alls matchar.
 */
export function classifyByText(title: string, description?: string | null): string | null {
  const t = norm(`${title} ${description ?? ""}`);
  const mains = new Set<string>();
  let first: string | null = null;
  for (const [re, key] of RULES) {
    if (re.test(t)) {
      if (!first) first = key;
      mains.add(key.slice(0, key.indexOf("/")));
    }
  }
  if (mains.size >= 3) return PARTIER; // spänner ≥3 skilda kategorier → äkta blandlåda
  if (first) return first; // 1-2 kategorier → mest sannolik (bult→verktyg, husgeråd-lott→hem)
  if (GENERIC_DIVERSE.test(t)) return PARTIER; // ingen kategori men dödsbo/typlöst diverse
  return null;
}

export type Confidence = "mixed" | "text" | "house" | "none";

/**
 * Full klassning med konfidens: blandlåda (text) alltid först - ett äkta blandat
 * innehåll är sant oavsett vad huset arkiverat det under. Därefter husets EGNA
 * kategori om den finns och inte är en catch-all (hög - beslut 2026-08-01, ur
 * verklig swipe-granskning: husets kategori visade sig genomgående mer träffsäker
 * än våra generiska nyckelordsregler för specifika/ovanliga föremål). Annars
 * nyckelordsregler (medel). Annars "Diverse & Ej klassat" (låg).
 */
export function classify(
  title: string,
  description?: string | null,
  houseCatKey?: string | null,
  houseCatRaw?: string | null,
): { category: string; confidence: Confidence } {
  const byText = classifyByText(title, description);
  if (byText === PARTIER) return { category: PARTIER, confidence: "mixed" };
  if (houseCatKey && !(houseCatRaw && CATCHALL.test(houseCatRaw))) {
    return { category: houseCatKey, confidence: "house" };
  }
  if (byText) return { category: byText, confidence: "text" };
  return { category: OVRIGT, confidence: "none" };
}
