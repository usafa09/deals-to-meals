// Weekly snapshot: capture the current state of deal_cache (kroger,
// ad-extract) into deal_history. Designed to run from GitHub Actions
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

  // Capture guard. Kroger is the one API-sourced chain left (Walmart was retired
  // Aug 2026), so a zero eligible count there means its upstream fetch/cache is
  // wedged. ad-extract is guarded on a FLOOR rather than on zero: the OCR corpus
  // is an aggregate across ~20 cron chains plus whatever organic traffic filled
  // in, and it fails by thinning, not by vanishing. A run that captures 3 rows
  // across 58 chains is as broken as one that captures none, and a bare zero
  // check waves it through.
  //
  // AD_EXTRACT_FLOOR = 50. The weekly workflow extracts 20 chains and tolerates
  // up to 5 failures (.github/workflows/weekly-deals.yml, FAIL_COUNT > 5), so a
  // working week has >= 15 productive chains. Both that workflow and the
  // extract-store handler treat 10 deals as a chain's healthy floor, which puts
  // a merely-degraded week near 150 rows. 50 sits at a third of that: low enough
  // that a bad-but-working week cannot redden the run, high enough to catch a
  // collapse to a handful of chains.
  const AD_EXTRACT_FLOOR = 50;
  const chainCounts = { kroger: {} };
  for (const h of historyRows) {
    if (h.source === "kroger") {
      chainCounts[h.source][h.chain] = (chainCounts[h.source][h.chain] || 0) + 1;
    }
  }
  const krogerTotal = sourceCounts["kroger"] || 0;
  const adExtractTotal = sourceCounts["ad-extract"] || 0;
  const adExtractChains = new Set(
    historyRows.filter(h => h.source === "ad-extract").map(h => h.chain)
  ).size;
  console.log("\n=== CAPTURE GUARD ===");
  console.log(`  kroger rows by chain:  ${JSON.stringify(chainCounts.kroger)}`);
  console.log(`  kroger total:          ${krogerTotal}`);
  console.log(`  ad-extract total:      ${adExtractTotal} (floor ${AD_EXTRACT_FLOOR}, across ${adExtractChains} chains)`);

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

  if (krogerTotal === 0 || adExtractTotal < AD_EXTRACT_FLOOR) {
    console.error(
      `GUARD FAILED: kroger=${krogerTotal} (need > 0), ` +
      `ad-extract=${adExtractTotal} across ${adExtractChains} chains (need >= ${AD_EXTRACT_FLOOR}). ` +
      `Upstream deal_cache is likely wedged. Failing the run.`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
