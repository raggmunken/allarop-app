/**
 * Spegling av bilder lokalt (aggressiv lagring). Laddar ned media-URL:er som
 * ännu inte har en local_path, deduplicerar via SHA-256 och uppdaterar
 * media-raden. Video laddas inte ned (stor; vi behåller bara URL:en).
 *
 * JURIDISK FLAGGA: lokal spegling av bilder berör upphovsrätt och sajtens ToS.
 * Se risksektionen i planen. Detta lager gör speglingen möjlig men säger inget
 * om publik visning — servera hellre via thumbnail/länk tills licens är bedömd.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pool } from "../db/pool.ts";
import { USER_AGENT } from "../connectors/tovek/actions.ts";

const IMAGE_DIR = process.env.IMAGE_DIR ?? "./data/images";

function extFor(url: string): string {
  const clean = url.split("?")[0] ?? url;
  const e = extname(clean).toLowerCase();
  return e && e.length <= 5 ? e : ".jpg";
}

interface PendingMedia {
  id: number;
  url: string;
}

/**
 * Ladda ned upp till `limit` ospeglade bilder. Returnerar antal nedladdade.
 */
export async function mirrorPendingImages(limit = 200): Promise<number> {
  // Spegla bara bilder för AKTIVA objekt — historiska/avslutade objekts
  // bild-URL:er sparas men laddas inte ned (sparar disk vid backfill).
  const res = await pool.query<PendingMedia>(
    `SELECT m.id, m.url FROM media m
     JOIN items i ON i.house=m.house AND i.external_id=m.owner_external_id
     WHERE m.owner_type='item' AND m.kind='image' AND m.local_path IS NULL
       AND i.status='active'
     ORDER BY m.id ASC
     LIMIT $1`,
    [limit],
  );
  let count = 0;
  for (const row of res.rows) {
    try {
      const resp = await fetch(row.url, { headers: { "User-Agent": USER_AGENT } });
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      const sha = createHash("sha256").update(buf).digest("hex");
      const subdir = join(IMAGE_DIR, sha.slice(0, 2));
      await mkdir(subdir, { recursive: true });
      const path = join(subdir, sha + extFor(row.url));
      await writeFile(path, buf);
      await pool.query(
        `UPDATE media SET local_path=$1, sha256=$2, downloaded_at=now() WHERE id=$3`,
        [path, sha, row.id],
      );
      count++;
    } catch {
      // hoppa över enskild bild vid fel
    }
  }
  return count;
}
