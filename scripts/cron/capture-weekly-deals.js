// Weekly snapshot: capture the current state of deal_cache (kroger,
// ad-extract, walmart) into deal_history. Designed to run from GitHub Actions
// every Wednesday morning, after most chains drop their new weekly ads.
//
// FRESHNESS CAVEAT: snapshot-only design. This script does NOT trigger fresh
// OCR extraction or live API calls. It captures whatever is currently in
// deal_cache. If a chain has not been searched (by users or admin) within
// roughly the last 24h, its snapshot will be stale relative to the live
// weekly ad. Coverage improves over time as user traffic plus repeated
// weekly runs accumulate.
//
// Usage: node scripts/cron/capture-weekly-deals.js
import dotenv from "dotenv";
dotenv.config();

import {
  makeSupabase,
  fetchEligibleCacheRows,
  buildHistoryRow,
  insertHistoryRows,
} from "../lib/deal-history.js";

async function main() {
  const supabase = makeSupabase();
  const capturedAt = new Date().toISOString();
  console.log(`Capture run starting at ${capturedAt}`);

  const cacheRows = await fetchEligibleCacheRows(supabase);
  console.log(`Eligible cache rows: ${cacheRows.length}`);

  let attempted = 0;
  const historyRows = [];
  const sourceCounts = {};
  for (const row of cacheRows) {
    for (const item of row.data) {
      attempted++;
      const h = buildHistoryRow(item, row.cache_key, capturedAt);
      if (h == null) continue;
      historyRows.push(h);
      sourceCounts[h.source] = (sourceCounts[h.source] || 0) + 1;
    }
  }
  const skipped = attempted - historyRows.length;
  console.log(
    `Flattened: attempted=${attempted}, eligible=${historyRows.length}, skipped=${skipped}`
  );
  console.log("By source (eligible):", sourceCounts);

  const inserted = await insertHistoryRows(supabase, historyRows);
  const duplicates = historyRows.length - inserted;

  console.log("\n=== CAPTURE SUMMARY ===");
  console.log(`  captured_at:          ${capturedAt}`);
  console.log(`  cache rows scanned:   ${cacheRows.length}`);
  console.log(`  items attempted:      ${attempted}`);
  console.log(`  items skipped:        ${skipped}`);
  console.log(`  items eligible:       ${historyRows.length}`);
  console.log(`  newly inserted:       ${inserted}`);
  console.log(`  duplicates ignored:   ${duplicates}`);
  console.log(`  by source (eligible): ${JSON.stringify(sourceCounts)}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
