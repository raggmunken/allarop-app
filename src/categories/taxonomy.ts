/**
 * Enhetlig kategoritaxonomi (2 nivåer: huvud → under) för hela aggregatorn. Alla hus mappas
 * hit. Nyckeln (t.ex. "fordon/personbilar") är stabil och lagras på items; etiketterna är
 * det som visas i UI:t. "ovrigt" är alltid sista utväg.
 */

export interface SubCat {
  key: string; // t.ex. "personbilar"
  label: string; // "Personbilar"
}
export interface MainCat {
  key: string; // t.ex. "fordon"
  label: string;
  icon: string; // emoji för UI
  subs: SubCat[];
}

export const TAXONOMY: MainCat[] = [
  {
    key: "fordon", label: "Fordon", icon: "🚗",
    subs: [
      { key: "personbilar", label: "Personbilar" },
      { key: "transportbil", label: "Transport & Skåpbil" },
      { key: "lastbil-buss", label: "Lastbil & Buss" },
      { key: "mc-moped-atv", label: "MC, Moped & ATV" },
      { key: "slap-trailer", label: "Släp & Trailer" },
      { key: "husbil-husvagn", label: "Husbil & Husvagn" },
      { key: "atraktor", label: "A-traktor" },
      { key: "bildelar", label: "Bildelar, Däck & Tillbehör" },
    ],
  },
  {
    key: "bat", label: "Båt & Marint", icon: "⚓",
    subs: [
      { key: "batar", label: "Båtar" },
      { key: "batmotor", label: "Motorer" },
      { key: "battillbehor", label: "Båttillbehör & Säkerhet" },
    ],
  },
  {
    key: "entreprenad", label: "Entreprenad & Industri", icon: "🏗️",
    subs: [
      { key: "gravmaskin-lastare", label: "Grävmaskiner & Lastare" },
      { key: "truck", label: "Truckar" },
      { key: "industri-verkstad", label: "Industri & Verkstad" },
      { key: "redskap", label: "Redskap & Utrustning" },
    ],
  },
  {
    key: "lantbruk", label: "Lantbruk & Skog", icon: "🌾",
    subs: [
      { key: "traktor", label: "Traktorer" },
      { key: "skogsmaskin", label: "Skogsmaskiner" },
      { key: "jordbruk", label: "Jordbruksredskap" },
      { key: "gronyta", label: "Grönyta & Trädgårdsmaskiner" },
    ],
  },
  {
    key: "verktyg", label: "Verktyg & Maskiner", icon: "🔧",
    subs: [
      { key: "handverktyg", label: "Hand- & Elverktyg" },
      { key: "verkstad", label: "Verkstadsutrustning" },
      { key: "kompressor-pump", label: "Kompressorer & Pumpar" },
    ],
  },
  {
    key: "bygg", label: "Bygg & Trädgård", icon: "🧱",
    subs: [
      { key: "byggmaterial", label: "Byggmaterial" },
      { key: "golv-kakel-bad", label: "Golv, Kakel & Badrum" },
      { key: "tradgard", label: "Trädgård & Uteplats" },
    ],
  },
  {
    key: "konst", label: "Konst & Antikt", icon: "🎨",
    subs: [
      { key: "konst-tavlor", label: "Konst & Tavlor" },
      { key: "antikt", label: "Antikt" },
      { key: "design-retro", label: "Design & Retro" },
      { key: "mattor", label: "Mattor" },
    ],
  },
  {
    key: "smycken", label: "Smycken, Guld & Klockor", icon: "💎",
    subs: [
      { key: "smycken-sub", label: "Smycken" },
      { key: "klockor", label: "Armbandsur & Klockor" },
      { key: "guld-silver", label: "Guld, Silver & Ädelstenar" },
    ],
  },
  {
    key: "mobler", label: "Möbler & Inredning", icon: "🛋️",
    subs: [
      { key: "mobler-sub", label: "Möbler" },
      { key: "belysning", label: "Belysning" },
      { key: "porslin-glas", label: "Porslin, Glas & Keramik" },
      { key: "prydnad", label: "Prydnad & Inredning" },
    ],
  },
  {
    key: "hem", label: "Hem & Hushåll", icon: "🏠",
    subs: [
      { key: "vitvaror", label: "Vitvaror" },
      { key: "husgerad-kok", label: "Husgeråd & Kök" },
      { key: "forvaring", label: "Förvaring & Hyllor" },
    ],
  },
  {
    key: "elektronik", label: "Data & Elektronik", icon: "💻",
    subs: [
      { key: "datorer", label: "Datorer & Kringutrustning" },
      { key: "ljud-bild-tv", label: "Ljud, Bild & TV" },
      { key: "mobil", label: "Mobil & Telefoni" },
      { key: "foto", label: "Foto & Kamera" },
    ],
  },
  {
    key: "sport", label: "Sport & Fritid", icon: "⚽",
    subs: [
      { key: "gym", label: "Gym & Träning" },
      { key: "cykel", label: "Cykel" },
      { key: "vattensport", label: "Vattensport & Dyk" },
      { key: "jakt-fiske", label: "Jakt, Fiske & Friluft" },
      { key: "camping", label: "Camping" },
    ],
  },
  {
    key: "restaurang", label: "Restaurang, Butik & Kontor", icon: "🍽️",
    subs: [
      { key: "restaurang-storkok", label: "Restaurang & Storkök" },
      { key: "butik", label: "Butik & Butiksinredning" },
      { key: "kontor", label: "Kontor" },
      { key: "frisor-skonhet", label: "Frisör & Skönhet" },
    ],
  },
  {
    key: "klader", label: "Kläder, Mode & Accessoarer", icon: "👕",
    subs: [
      { key: "klader-skor", label: "Kläder & Skor" },
      { key: "barnklader", label: "Barnkläder & Barnskor" },
      { key: "vaskor", label: "Väskor" },
      { key: "accessoarer", label: "Accessoarer" },
    ],
  },
  {
    key: "skonhet", label: "Skönhet & Hälsa", icon: "💄",
    subs: [
      { key: "parfym", label: "Parfym & Doft" },
      { key: "smink", label: "Smink & Makeup" },
      { key: "hudvard", label: "Hudvård & Hår" },
    ],
  },
  {
    key: "media", label: "Musik, Film & Spel", icon: "🎵",
    subs: [
      { key: "vinyl", label: "Vinyl" },
      { key: "cd-kassett", label: "CD & Kassett" },
      { key: "film", label: "Film & DVD" },
      { key: "tvspel", label: "TV- & Datorspel" },
      { key: "konsol", label: "Spelkonsoler" },
    ],
  },
  {
    key: "bocker", label: "Böcker & Tidningar", icon: "📖",
    subs: [
      { key: "bocker-sub", label: "Böcker" },
      { key: "tidningar", label: "Tidningar & Magasin" },
      { key: "kartor-tryck", label: "Kartor & Tryck" },
    ],
  },
  {
    key: "samla", label: "Samla & Hobby", icon: "📚",
    subs: [
      { key: "mynt", label: "Mynt & Sedlar" },
      { key: "frimarken", label: "Frimärken" },
      { key: "serietidningar", label: "Serietidningar" },
      { key: "samlarkort", label: "Samlarkort & Kort" },
      { key: "militaria", label: "Militaria" },
      { key: "vykort", label: "Vykort & Bilder" },
      { key: "instrument", label: "Musikinstrument" },
      { key: "modell-hobby", label: "Modell & Hobby" },
      { key: "leksaker", label: "Leksaker" },
      { key: "vintage", label: "Vintage & Samlarobjekt" },
    ],
  },
  {
    key: "djur", label: "Djur & Lantliv", icon: "🐴",
    subs: [
      { key: "hastsport", label: "Hästsport & Ridutrustning" },
      { key: "djurtillbehor", label: "Djurtillbehör" },
    ],
  },
  {
    key: "ovrigt", label: "Blandat & Övrigt", icon: "📦",
    subs: [
      { key: "partier", label: "Blandat & Partier" }, // blandlådor, dödsbo, heterogena partier
      { key: "varuparti", label: "Varuparti & Konkurslager" },
      { key: "diverse", label: "Diverse & Ej klassat" },
    ],
  },
];

/** Snabb uppslagning: "huvud/under"-nyckel → etiketter. */
export const CAT_LABELS: Record<string, { main: string; sub: string; icon: string }> = {};
for (const m of TAXONOMY) {
  for (const s of m.subs) {
    CAT_LABELS[`${m.key}/${s.key}`] = { main: m.label, sub: s.label, icon: m.icon };
  }
}

export const OVRIGT = "ovrigt/diverse";
