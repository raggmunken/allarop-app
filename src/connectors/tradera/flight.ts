/**
 * Parser för Traderas SSR-flight (Next.js App Router, RSC). Sök-/kategorisidor
 * bäddar in resultatet i `self.__next_f.push([1,"...eskapad JSON..."])` under
 * action-typen `discover/receiveSearchResults`. Vi hämtar sidans färdiga HTML via
 * CloakBrowser (browserFetch) och plockar ut resultatobjektet här.
 *
 * Vi lagrar BARA pris/objekt-fält - aldrig säljarens identitet (GDPR): sellerAlias
 * och sellerMemberId tas medvetet inte med i normaliseringen (se map.ts).
 */

const MARKER = "discover/receiveSearchResults";

/** Ett rått sålt-objekt ur Traderas sökresultat (delmängd av fälten). */
export interface RawTraderaItem {
  itemId: number;
  price?: number;
  buyNowPrice?: number;
  shortDescription?: string;
  itemUrl?: string;
  itemType?: string; // "Auction" | "PureBin" | "ContactOnly"
  totalBids?: number;
  startDate?: string;
  endDate?: string;
  isActive?: boolean;
  categoryId?: number;
  reservedPriceReached?: boolean;
  imageUrlTemplate?: string;
  imageSecondaryUrlTemplate?: string;
  sellerIsCompany?: boolean;
  sellerCountryCodeIso2?: string;
}

export interface CategoryChild {
  id: number;
  name: string;
  count: number;
}

export interface SoldSearchResult {
  totalItemCount: number;
  itemsMatchedWithCap: number;
  items: RawTraderaItem[];
  /** Direkta underkategorier till den valda noden (för adaptiv recursion). */
  childCategories: CategoryChild[];
}

/**
 * Avkoda en JS-stränglitteral (så som den står i sidans <script>): \" -> ", \\ -> \,
 * \/ -> /, \n \t \r \b \f och \uXXXX. Robust nog för Traderas flight (titlar kan
 * innehålla citattecken/backslash). Returnerar giltig JSON-text.
 */
function unescapeJsString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const n = s[i + 1];
    switch (n) {
      case '"': out += '"'; i++; break;
      case "\\": out += "\\"; i++; break;
      case "/": out += "/"; i++; break;
      case "n": out += "\n"; i++; break;
      case "t": out += "\t"; i++; break;
      case "r": out += "\r"; i++; break;
      case "b": out += "\b"; i++; break;
      case "f": out += "\f"; i++; break;
      case "u": {
        const hex = s.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else {
          out += ch;
        }
        break;
      }
      default: out += ch;
    }
  }
  return out;
}

/** Extrahera ett balanserat {...}-objekt som börjar vid `startBrace` (string-aware). */
function extractObject(s: string, startBrace: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startBrace; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(startBrace, i + 1);
    }
  }
  return null;
}

/** Sök rekursivt efter en filter-nod med parameter==="categoryId" och returnera dess categoryTree. */
function findCategoryTree(node: unknown): any | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  if (obj.parameter === "categoryId" && obj.categoryTree) return obj.categoryTree;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = findCategoryTree(v);
      if (found) return found;
    }
  }
  return null;
}

/** Hitta den djupast valda noden i categoryTree och returnera dess barn (id+count). */
function selectedChildren(tree: any): CategoryChild[] {
  let node = tree;
  // Följ isSelected nedåt så länge det finns en vald bland barnen.
  for (;;) {
    const kids: any[] = Array.isArray(node?.children) ? node.children : [];
    const sel = kids.find((k) => k?.isSelected);
    if (sel) node = sel;
    else break;
  }
  const kids: any[] = Array.isArray(node?.children) ? node.children : [];
  return kids
    .filter((k) => k && typeof k.id === "number")
    .map((k) => ({ id: k.id, name: String(k.name ?? ""), count: Number(k.count ?? 0) }));
}

/**
 * Plocka ut sålt-resultatet ur en Tradera-sidas HTML. Kastar om markören saknas
 * (sidan blockerades / strukturen ändrades) så uppringaren kan hantera det.
 */
export function parseSoldSearch(html: string): SoldSearchResult {
  const m = html.indexOf(MARKER);
  if (m < 0) throw new Error("Tradera: receiveSearchResults saknas (blockerad eller ändrad struktur?)");
  // Fönster runt markören; resultatobjektet ligger i EN push-sträng.
  const win = html.slice(m, m + 4_000_000);
  const rk = win.indexOf('result\\":');
  const startRaw = rk >= 0 ? win.indexOf("{", rk) : -1;
  if (startRaw < 0) throw new Error("Tradera: result-objekt hittades inte");
  // Un-escapa hela fönstret från result-objektets start, extrahera sedan balanserat objekt.
  const unesc = unescapeJsString(win.slice(startRaw));
  const objText = extractObject(unesc, 0);
  if (!objText) throw new Error("Tradera: kunde inte balansera result-objektet");
  const result = JSON.parse(objText) as any;

  const items: RawTraderaItem[] = Array.isArray(result.items) ? result.items : [];
  const tree = findCategoryTree(result);
  const childCategories = tree ? selectedChildren(tree) : [];
  return {
    totalItemCount: Number(result.totalItemCount ?? items.length),
    itemsMatchedWithCap: Number(result.itemsMatchedWithCap ?? 500),
    items,
    childCategories,
  };
}
