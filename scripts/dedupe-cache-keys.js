/**
 * Cache-Key Dedupe Migration
 *
 * One-shot cleanup that consolidates duplicate ad-extract:* cache rows produced
 * before commit "Canonicalize ad-extract cache keys to fix chain duplication".
 *
 * Background: the extract-store handler used to compute storeId via raw
 * `replace(/['\s]+/g, "-")` on the user-typed storeName, so user input variants
 * like "Acme Markets" / "Acme" / "Whole Foods Market" / "Whole Foods" produced
 * different cache keys for the same chain. After the canonicalize fix, no NEW
 * duplicates can be created — but existing cache_cache rows still have the old
 * non-canonical keys until this script runs.
 *
 * Idempotent: safe to re-run. After first run, all rows will be at their
 * canonical keys and subsequent runs will report "0 changes".
 *
 * Run:  node scripts/dedupe-cache-keys.js
 * Test: node scripts/dedupe-cache-keys.js --dry-run   (prints actions, no writes)
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { canonicalizeStoreId } from "../lib/utils.js";

dotenv.config();

const DRY_RUN = process.argv.includes("--dry-run");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  console.log(`🧹 Cache-Key Dedupe Migration${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);
  console.log("=" .repeat(60));

  const { data: rows, error } = await supabase
    .from("deal_cache")
    .select("cache_key, fetched_at, data")
    .like("cache_key", "ad-extract:%");
  if (error) { console.error("❌ Read error:", error.message); process.exit(1); }

  // Skip zip3-keyed rows (cache_key like "ad-extract:store:zip3") — those have
  // their own normalize quirk but are out of scope for this migration.
  const masterRows = rows.filter(r => r.cache_key.split(":").length === 2);
  console.log(`Found ${rows.length} ad-extract:* rows (${masterRows.length} master keys, ${rows.length - masterRows.length} zip3-keyed skipped)\n`);

  // Group by canonical storeId
  const groups = new Map();
  for (const row of masterRows) {
    const storeId = row.cache_key.split(":")[1];
    // Reverse hyphens → spaces to approximate the user-typed storeName, then canonicalize.
    // (canonicalizeStoreId expects storeName-like input with spaces, not storeIds.)
    const storeNameApprox = storeId.replace(/-/g, " ");
    const canonicalId = canonicalizeStoreId(storeNameApprox);
    if (!groups.has(canonicalId)) groups.set(canonicalId, []);
    groups.get(canonicalId).push(row);
  }
  console.log(`Grouped into ${groups.size} canonical chains\n`);

  let renamed = 0, deleted = 0, untouched = 0;

  for (const [canonicalId, rowsInGroup] of groups.entries()) {
    const canonicalKey = `ad-extract:${canonicalId}`;

    if (rowsInGroup.length === 1) {
      const row = rowsInGroup[0];
      if (row.cache_key === canonicalKey) {
        untouched++;
        continue;
      }
      // Single row at non-canonical key → rename
      const len = Array.isArray(row.data) ? row.data.length : 0;
      console.log(`📛 Rename:  ${row.cache_key.padEnd(48)} → ${canonicalKey} (${len} deals, ${row.fetched_at})`);
      if (!DRY_RUN) {
        await supabase.from("deal_cache").upsert({
          cache_key: canonicalKey, fetched_at: row.fetched_at, data: row.data,
        }, { onConflict: "cache_key" });
        await supabase.from("deal_cache").delete().eq("cache_key", row.cache_key);
      }
      renamed++;
      continue;
    }

    // Multiple rows for this canonical → pick winner and merge
    const sorted = [...rowsInGroup].sort((a, b) => {
      const aLen = Array.isArray(a.data) ? a.data.length : 0;
      const bLen = Array.isArray(b.data) ? b.data.length : 0;
      // Prefer non-empty over empty (data=[] is the Commit 1 failure marker)
      if (aLen > 0 && bLen === 0) return -1;
      if (aLen === 0 && bLen > 0) return 1;
      // Both same emptiness: latest fetched_at first
      const aDate = new Date(a.fetched_at).getTime();
      const bDate = new Date(b.fetched_at).getTime();
      if (aDate !== bDate) return bDate - aDate;
      // Final tiebreak: higher count
      return bLen - aLen;
    });
    const winner = sorted[0];

    console.log(`🔀 Merge ${rowsInGroup.length} rows → ${canonicalKey}:`);
    for (const r of rowsInGroup) {
      const len = Array.isArray(r.data) ? r.data.length : 0;
      const tag = r === winner ? "→ KEEP" : "  drop";
      console.log(`     ${tag}  ${r.cache_key.padEnd(48)} (${len} deals, ${r.fetched_at})`);
    }

    if (!DRY_RUN) {
      // Write winner data to canonical key (harmless upsert if winner is already there)
      await supabase.from("deal_cache").upsert({
        cache_key: canonicalKey, fetched_at: winner.fetched_at, data: winner.data,
      }, { onConflict: "cache_key" });
      // Delete every row in the group whose key isn't canonical
      for (const r of rowsInGroup) {
        if (r.cache_key !== canonicalKey) {
          await supabase.from("deal_cache").delete().eq("cache_key", r.cache_key);
          deleted++;
        }
      }
    } else {
      deleted += rowsInGroup.filter(r => r.cache_key !== canonicalKey).length;
    }
    if (winner.cache_key !== canonicalKey) renamed++;
    else untouched++;
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Summary: ${renamed} renamed/merged-to-new-key, ${deleted} duplicate rows deleted, ${untouched} already canonical`);
  if (DRY_RUN) console.log("(DRY RUN — no actual writes performed)");
}

main().catch(e => { console.error("❌ Fatal:", e); process.exit(1); });
