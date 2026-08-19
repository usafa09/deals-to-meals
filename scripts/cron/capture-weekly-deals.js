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
  // Which cache keys actually yielded at least one usable row. Tracked by KEY,
  // not by chain name: item.storeName is free-text OCR output ("Cub Foods -
  // Fridley", "Hannaford Supermarket", "GIANT") that does not normalize back to
  // the cache-key slug, so name matching reports ~19 false positives.
  const productiveStoreIds = new Set();
  for (const row of cacheRows) {
    for (const item of row.data) {
      attempted++;
      const h = buildHistoryRow(item, row.cache_key, capturedAt);
      if (h == null) continue;
      historyRows.push(h);
      sourceCounts[h.source] = (sourceCounts[h.source] || 0) + 1;
      const sid = row.cache_key.split(":")[1];
      if (sid) productiveStoreIds.add(sid);
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

  // Capture guard: kroger and walmart are the API-sourced chains (not OCR), so a
  // zero eligible count means their upstream fetch/cache is wedged. Log per-chain
  // rows for each source, then FAIL the run (nonzero exit) if EITHER captured
  // nothing — so the GitHub Actions run shows red instead of a silent green that
  // hides a missing chain.
  const chainCounts = { kroger: {}, walmart: {} };
  for (const h of historyRows) {
    if (h.source === "kroger" || h.source === "walmart") {
      chainCounts[h.source][h.chain] = (chainCounts[h.source][h.chain] || 0) + 1;
    }
  }
  const krogerTotal = sourceCounts["kroger"] || 0;
  const walmartTotal = sourceCounts["walmart"] || 0;
  console.log("\n=== CAPTURE GUARD ===");
  console.log(`  kroger rows by chain:  ${JSON.stringify(chainCounts.kroger)}`);
  console.log(`  kroger total:          ${krogerTotal}`);
  console.log(`  walmart rows by chain: ${JSON.stringify(chainCounts.walmart)}`);
  console.log(`  walmart total:         ${walmartTotal}`);

  // Rot visibility for the OCR chains. These are deliberately NOT part of the
  // exit-code guard above (an individual chain going quiet is normal-ish and
  // shouldn't redden the run), but they were previously invisible here:
  // fetchEligibleCacheRows drops empty arrays, so a chain whose extraction wrote
  // the []-on-zero-deals failure marker disappears from this report entirely.
  // That is the exact shape of the Meijer outage (Aug 7-19: status "ready",
  // zero rows, nothing in any summary). Re-query the ad-extract keys directly so
  // "in the rotation" is measured by having a cache row at all, not by having
  // usable data. Report only.
  const { data: adKeys, error: adKeyErr } = await supabase
    .from("deal_cache")
    .select("cache_key")
    .like("cache_key", "ad-extract%");
  if (adKeyErr) {
    console.log(`  OCR chains with zero deals this week: (query failed: ${adKeyErr.message})`);
  } else {
    // ad-extract:foo and ad-extract:foo:454 both collapse to the store id "foo".
    const rotation = new Set();
    for (const r of adKeys || []) {
      const id = r.cache_key.split(":")[1];
      if (id) rotation.add(id);
    }
    const zero = [...rotation].filter(id => !productiveStoreIds.has(id)).sort();
    console.log(
      `  OCR chains with zero deals this week: ${zero.length}` +
      (zero.length ? ` (${zero.join(", ")})` : "")
    );
  }

  if (krogerTotal === 0 || walmartTotal === 0) {
    console.error(
      `GUARD FAILED: a source captured zero rows (kroger=${krogerTotal}, walmart=${walmartTotal}). ` +
      `Upstream deal_cache is likely wedged for that chain. Failing the run.`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
