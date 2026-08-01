# Kategorikonflikt-eskalering + mänsklig granskning (/swipe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix miscategorized items (text-keyword classification silently outranking the house's own category, e.g. a Rolex watch *catalog* filed under "klockor") by flagging text/house disagreements, prioritizing them in the existing LLM/vision classification queues, backfilling the existing backlog, and adding a `/swipe` admin tool for cases AI can't resolve alone.

**Architecture:** A pure conflict-detection function is reused at ingest time and in a resumable backfill pass. Flagged items jump to the front of the two existing classification passes (`llmClassifyPass`, vision pass) via one `ORDER BY` change each — no new classification pipeline. A new `human` confidence tier (rank above `llm`) lets `/swipe` decisions lock in permanently, reusing the existing rank-guard that already protects `llm`/`learned`. `/swipe` reuses the existing admin-cookie auth and the existing `match_verdicts` table for its `comparison` mode.

**Tech Stack:** TypeScript, Postgres, vitest. No new dependencies.

## Global Constraints

- Follow existing SQL conventions exactly: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for schema additions (see `src/db/schema.sql`), rank-guarded `CASE WHEN cat_conf_rank(...)` for anything touching `items.category`/`category_conf`.
- No new npm dependencies (spec: closed-form logic, existing stack covers everything here).
- Reuse existing admin auth (`src/api/auth.ts`: `requireAdmin`, `isAdmin`, `checkPassword`) — do not build a second auth mechanism.
- `ADMIN_PASSWORD` is already set in production `.env.prod` on `root@89.167.78.154` (`/opt/vibecode/apps/allarop/.env.prod`) — no action needed there.
- Tests follow this repo's existing culture: pure-logic unit tests (vitest, `../src/...ts` imports), no DB-integration test harness exists here — don't invent one.

---

### Task 1: Schema — conflict flag, `human` confidence tier, verdict source

**Files:**
- Modify: `src/db/schema.sql`

**Interfaces:**
- Produces: `items.category_conflict` (boolean, default false), `cat_conf_rank('human') = 6`, `match_verdicts.source` (text, default `'ai'`).

- [ ] **Step 1: Add the new columns and function tier**

In `src/db/schema.sql`, find the existing `ALTER TABLE items ADD COLUMN IF NOT EXISTS youtube_link TEXT;` line (part of the incremental-additions block) and add directly after it:

```sql
ALTER TABLE items ADD COLUMN IF NOT EXISTS category_conflict BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS items_category_conflict_idx ON items (category_conflict) WHERE category_conflict;
```

Find the `match_verdicts` table definition and add after its closing `);`:

```sql
ALTER TABLE match_verdicts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ai';
```

Replace the `cat_conf_rank` function body:

```sql
CREATE OR REPLACE FUNCTION cat_conf_rank(conf TEXT) RETURNS int
IMMUTABLE LANGUAGE sql AS $$
  SELECT CASE conf
    WHEN 'human' THEN 6 WHEN 'llm' THEN 5 WHEN 'learned' THEN 4 WHEN 'text' THEN 3
    WHEN 'house' THEN 2 WHEN 'mixed' THEN 1 ELSE 0 END
$$;
```

- [ ] **Step 2: Apply the schema locally to verify it's valid SQL**

Run: `npm run cli -- db-init`
Expected: completes without error (idempotent — safe to rerun even if already applied).

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.sql
git commit -m "feat(db): category_conflict flag, human conf tier, match_verdicts.source"
```

---

### Task 2: Pure conflict-detection module

**Files:**
- Create: `src/categories/conflict.ts`
- Test: `test/conflict.test.ts`

**Interfaces:**
- Consumes: `Confidence` type from `../src/categories/classify.ts` (`"mixed" | "text" | "house" | "none"`, already exported).
- Produces: `topLevel(key: string | null | undefined): string | null`, `detectConflict(textCategory: string, textConfidence: Confidence, houseKey: string | null): boolean` — used by Task 3 (ingest) and Task 5 (backfill).

- [ ] **Step 1: Write the failing tests**

Create `test/conflict.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectConflict, topLevel } from "../src/categories/conflict.ts";

describe("topLevel", () => {
  it("extracts the part before the slash", () => {
    expect(topLevel("smycken/klockor")).toBe("smycken");
  });
  it("returns the whole key when there is no slash", () => {
    expect(topLevel("ovrigt")).toBe("ovrigt");
  });
  it("returns null for null/undefined", () => {
    expect(topLevel(null)).toBeNull();
    expect(topLevel(undefined)).toBeNull();
  });
});

