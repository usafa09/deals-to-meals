// One-time backfill: snapshot every existing deal_cache row (kroger,
// ad-extract, walmart) into deal_history, preserving each cache row's
// fetched_at as the captured_at timestamp so the historical record reflects
// when the data was actually fetched, not when this script ran.
//
// Idempotent — re-running skips duplicates via ON CONFLICT DO NOTHING on the
// (chain, item_name, sale_price, captured_at) unique index. Safe to re-run
// after fixing data issues or after additional cache rows accumulate.
//
// Usage: node scripts/analysis/backfill-deal-history.js
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

  console.log(`Connecting to ${process.env.SUPABASE_URL}...`);
  const cacheRows = await fetchEligibleCacheRows(supabase);
  console.log(`Eligible deal_cache rows: ${cacheRows.length}`);

  let attempted = 0;
  const historyRows = [];
  const sourceCounts = {};
  for (const row of cacheRows) {
    for (const item of row.data) {
      attempted++;
      const h = buildHistoryRow(item, row.cache_key, row.fetched_at);
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

  // Sanity-check counters against deal_history before/after the run.
  const { count: beforeCount } = await supabase
    .from("deal_history")
    .select("id", { count: "exact", head: true });
  console.log(`deal_history rows BEFORE: ${beforeCount ?? "unknown"}`);

  console.log(`Inserting in batches...`);
  const inserted = await insertHistoryRows(supabase, historyRows);

  const { count: afterCount } = await supabase
    .from("deal_history")
    .select("id", { count: "exact", head: true });
  console.log(`deal_history rows AFTER:  ${afterCount ?? "unknown"}`);

  console.log("\n=== BACKFILL SUMMARY ===");
  console.log(`  Cache rows scanned:    ${cacheRows.length}`);
  console.log(`  Items attempted:       ${attempted}`);
  console.log(`  Items skipped:         ${skipped}  (no sale_price, empty name, or empty chain)`);
  console.log(`  Items eligible:        ${historyRows.length}`);
  console.log(`  Newly inserted:        ${inserted}`);
  console.log(`  Duplicates ignored:    ${historyRows.length - inserted}`);
  console.log(`  By source (eligible):  ${JSON.stringify(sourceCounts)}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
