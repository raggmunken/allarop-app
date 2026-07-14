/**
 * Tradera-kategorinamn → vår taxonominyckel. Traderas leaf-namn är granulära men
 * kontextberoende ("Rock"/"Hårdrock" = vinyl-genrer under Musik; "Mangaserier" =
 * serietidningar; "Oljemålningar" = konst). Vi mappar med nyckelordsregler på
 * kategorinamnet och returnerar NULL för genuint tvetydiga namn (Övrigt/Diverse/
 * "Klassiker"/"Musik & film") - de tränas inte på (hellre mindre data än fel).
 *
 * Används för att märka Traderas (titel → vår-kategori) → token-lexikonet (learned.ts).
 * MIN_SHARE-tröskeln i voteTokens är extra brus-skydd om enstaka titlar felmärks.
 */

const RULES: [RegExp, string][] = [
  // Serietidningar (före böcker - "serier" är specifikt)
  [/seri(er|e|magasin)|\bmarvel\b|\bdc\b|disney|fantomen|\bmanga|\bbamse\b|superhj[äa]lte|graphic novel|illustrerade klassiker|\btintin/, "samla/serietidningar"],
  // Tidningar & magasin
  [/tidning|tidskrift|magasin/, "bocker/tidningar"],
  // Böcker (genrer + boktyper)
  [/b[öo]cker|\broman|deckar|\bfantasy\b|skr[äa]ck|thriller|\bpocket|litteratur|biografi|faktab|kokb|barnb|ungdomsb|kapitelb|bilderb|sm[åa]barnsb|reparationsb|instruktionsb|historieb|\bsagor|\blyrik|poesi|antikvariat|\bbibel/, "bocker/bocker-sub"],
  [/\bkartor?\b|sj[öo]kort|kopparstick/, "bocker/kartor-tryck"],

  // Musik (vinyl/genrer) - i Tradera ligger dessa under Musik→Vinyl
  [/vinyl|\blp-?(skiva|box)?\b|grammofon|\brock\b|h[åa]rdrock|\bpop\b|\bjazz\b|\bblues\b|\bpunk\b|\bmetal\b|hip.?hop|\bsoul\b|reggae|\bcountry\b|schlager|dansband|folkmusik|klassisk musik|\balbum\b|singel/, "media/vinyl"],
  [/\bcd-?(skiva|box)?\b|kassettband|musikkassett/, "media/cd-kassett"],
  [/\bdvd\b|blu-?ray|\bvhs\b|familjefilm|tv-serie|\bfilmer\b|laserdisc/, "media/film"],
  [/tv-?spel|datorspel|nintendo|playstation|\bxbox\b|\bsega\b|spelkassett/, "media/tvspel"],
  [/spelkonsol|\bkonsol\b|arkadspel|handkontroll/, "media/konsol"],

  // Konst
  [/oljem[åa]ln|akvarell|litografi|\btavl|\bm[åa]lning|skulptur|\bgrafik\b|konstverk|\betsning|serigrafi/, "konst/konst-tavlor"],
  [/orientmatta|\bmatta\b|mattor|\bkelim|\brya\b/, "konst/mattor"],
  [/antikvitet|allmoge|gustaviansk/, "konst/antikt"],

  // Samla
  [/frim[äa]rke/, "samla/frimarken"],
  [/\bmynt\b|\bsedel\b|sedlar|numismat|polletter|\bmedalj/, "samla/mynt"],
  [/vykort|\bansiktskort/, "samla/vykort"],
  [/samlarkort|\btcg\b|pok[eé]mon.?kort|hockeykort|fotbollskort/, "samla/samlarkort"],
  [/militaria|\buniform|\bbajonett|\bordnar\b|milit[äa]r/, "samla/militaria"],
  [/stickning|s[öo]mnad|\btyger\b|\bgarn\b|virkning|broderi|handarbete|\bpyssel|sytillbeh|symaskin/, "samla/modell-hobby"],
  [/modellbygg|modellbil|modellflyg|skalmodell|\bairfix|warhammer|diecast/, "samla/modell-hobby"],
  [/leksak|\blego\b|barbie|\bdocka\b|dockor|gosedjur|\bnalle\b|actionfigur|playmobil|\bbrio\b/, "samla/leksaker"],
  [/samlarobjekt|samlarsak|reklamskylt|emaljskylt|nostalgi|\bretro\b|vintage/, "samla/vintage"],
  [/musikinstrument|\bgitarr|\bpiano\b|\bfiol\b|trumset|dragspel/, "samla/instrument"],

  // Skönhet
  [/parfym|\bdoft\b|eau de/, "skonhet/parfym"],
  [/\bsmink|make-?up|l[äa]ppstift|mascara|nagellack/, "skonhet/smink"],
  [/hudv[åa]rd|ansiktskr[äa]m|h[åa]rv[åa]rd|schampo/, "skonhet/hudvard"],

  // Elektronik
  [/grafikkort|\bgpu\b|h[åa]rddisk|processor|\bcpu\b|moderkort|\bssd\b|minne \(ram|b[äa]rbar dator|\bdator\b|laptop|tangentbord|bildsk[äa]rm/, "elektronik/datorer"],
  [/vinylspelare|skivspelare|\bstereo|f[öo]rst[äa]rkare|h[öo]gtalare|receiver|soundbar|hemmabio/, "elektronik/ljud-bild-tv"],
  [/mobiltelefon|smartphone|\biphone|surfplatta|\bipad\b|smartwatch|wearable/, "elektronik/mobil"],
  [/systemkamera|\bobjektiv\b|kamerahus|\bblixt\b|\bkameror\b|analog.*kamera|digitalkamera/, "elektronik/foto"],
  [/ram-?minne|arbetsminne/, "elektronik/datorer"],

  // Klockor & smycken
  [/armbandsur|\bfickur\b|\bv[äa]ggur|herrur|damur|\bklockor\b|quartzklock|kvartsur|\bur\b/, "smycken/klockor"],
  [/\bhalsband|\bring\b|\bringar\b|[öo]rh[äa]ng|\bbrosch|\bsmycke|\barmband\b/, "smycken/smycken-sub"],
  [/[äa]delsten|\bdiamant|\bsafir|\brubin|smaragd|guldtacka|silvertacka/, "smycken/guld-silver"],

  // Kläder & skor
  [/kl[äa]nning|\bbyxor|\bjacka|\btr[öo]ja|skjorta|\bkjol\b|\bkostym|kl[äa]der|underkl[äa]der/, "klader/klader-skor"],
  [/\bskor\b|\bst[öo]vlar|sneakers|\bk[äa]ngor|sandaler/, "klader/klader-skor"],
  [/handv[äa]sk|\bv[äa]ska\b|v[äa]skor|pl[åa]nbok|resv[äa]sk|ryggs[äa]ck/, "klader/vaskor"],
  [/barnkl[äa]der|barnskor|babykl/, "klader/barnklader"],

  // Möbler & hem
  [/gustavsberg|r[öo]rstrand|\bkosta\b|orrefors|porslin|\bservis\b|kristall|keramik|stengods|\bvas\b/, "mobler/porslin-glas"],
  [/\bsoffa|f[åa]t[öo]lj|matbord|\bstol\b|byr[åa]|garderob|bokhylla|s[äa]ng\b/, "mobler/mobler-sub"],
  [/taklampa|golvlampa|bordslampa|ljuskrona|\blampa\b|belysning/, "mobler/belysning"],

  // Fordon
  [/bildel|d[äa]ck|\bf[äa]lg|reservdel|stötf[åa]ngare|avgassystem/, "fordon/bildelar"],

  // Sport & fritid
  [/\bcykel\b|mountainbike|elcykel/, "sport/cykel"],
  [/\bjakt\b|\bfiske\b|fiskesp[öo]|friluft/, "sport/jakt-fiske"],
  [/tr[äa]ningsmaskin|l[öo]pband|\bhantlar|\bgym\b/, "sport/gym"],

  // Trädgård
  [/tr[äa]dg[åa]rd|v[äa]xthus|gr[äa]sklippare/, "bygg/tradgard"],
];

/**
 * Mappa ett Tradera-kategorinamn → vår taxonominyckel, eller null om tvetydigt
 * (då tränas objektet inte på). Första matchande regeln vinner.
 */
export function traderaCategoryToKey(name: string | null | undefined): string | null {
  const n = ` ${String(name ?? "").toLowerCase()} `;
  for (const [re, key] of RULES) if (re.test(n)) return key;
  return null;
}