describe("detectConflict", () => {
  it("flags a text/house mismatch at the top level (the Rolex-catalog case)", () => {
    expect(detectConflict("smycken/klockor", "text", "bocker/tidningar")).toBe(true);
  });
  it("does not flag when top-level categories agree", () => {
    expect(detectConflict("smycken/klockor", "text", "smycken/smycken-sub")).toBe(false);
  });
  it("does not flag when there is no house category", () => {
    expect(detectConflict("smycken/klockor", "text", null)).toBe(false);
  });
  it("does not flag a mixed-lot classification", () => {
    expect(detectConflict("ovrigt/partier", "mixed", "bocker/tidningar")).toBe(false);
  });
  it("does not flag house- or learned/llm-sourced classifications (only 'text' can conflict)", () => {
    expect(detectConflict("fordon/personbilar", "house", "elektronik/datorer")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/conflict.test.ts`
Expected: FAIL — `Cannot find module '../src/categories/conflict.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/categories/conflict.ts`:

```ts
/**
 * Konflikt mellan textklassning och husets egen kategori: huvudkategorin
 * (delen före "/") skiljer sig åt. Bara relevant när text hittade en säker
 * träff (conf='text' - inte 'mixed', som är en äkta blandlåda) och huset
 * har en mappad kategori att jämföra mot.
 */
import { Confidence } from "./classify.ts";

export function topLevel(key: string | null | undefined): string | null {
  if (!key) return null;
  const i = key.indexOf("/");
  return i === -1 ? key : key.slice(0, i);
}

export function detectConflict(
  textCategory: string,
  textConfidence: Confidence,
  houseKey: string | null,
): boolean {
  if (textConfidence !== "text") return false;
  if (!houseKey) return false;
  const a = topLevel(textCategory);
  const b = topLevel(houseKey);
  if (a == null || b == null) return false;
  return a !== b;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/conflict.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/categories/conflict.ts test/conflict.test.ts
git commit -m "feat(categories): pure text/house conflict detection"
```

---

### Task 3: Wire conflict detection into ingest

**Files:**
- Modify: `src/db/repo.ts:12` (import), `src/db/repo.ts:84-163` (upsertItem)

**Interfaces:**
- Consumes: `detectConflict` from Task 2.
- Produces: `items.category_conflict` set correctly on every ingest, guarded by the same rank-guard already protecting `category`/`category_conf`.

- [ ] **Step 1: Add the import**

In `src/db/repo.ts`, after line 12 (`import { classify, classifyByText } from "../categories/classify.ts";`), add:

```ts
import { detectConflict } from "../categories/conflict.ts";
```

- [ ] **Step 2: Compute the conflict flag alongside `cat`**

Find (around line 88-92):

```ts
  const hit = it.title ? lexicon.classify(it.title) : null;
  const hc = houseCategoryKey(it.house, it.raw);
  const cat = hit
    ? { category: hit.category, confidence: "learned" }
    : classify(it.title, it.description, hc.key, hc.raw);
```

Replace with:

```ts
  const hit = it.title ? lexicon.classify(it.title) : null;
  const hc = houseCategoryKey(it.house, it.raw);
  const cat = hit
    ? { category: hit.category, confidence: "learned" }
    : classify(it.title, it.description, hc.key, hc.raw);
  const conflict = detectConflict(cat.category, cat.confidence as Confidence, hc.key);
```

Add `Confidence` to the existing import from `classify.ts` (line 12):

```ts
import { classify, classifyByText, Confidence } from "../categories/classify.ts";
```

- [ ] **Step 3: Add the column to the INSERT/UPDATE**

In the same `INSERT INTO items (...)` block, add `category_conflict` to the column list (after `category_conf`):

```sql
                        category, category_conf, category_conflict)
```

Add `$38` to both VALUES rows:

```sql
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38)
```

In the `ON CONFLICT ... DO UPDATE SET` block, extend the existing category rank-guard (around line 143-146):

```sql
           category=CASE WHEN cat_conf_rank(items.category_conf) > cat_conf_rank($37)
                         THEN items.category ELSE $36 END,
           category_conf=CASE WHEN cat_conf_rank(items.category_conf) > cat_conf_rank($37)
                              THEN items.category_conf ELSE $37 END,
           category_conflict=CASE WHEN cat_conf_rank(items.category_conf) > cat_conf_rank($37)
                                   THEN items.category_conflict ELSE $38 END,
           last_seen=now()
```

- [ ] **Step 4: Pass the new parameter**

In the parameter array (around line 161), change:

```ts
      cat.category, cat.confidence,
```

to:

```ts
      cat.category, cat.confidence, conflict,
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/repo.ts
git commit -m "feat(categories): flag text/house category conflicts at ingest"
```

---

### Task 4: Priority ordering + flag-clearing in classification passes

**Files:**
- Modify: `src/ai/classify-llm.ts:284-293` (llmClassifyPass query), `src/ai/classify-llm.ts:311-316` (learned-hit UPDATE), `src/ai/classify-llm.ts:444-459` (selectVisionCandidates), `src/ai/classify-llm.ts:471-478` (writeVerdict UPDATE)

**Interfaces:**
- Consumes: `category_conflict` column from Task 1.
- Produces: conflict-flagged items always classified before the rest of the backlog, in both the text-LLM and vision passes; flag clears once any pass resolves the item.

- [ ] **Step 1: Prioritize conflicts in `llmClassifyPass`'s selection query**

In `src/ai/classify-llm.ts`, find (around line 284-293):

```ts
    `SELECT house, external_id, title, left(description, 500) AS description
     FROM items i
     WHERE status='active' AND title IS NOT NULL
       AND (category_conf IS NULL OR category_conf NOT IN ('llm','learned'))
       AND NOT (house || '/' || external_id = ANY($2::text[]))
       AND NOT EXISTS (SELECT 1 FROM media m WHERE m.house=i.house AND m.owner_type='item'
                         AND m.owner_external_id=i.external_id AND m.kind='image')
     ORDER BY cat_conf_rank(category_conf) ASC, ends_at ASC NULLS LAST
     LIMIT $1`,
```

Change the `ORDER BY` line to:

```sql
     ORDER BY category_conflict DESC, cat_conf_rank(category_conf) ASC, ends_at ASC NULLS LAST
```

- [ ] **Step 2: Clear the flag when the lexicon resolves a conflicted item**

Find the learned-hit UPDATE (around line 311-316):

```ts
        `UPDATE items SET category=$1, category_conf='learned'
         WHERE house=$2 AND external_id=$3
           AND cat_conf_rank(category_conf) < cat_conf_rank('learned')`,
```

Change to:

```ts
        `UPDATE items SET category=$1, category_conf='learned', category_conflict=false
         WHERE house=$2 AND external_id=$3
           AND cat_conf_rank(category_conf) < cat_conf_rank('learned')`,
```

- [ ] **Step 3: Prioritize conflicts in `selectVisionCandidates`**

Find (around line 444-459):

```ts
     WHERE i.status='active' AND i.title IS NOT NULL
       AND (i.category_conf IS NULL OR i.category_conf <> 'llm')
       AND ($3 OR i.category_conf IS DISTINCT FROM 'learned')
       AND NOT (i.house || '/' || i.external_id = ANY($2::text[]))
     ORDER BY cat_conf_rank(i.category_conf) ASC, i.ends_at ASC NULLS LAST
     LIMIT $1`,
```

Change the `ORDER BY` line to:

```sql
     ORDER BY i.category_conflict DESC, cat_conf_rank(i.category_conf) ASC, i.ends_at ASC NULLS LAST
```

- [ ] **Step 4: Clear the flag when vision/text-LLM resolves a conflicted item**

Find `writeVerdict`'s UPDATE (around line 471-478):

```ts
    `UPDATE items SET category=$1, category_conf='llm', lot_count=COALESCE($4, lot_count),
            attrs=CASE WHEN $5::jsonb IS NOT NULL
                       THEN COALESCE(items.attrs, '{}'::jsonb) || $5::jsonb
                       ELSE items.attrs END
     WHERE house=$2 AND external_id=$3`,
```

Change to:

```ts
    `UPDATE items SET category=$1, category_conf='llm', category_conflict=false,
            lot_count=COALESCE($4, lot_count),
            attrs=CASE WHEN $5::jsonb IS NOT NULL
                       THEN COALESCE(items.attrs, '{}'::jsonb) || $5::jsonb
                       ELSE items.attrs END
     WHERE house=$2 AND external_id=$3`,
```

- [ ] **Step 5: Typecheck and run the existing classify-llm test suite (regression check)**

Run: `npm run typecheck && npx vitest run test/classify-llm.test.ts`
Expected: no errors, all existing tests still pass (this task only reorders/extends existing queries, doesn't change response parsing).

- [ ] **Step 6: Commit**

```bash
git add src/ai/classify-llm.ts
git commit -m "feat(categories): prioritize conflict-flagged items in classification queues"
```

---

### Task 5: Backfill sweep for the existing backlog

**Files:**
- Create: `src/categories/backfill-conflict.ts`

**Interfaces:**
- Consumes: `detectConflict`, `topLevel` (Task 2), `getJobState`/`setJobState` (existing, `src/db/repo.ts`), `houseCategoryKey` (existing, `src/categories/houseCategory.ts`).
- Produces: `conflictBackfillPass(batchSize?: number): Promise<{ scanned: number; flagged: number; doneAll: boolean }>` — consumed by Task 6.

- [ ] **Step 1: Write the implementation**

Create `src/categories/backfill-conflict.ts`:

```ts
/**
 * Backfill: sveper REDAN lagrade aktiva 'text'-klassade objekt och flaggar
 * text/hus-konflikter som ingest-flödet (repo.ts) inte fångade eftersom de
 * ingicks INNAN konflikt-flaggan fanns. Ren JS/regex-jämförelse - ingen
 * AI-kostnad. Cursor i job_state (samma mönster som scheduler/backfill.ts);
 * när ett helt svep är klart startar nästa körning om från 0 (säkerhetsnät-
 * omkörning, inte en engångsmigrering).
 */
import { pool } from "../db/pool.ts";
import { getJobState, setJobState } from "../db/repo.ts";
import { classifyByText } from "./classify.ts";
import { houseCategoryKey } from "./houseCategory.ts";
import { detectConflict } from "./conflict.ts";

const JOB = "categorize:conflict-backfill";

export interface ConflictBackfillResult {
  scanned: number;
  flagged: number;
  doneAll: boolean;
}

export async function conflictBackfillPass(batchSize = 200): Promise<ConflictBackfillResult> {
  const state = await getJobState(JOB);
  const { rows } = await pool.query<{
    id: number; house: string; external_id: string; title: string;
    description: string | null; category: string; raw: Record<string, unknown> | null;
  }>(
    `SELECT id, house, external_id, title, description, category, raw
     FROM items
     WHERE status='active' AND category_conf='text'
     ORDER BY id
     OFFSET $1 LIMIT $2`,
    [state.cursor_offset, batchSize],
  );

  let flagged = 0;
  for (const r of rows) {
    const hc = houseCategoryKey(r.house, r.raw);
    const byText = classifyByText(r.title, r.description);
    if (byText == null) continue; // borde inte hända (conf='text' förutsätter en träff), skippa defensivt
    if (detectConflict(byText, "text", hc.key)) {
      await pool.query(`UPDATE items SET category_conflict=true WHERE id=$1`, [r.id]);
      flagged++;
    }
  }

  const doneAll = rows.length < batchSize;
  const newOffset = doneAll ? 0 : state.cursor_offset + rows.length; // klart svep → börja om
  await setJobState(JOB, newOffset, state.total, false); // 'done' hålls false - detta är en återkommande sweep, inte en engångsmigrering
  return { scanned: rows.length, flagged, doneAll };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/categories/backfill-conflict.ts
git commit -m "feat(categories): resumable backfill sweep for text/house conflicts"
```

---

### Task 6: Wire the backfill pass into the scheduler

**Files:**
- Modify: `src/scheduler/poll.ts:64` (interval const), `src/scheduler/poll.ts:343-344` (state vars), `src/scheduler/poll.ts` (pass wiring, after the `llmClassifyPass`/`llmClassifyImagePass` block around line 469)

**Interfaces:**
- Consumes: `conflictBackfillPass` from Task 5.

- [ ] **Step 1: Add the interval constant**

In `src/scheduler/poll.ts`, after line 64 (`const AI_CLASSIFY_INTERVAL_MS = ...`), add:

```ts
const CONFLICT_BACKFILL_INTERVAL_MS = Number(process.env.CONFLICT_BACKFILL_INTERVAL_MS ?? 21_600_000); // 6h - säkerhetsnät, nya objekt flaggas redan vid ingest
```

- [ ] **Step 2: Add the import**

Near the top of `src/scheduler/poll.ts`, alongside the other pass imports (e.g. `import { llmClassifyImagePass, llmClassifyPass } from "../ai/classify-llm.ts";`), add:

```ts
import { conflictBackfillPass } from "../categories/backfill-conflict.ts";
```

- [ ] **Step 3: Add the state variables**

After line 344 (`let llmRunning = false;`), add:

```ts
  let lastConflictBackfill = 0;
  let conflictBackfillRunning = false;
```

- [ ] **Step 4: Wire the pass**

After the vision-classification block (ends around line 469 with the closing `}` following `imageClassifyRunning = false;`), add:

```ts
      // Backfill: flagga text/hus-konflikter i REDAN lagrade objekt (inte bara nya) -
      // ingen AI-kostnad, ren regex-jämförelse. Säkerhetsnät, körs glest.
      if (!conflictBackfillRunning && now - lastConflictBackfill >= CONFLICT_BACKFILL_INTERVAL_MS) {
        lastConflictBackfill = now;
        conflictBackfillRunning = true;
        void conflictBackfillPass()
          .then((r) => {
            if (r.flagged > 0) log(`kategori-konflikt-backfill: ${r.flagged}/${r.scanned} flaggade${r.doneAll ? " (svep klart)" : ""}`);
          })
          .catch((e) => log(`kategori-konflikt-backfill fel: ${(e as Error).message}`))
          .finally(() => {
            conflictBackfillRunning = false;
          });
      }
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/poll.ts
git commit -m "feat(categories): schedule the conflict-backfill sweep"
```

---

### Task 7: `human` confidence tier — swipe categorization DB functions

**Files:**
- Modify: `src/db/repo.ts` (add exports near `getJobState`/`setJobState`, end of file)
- Test: `test/swipe.test.ts`

**Interfaces:**
- Produces: `categorizationDecisionPatch(decision: 'approve' | 'reject'): { category: null; category_conf: 'human' | null; category_conflict: boolean }` (pure, tested), `nextCategorizationCard(): Promise<{house: string; external_id: string; title: string; image: string | null; category: string | null; category_conf: string | null; houseCategoryLabel: string | null} | null>`, `decideCategorization(house: string, externalId: string, decision: 'approve' | 'reject'): Promise<void>`.

- [ ] **Step 1: Write the failing test for the pure decision logic**

Create `test/swipe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { categorizationDecisionPatch } from "../src/db/repo.ts";

describe("categorizationDecisionPatch", () => {
  it("approve locks in the current category as 'human', clears the conflict flag", () => {
    expect(categorizationDecisionPatch("approve")).toEqual({
      category: null, category_conf: "human", category_conflict: false,
    });
  });
  it("reject clears the category and re-flags for priority reclassification", () => {
    expect(categorizationDecisionPatch("reject")).toEqual({
      category: null, category_conf: null, category_conflict: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/swipe.test.ts`
Expected: FAIL — `categorizationDecisionPatch is not a function` (or export not found)

- [ ] **Step 3: Implement the pure function + DB functions**

At the end of `src/db/repo.ts`, add:

```ts
/* ---- /swipe: mänsklig granskning ---- */

/**
 * Beslutslogik för categorization-läget. 'approve': nuvarande kategori
 * behålls (category=null → SQL:en rör inte kolumnen), conf blir 'human'
 * (rank-guarden gör den permanent). 'reject': kategori/conf nollas helt
 * och konflikt-flaggan sätts → objektet hamnar överst i BÅDA
 * klassnings-köerna igen (samma prioritering som Task 4).
 */
export function categorizationDecisionPatch(
  decision: "approve" | "reject",
): { category: string | null; category_conf: "human" | null; category_conflict: boolean } {
  return decision === "approve"
    ? { category: null, category_conf: "human", category_conflict: false }
    : { category: null, category_conf: null, category_conflict: true };
}

export interface SwipeCategorizationCard {
  house: string;
  external_id: string;
  title: string;
  image: string | null;
  category: string | null;
  category_conf: string | null;
  houseCategoryLabel: string | null;
}

/** Nästa kort: konflikt-flaggade FÖRST, annars lägst konfidens (samma prioritering
 * som klassnings-köerna) - så verktyget alltid har något att visa. */
export async function nextCategorizationCard(): Promise<SwipeCategorizationCard | null> {
  const { rows } = await pool.query<{
    house: string; external_id: string; title: string; category: string | null;
    category_conf: string | null; raw: Record<string, unknown> | null;
    image: string | null;
  }>(
    `SELECT i.house, i.external_id, i.title, i.category, i.category_conf, i.raw,
            (SELECT m.url FROM media m WHERE m.house=i.house AND m.owner_type='item'
               AND m.owner_external_id=i.external_id AND m.kind='image'
             ORDER BY m.sort NULLS LAST LIMIT 1) AS image
     FROM items i
     WHERE i.status='active' AND i.title IS NOT NULL AND i.category_conf <> 'human'
     ORDER BY i.category_conflict DESC, cat_conf_rank(i.category_conf) ASC, i.ends_at ASC NULLS LAST
     LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  const hc = houseCategoryKey(r.house, r.raw);
  return {
    house: r.house, external_id: r.external_id, title: r.title, image: r.image,
    category: r.category, category_conf: r.category_conf, houseCategoryLabel: hc.raw,
  };
}

export async function decideCategorization(
  house: string, externalId: string, decision: "approve" | "reject",
): Promise<void> {
  const patch = categorizationDecisionPatch(decision);
  if (decision === "approve") {
    await pool.query(
      `UPDATE items SET category_conf='human', category_conflict=false
       WHERE house=$1 AND external_id=$2`,
      [house, externalId],
    );
  } else {
    await pool.query(
      `UPDATE items SET category=$3, category_conf=$4, category_conflict=$5
       WHERE house=$1 AND external_id=$2`,
      [house, externalId, patch.category, patch.category_conf, patch.category_conflict],
    );
  }
}
```

Add `houseCategoryKey` to the existing import from `../categories/houseCategory.ts` (line 13) if not already the full import — it already is (`import { houseCategoryKey } from "../categories/houseCategory.ts";`), no change needed there.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/swipe.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/repo.ts test/swipe.test.ts
git commit -m "feat(swipe): categorization queue + human-tier decision functions"
```

---

### Task 8: Swipe comparison-mode DB functions + guard AI from overwriting human verdicts

**Files:**
- Modify: `src/db/repo.ts:1071-1085` (`saveMatchVerdict`), end of file (new functions)
- Modify: `src/ai/imageverify.ts` (skip AI verification when a human verdict already exists)

**Interfaces:**
- Produces: `saveMatchVerdict(..., source?: 'ai' | 'human')` (extended), `nextComparisonCard(): Promise<{house, external_id, title, image, cmpHouse, cmpExternalId, cmpTitle, cmpImage, cmpPrice} | null>`, `decideComparison(house, externalId, cmpHouse, cmpExternalId, decision: 'approve' | 'reject'): Promise<void>`.

- [ ] **Step 1: Extend `saveMatchVerdict` with a `source` parameter**

In `src/db/repo.ts`, find (around line 1070-1085):

```ts
/** Spara ett AI-verdikt (idempotent - senaste vinner). */
export async function saveMatchVerdict(
  house: string,
  itemId: string,
  cmpHouse: string,
  cmpId: string,
  verdict: { same: boolean; reason: string; model: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO match_verdicts (house, item_external_id, cmp_house, cmp_external_id, same, reason, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (house, item_external_id, cmp_house, cmp_external_id)
       DO UPDATE SET same=EXCLUDED.same, reason=EXCLUDED.reason, model=EXCLUDED.model, created_at=now()`,
    [house, itemId, cmpHouse, cmpId, verdict.same, verdict.reason, verdict.model],
  );
}
```

Replace with (adds `source`, and a **human verdict is never overwritten**):

```ts
/** Spara ett verdikt (idempotent - senaste vinner, MEN ett 'human'-facit
 * skrivs aldrig över av ett senare 'ai'-facit). */
export async function saveMatchVerdict(
  house: string,
  itemId: string,
  cmpHouse: string,
  cmpId: string,
  verdict: { same: boolean; reason: string; model: string },
  source: "ai" | "human" = "ai",
): Promise<void> {
  await pool.query(
    `INSERT INTO match_verdicts (house, item_external_id, cmp_house, cmp_external_id, same, reason, model, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (house, item_external_id, cmp_house, cmp_external_id)
       DO UPDATE SET same=EXCLUDED.same, reason=EXCLUDED.reason, model=EXCLUDED.model,
                      source=EXCLUDED.source, created_at=now()
       WHERE match_verdicts.source <> 'human' OR EXCLUDED.source = 'human'`,
    [house, itemId, cmpHouse, cmpId, verdict.same, verdict.reason, verdict.model, source],
  );
}

/** Finns redan ett facit (AI eller mänskligt) för paret? Används för att
 * hoppa AI-verifiering när ett mänskligt facit redan finns. */
export async function hasMatchVerdict(house: string, itemId: string, cmpHouse: string, cmpId: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM match_verdicts WHERE house=$1 AND item_external_id=$2 AND cmp_house=$3 AND cmp_external_id=$4`,
    [house, itemId, cmpHouse, cmpId],
  );
  return (r.rowCount ?? 0) > 0;
}
```

- [ ] **Step 2: Add comparison-mode queue + decide functions**

At the end of `src/db/repo.ts` (after Task 7's additions), add:

```ts
export interface SwipeComparisonCard {
  house: string; externalId: string; title: string; image: string | null;
  cmpHouse: string; cmpExternalId: string; cmpTitle: string; cmpImage: string | null; cmpPrice: number | null;
}

/** Nästa jämförelsepar UTAN facit ännu (varken AI eller människa) - hämtar
 * ur den AI-driven prisjämförelsens senaste kandidatpar (est_at nyligen satt). */
export async function nextComparisonCard(): Promise<SwipeComparisonCard | null> {
  const { rows } = await pool.query<{
    house: string; external_id: string; title: string; image: string | null;
    cmp_house: string; cmp_external_id: string; cmp_title: string; cmp_image: string | null; cmp_price: number | null;
  }>(
    `SELECT i.house, i.external_id, i.title,
            (SELECT m.url FROM media m WHERE m.house=i.house AND m.owner_type='item'
               AND m.owner_external_id=i.external_id AND m.kind='image' ORDER BY m.sort NULLS LAST LIMIT 1) AS image,
            ph.house AS cmp_house, ph.external_id AS cmp_external_id, ph.title AS cmp_title,
            (SELECT m.url FROM media m WHERE m.house=ph.house AND m.owner_type='item'
               AND m.owner_external_id=ph.external_id AND m.kind='image' ORDER BY m.sort NULLS LAST LIMIT 1) AS cmp_image,
            ph.price_sek AS cmp_price
     FROM items i
     JOIN price_history ph ON ph.title % i.title  -- trigram-kandidat, samma bas som prisjämförelsen
     WHERE i.status='active' AND i.est_count >= 1
       AND NOT EXISTS (SELECT 1 FROM match_verdicts v
                        WHERE v.house=i.house AND v.item_external_id=i.external_id
                          AND v.cmp_house=ph.house AND v.cmp_external_id=ph.external_id)
     ORDER BY i.ends_at ASC NULLS LAST
     LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    house: r.house, externalId: r.external_id, title: r.title, image: r.image,
    cmpHouse: r.cmp_house, cmpExternalId: r.cmp_external_id, cmpTitle: r.cmp_title,
    cmpImage: r.cmp_image, cmpPrice: r.cmp_price,
  };
}

export async function decideComparison(
  house: string, externalId: string, cmpHouse: string, cmpExternalId: string, decision: "approve" | "reject",
): Promise<void> {
  await saveMatchVerdict(
    house, externalId, cmpHouse, cmpExternalId,
    { same: decision === "approve", reason: "manuell granskning", model: "human" },
    "human",
  );
}
```

- [ ] **Step 3: Guard `imageverify.ts` against overwriting human verdicts**

In `src/ai/imageverify.ts`, find where `saveMatchVerdict` is called before an AI verification request is made (search for the call site), and wrap it with a `hasMatchVerdict` check so an existing verdict (human OR AI, since AI verdicts don't need re-verification either) is never re-queried:

```ts
import { hasMatchVerdict, saveMatchVerdict } from "../db/repo.ts";
// ...at the call site, before making the AI request:
if (await hasMatchVerdict(house, itemId, cmpHouse, cmpId)) continue; // redan avgjort (AI eller människa) - fråga inte igen
```

(Exact insertion point depends on the loop structure already in `imageverify.ts` — place it as the first check inside the per-pair loop, before the AI call.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/repo.ts src/ai/imageverify.ts
git commit -m "feat(swipe): comparison queue + human match_verdicts, never overwritten by AI"
```

---

### Task 9: `/swipe` API routes

**Files:**
- Modify: `src/api/server.ts`

**Interfaces:**
- Consumes: `nextCategorizationCard`, `decideCategorization`, `nextComparisonCard`, `decideComparison` (Tasks 7-8), `requireAdmin` (existing, `src/api/auth.ts`).
- Produces: `GET /swipe/next?mode=categorization|comparison` 🔒, `POST /swipe/decide` 🔒.

- [ ] **Step 1: Add `/swipe` to the noindex SPA-shell list**

Find (around line 309):

```ts
  if (url.pathname === "/rutt" || url.pathname === "/priser" || url.pathname === "/admin") {
    return serveApp(res, { "x-robots-tag": "noindex, nofollow" });
  }
```

Change to:

```ts
  if (url.pathname === "/rutt" || url.pathname === "/priser" || url.pathname === "/admin" || url.pathname === "/swipe") {
    return serveApp(res, { "x-robots-tag": "noindex, nofollow" });
  }
```

- [ ] **Step 2: Add the import**

Near the top of `src/api/server.ts`, alongside other `repo.ts` imports, add the new functions to the existing import list (or add a new import line):

```ts
import {
  nextCategorizationCard, decideCategorization,
  nextComparisonCard, decideComparison,
} from "../db/repo.ts";
```

- [ ] **Step 3: Add the routes**

Find the `/price-lookup` route (an existing 🔒 admin-gated route, around line 854) to use as the template, and add directly after it:

```ts
  if (url.pathname === "/swipe/next" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const mode = url.searchParams.get("mode");
    if (mode === "comparison") return send(res, 200, await nextComparisonCard());
    if (mode === "categorization") return send(res, 200, await nextCategorizationCard());
    return send(res, 400, { error: "mode måste vara 'categorization' eller 'comparison'" });
  }
  if (url.pathname === "/swipe/decide" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* tom */ }
    const decision = body.decision === "approve" || body.decision === "reject" ? body.decision : null;
    if (!decision) return send(res, 400, { error: "decision måste vara 'approve' eller 'reject'" });
    if (body.mode === "categorization") {
      await decideCategorization(String(body.house), String(body.external_id), decision);
      return send(res, 200, { ok: true });
    }
    if (body.mode === "comparison") {
      await decideComparison(
        String(body.house), String(body.external_id),
        String(body.cmp_house), String(body.cmp_external_id), decision,
      );
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: "mode måste vara 'categorization' eller 'comparison'" });
  }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual verification**

Run: `npm run cli -- api` (local dev server), then in another terminal:

```bash
curl -s -c /tmp/c.txt -X POST http://localhost:3000/admin/login -H 'Content-Type: application/json' -d '{"password":"<local ADMIN_PASSWORD from your .env>"}'
curl -s -b /tmp/c.txt 'http://localhost:3000/swipe/next?mode=categorization'
```

Expected: login returns `{"ok":true,"admin":true}`, swipe/next returns a card JSON (or `null` if no active items locally).

- [ ] **Step 6: Commit**

```bash
git add src/api/server.ts
git commit -m "feat(swipe): /swipe/next and /swipe/decide admin API routes"
```

---

### Task 10: `/swipe` frontend view

**Files:**
- Modify: `web/index.html`

**Interfaces:**
- Consumes: `GET /swipe/next?mode=`, `POST /swipe/decide` (Task 9), existing `showAdminGate()`/admin-session-check pattern already used by `/rutt`/`/priser`.

- [ ] **Step 1: Find the existing client-side router**

Locate where `location.pathname` is switched on to render `/rutt`/`/priser`/`/admin` views (search `web/index.html` for `location.pathname === "/rutt"` or the equivalent router function) and note the existing admin-gate pattern used there (`showAdminGate()` call before rendering admin content).

- [ ] **Step 2: Add the `/swipe` route + render function**

Add a `renderSwipe()` function following the same structure as the existing `/rutt`/`/priser` render functions: check admin session (reuse the existing gate), then render a card-stack UI.

Card markup (single active card, mode selector above it):

```html
<div class="swipe-wrap">
  <div class="swipe-modes">
    <button class="swipe-mode active" data-mode="categorization">Kategorisering</button>
    <button class="swipe-mode" data-mode="comparison">Jämförelse</button>
  </div>
  <div id="swipeCard" class="swipe-card"></div>
  <div class="swipe-actions">
    <button id="swipeLeft" aria-label="Fel, pröva igen">✕</button>
    <button id="swipeRight" aria-label="Korrekt">✓</button>
  </div>
</div>
```

JS logic (fetch next card, render, decide on swipe/click/arrow-key, fetch next):

```js
let swipeMode = "categorization";
async function loadSwipeCard() {
  const r = await fetch(`/swipe/next?mode=${swipeMode}`, { credentials: "include" });
  const card = await r.json();
  const el = document.getElementById("swipeCard");
  if (!card) { el.innerHTML = "<p>Inget att granska just nu.</p>"; return; }
  el.dataset.house = card.house || card.house;
  el.dataset.externalId = card.external_id || card.externalId;
  if (swipeMode === "categorization") {
    el.dataset.cmpHouse = ""; el.dataset.cmpExternalId = "";
    el.innerHTML = `<img src="${card.image || ""}" alt=""><h3>${card.title}</h3>
      <p>Nuvarande: ${card.category || "okänd"} (${card.category_conf || "—"})</p>
      <p>Husets kategori: ${card.houseCategoryLabel || "—"}</p>`;
  } else {
    el.dataset.cmpHouse = card.cmpHouse; el.dataset.cmpExternalId = card.cmpExternalId;
    el.innerHTML = `<div class="swipe-pair">
        <div><img src="${card.image || ""}" alt=""><p>${card.title}</p></div>
        <div><img src="${card.cmpImage || ""}" alt=""><p>${card.cmpTitle} - ${card.cmpPrice || "?"} kr</p></div>
      </div><p>Är detta samma typ av föremål?</p>`;
  }
}
async function decideSwipe(decision) {
  const el = document.getElementById("swipeCard");
  const body = { mode: swipeMode, decision, house: el.dataset.house, external_id: el.dataset.externalId };
  if (swipeMode === "comparison") { body.cmp_house = el.dataset.cmpHouse; body.cmp_external_id = el.dataset.cmpExternalId; }
  await fetch("/swipe/decide", {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  loadSwipeCard();
}
document.getElementById("swipeLeft")?.addEventListener("click", () => decideSwipe("reject"));
document.getElementById("swipeRight")?.addEventListener("click", () => decideSwipe("approve"));
document.addEventListener("keydown", (e) => {
  if (location.pathname !== "/swipe") return;
  if (e.key === "ArrowLeft") decideSwipe("reject");
  if (e.key === "ArrowRight") decideSwipe("approve");
});
document.querySelectorAll(".swipe-mode").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".swipe-mode").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  swipeMode = b.dataset.mode;
  loadSwipeCard();
}));
```

Wire `renderSwipe()` into the router the same way `/rutt`/`/priser` are wired (call `loadSwipeCard()` on mount).

- [ ] **Step 3: Add CSS**

Add a `.swipe-wrap`/`.swipe-card`/`.swipe-actions`/`.swipe-modes`/`.swipe-pair` block near the existing `/rutt`/`/priser` styles, matching the existing design tokens (Schibsted Grotesk, cobalt-blue accent — reuse existing CSS custom properties already defined in the file rather than hardcoding new colors).

- [ ] **Step 4: Manual verification in a browser**

Run: `npm run cli -- api`, open `http://localhost:3000/swipe`, log in via the admin gate, confirm:
- A card renders for `categorization` mode.
- Left/right buttons and arrow keys each advance to the next card.
- Switching to `comparison` mode shows a two-item card (or "Inget att granska" if no candidates locally).

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "feat(swipe): Tinder-style admin review UI for categorization + comparison"
```

---

## Self-Review Notes

- **Spec coverage**: conflict flag (Task 1, 3) ✓, backfill (Task 5-6) ✓, vision/text priority (Task 4) ✓, `human` tier (Task 1, 7) ✓, `/swipe` categorization mode (Task 7, 9, 10) ✓, `/swipe` comparison mode reusing `match_verdicts` (Task 8, 9, 10) ✓, admin auth reuse (Task 9) ✓. Not covered here (intentionally, per spec's non-goals): swipe usage stats/dashboard.
- **`ADMIN_PASSWORD`**: already live in production (`.env.prod` on `89.167.78.154`, verified via a successful `/admin/login` call during this session) — no task needed for it.
