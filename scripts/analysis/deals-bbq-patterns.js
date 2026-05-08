// Memorial Day BBQ patterns analysis. Aggregates discount distributions per
// rolled-up category and per chain. Output is aggregate stats only (no
// item-level data), suitable for the BBQ patterns article copy.
//
// Usage: node scripts/analysis/deals-bbq-patterns.js
//
// Mirrors the fetch + flatten approach from deals-recon.js. Helpers are
// duplicated rather than extracted because the duplication is small and the
// scripts are independent ad-hoc analyses, not a long-lived shared library.
import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "output");
const TODAY_ISO = new Date().toISOString().slice(0, 10);
const OUT_FILE = path.join(OUT_DIR, `deals-bbq-patterns-${TODAY_ISO}.json`);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Category rollups for BBQ analysis ──────────────────────────────────────
// Source categories not in any rollup are dropped from this analysis (coffee,
// tea, cereal, rice, frozen meals, frozen pizza, etc. — not Memorial Day BBQ
// relevant). PANTRY/CONDIMENTS has a special name-based filter applied below.
const ROLLUPS = {
  PROTEINS: ["meat", "pork", "bacon", "sausage", "deli", "hot dogs", "lamb", "chicken", "beef"],
  SEAFOOD: ["seafood", "frozen seafood"],
  PRODUCE: ["produce", "vegetables", "fruit"],
  BAKERY: ["bakery", "bread"],
  DAIRY: ["cheese", "dairy"],
  "PANTRY/CONDIMENTS": ["pantry"], // further filtered by item-name regex below
  SNACKS: ["snacks", "chips"],
  BEVERAGES: ["beverages", "soda", "beer", "juice"],
  DESSERT: ["ice cream", "dessert", "cookies"],
};

const CONDIMENT_NAME_REGEX = /ketchup|mustard|mayo|mayonnaise|bbq sauce|barbecue sauce|relish/i;

const SUBCAT_TO_ROLLUP = {};
for (const [rollup, subcats] of Object.entries(ROLLUPS)) {
  for (const sub of subcats) SUBCAT_TO_ROLLUP[sub] = rollup;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function inferSource(cacheKey) {
  if (cacheKey.startsWith("ad-extract")) return "ad-extract";
  if (cacheKey.startsWith("kroger")) return "kroger";
  return "other";
}
function inferStoreFromKey(cacheKey) {
  return cacheKey.split(":")[1] || cacheKey;
}
function normalizeCategory(c) {
  if (!c || typeof c !== "string") return "uncategorized";
  return c.trim().toLowerCase() || "uncategorized";
}
function priceToNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function buildFlatItem(rawItem, cacheKey, fetchedAt) {
  const source = inferSource(cacheKey);
  return {
    source,
    cache_key: cacheKey,
    fetched_at: fetchedAt,
    store_name: rawItem.storeName || rawItem.store_name || rawItem.store || inferStoreFromKey(cacheKey),
    item_name: rawItem.name || rawItem.title || rawItem.item || "",
    category: normalizeCategory(rawItem.category),
    sale_price: priceToNumber(rawItem.salePrice ?? rawItem.sale_price),
    regular_price: priceToNumber(rawItem.regularPrice ?? rawItem.regular_price),
  };
}

// percentile via linear interpolation; arr must be sorted ascending.
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}
function mean(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function round1(n) {
  if (n == null) return null;
  return Math.round(n * 10) / 10;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Connecting to ${SUPABASE_URL}...`);
  const { data: rows, error } = await supabase
    .from("deal_cache")
    .select("cache_key, data, fetched_at")
    .or("cache_key.like.ad-extract%,cache_key.like.kroger%");
  if (error) { console.error("Supabase query failed:", error.message); process.exit(1); }
  if (!rows || rows.length === 0) { console.error("No matching deal_cache rows."); process.exit(1); }

  console.log(`Fetched ${rows.length} cache rows. Flattening + filtering...`);

  // Flatten all items, then apply BBQ rollup + data-quality filters.
  let earliestFetched = null;
  let latestFetched = null;
  const allItems = [];
  for (const row of rows) {
    if (!Array.isArray(row.data) || row.data.length === 0) continue;
    if (!earliestFetched || row.fetched_at < earliestFetched) earliestFetched = row.fetched_at;
    if (!latestFetched || row.fetched_at > latestFetched) latestFetched = row.fetched_at;
    for (const item of row.data) {
      if (!item || typeof item !== "object") continue;
      allItems.push(buildFlatItem(item, row.cache_key, row.fetched_at));
    }
  }
  console.log(`Total raw items: ${allItems.length}`);

  // ── Filter pipeline ──────────────────────────────────────────────────────
  const filterStats = { total: allItems.length, no_rollup: 0, condiment_skip: 0, missing_price: 0, zero_regular: 0, bogo_corrupt: 0, out_of_band: 0, kept: 0 };
  const enriched = [];
  for (const it of allItems) {
    // Map subcategory to a BBQ rollup. If the source category isn't in any
    // rollup, the item is dropped from this analysis entirely.
    const rollup = SUBCAT_TO_ROLLUP[it.category];
    if (!rollup) { filterStats.no_rollup++; continue; }

    // Within PANTRY/CONDIMENTS, only keep items whose name reads as a BBQ
    // condiment. Everything else in the pantry category (rice, oil, flour,
    // etc.) is irrelevant to Memorial Day BBQ patterns.
    if (rollup === "PANTRY/CONDIMENTS" && !CONDIMENT_NAME_REGEX.test(it.item_name)) {
      filterStats.condiment_skip++;
      continue;
    }

    // Both prices required and parseable.
    if (it.sale_price == null || it.regular_price == null) {
      filterStats.missing_price++;
      continue;
    }

    // Zero/negative regular price — division would produce NaN/Infinity. Drop.
    if (it.regular_price <= 0) {
      filterStats.zero_regular++;
      continue;
    }

    // Drop BOGO-corruption rows where regular < sale (some entries store
    // savings in regularPrice instead of the actual regular price).
    if (it.regular_price < it.sale_price) {
      filterStats.bogo_corrupt++;
      continue;
    }

    const discountPct = ((it.regular_price - it.sale_price) / it.regular_price) * 100;
    if (!Number.isFinite(discountPct) || discountPct < 5 || discountPct > 90) {
      filterStats.out_of_band++;
      continue;
    }

    enriched.push({ ...it, rollup, discount_pct: discountPct });
    filterStats.kept++;
  }
  console.log(`Items after filtering: ${enriched.length}`);
  console.log(`Filter breakdown:`, filterStats);

  // ── Aggregations: per rollup ────────────────────────────────────────────
  const byRollupItems = {};
  const chainsPerRollup = {};
  for (const it of enriched) {
    if (!byRollupItems[it.rollup]) byRollupItems[it.rollup] = [];
    byRollupItems[it.rollup].push(it.discount_pct);
    if (!chainsPerRollup[it.rollup]) chainsPerRollup[it.rollup] = {};
    chainsPerRollup[it.rollup][it.store_name] = (chainsPerRollup[it.rollup][it.store_name] || 0) + 1;
  }

  const byCategory = [];
  for (const [rollup, discounts] of Object.entries(byRollupItems)) {
    const sorted = [...discounts].sort((a, b) => a - b);
    const chainCounts = chainsPerRollup[rollup] || {};
    const chainsWithCoverage = Object.values(chainCounts).filter(c => c >= 5).length;
    byCategory.push({
      rollup,
      subcategories_included: ROLLUPS[rollup],
      items: sorted.length,
      avg_discount_pct: round1(mean(sorted)),
      median_discount_pct: round1(percentile(sorted, 50)),
      p25_discount_pct: round1(percentile(sorted, 25)),
      p75_discount_pct: round1(percentile(sorted, 75)),
      min_discount_pct: round1(sorted[0]),
      max_discount_pct: round1(sorted[sorted.length - 1]),
      chains_with_coverage: chainsWithCoverage,
    });
  }
  byCategory.sort((a, b) => b.avg_discount_pct - a.avg_discount_pct);

  // ── Aggregations: per chain ──────────────────────────────────────────────
  const byChainAll = {};       // chain → array of discount_pct (all items)
  const byChainRollup = {};    // chain → rollup → array of discount_pct
  for (const it of enriched) {
    if (!byChainAll[it.store_name]) byChainAll[it.store_name] = [];
    byChainAll[it.store_name].push(it.discount_pct);
    if (!byChainRollup[it.store_name]) byChainRollup[it.store_name] = {};
    if (!byChainRollup[it.store_name][it.rollup]) byChainRollup[it.store_name][it.rollup] = [];
    byChainRollup[it.store_name][it.rollup].push(it.discount_pct);
  }

  const byChain = [];
  for (const [chain, discounts] of Object.entries(byChainAll)) {
    // Compute per-rollup averages for this chain (only rollups with ≥5 items)
    const rollupStats = [];
    const rollupBuckets = byChainRollup[chain] || {};
    for (const [rollup, vals] of Object.entries(rollupBuckets)) {
      if (vals.length < 5) continue;
      rollupStats.push({ rollup, avg_discount_pct: round1(mean(vals)), items: vals.length });
    }
    rollupStats.sort((a, b) => b.avg_discount_pct - a.avg_discount_pct);
    byChain.push({
      chain,
      items: discounts.length,
      avg_discount_pct: round1(mean(discounts)),
      top_3_categories: rollupStats.slice(0, 3),
    });
  }
  byChain.sort((a, b) => b.avg_discount_pct - a.avg_discount_pct);

  // Chains with too few BBQ-relevant items in the data window produce noisy
  // averages (a single 80%-off item swings the mean). Require ≥20 items for
  // the leaderboard to be a credible "where to shop" signal. Full per-chain
  // data still lands in the JSON output regardless.
  const MIN_CHAIN_ITEMS = 20;
  const byChainQualified = byChain.filter(c => c.items >= MIN_CHAIN_ITEMS);

  // ── Output object ────────────────────────────────────────────────────────
  const out = {
    generated_at: new Date().toISOString(),
    data_window: { earliest: earliestFetched, latest: latestFetched },
    totals: {
      items_after_filtering: enriched.length,
      chains: Object.keys(byChainAll).length,
      chains_qualified_for_leaderboard: byChainQualified.length,
    },
    filter_diagnostics: filterStats,
    leaderboard_min_items: MIN_CHAIN_ITEMS,
    by_category: byCategory,
    by_chain: byChain,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_FILE}`);

  // ── Console summary ─────────────────────────────────────────────────────
  console.log("\n=== TOTALS ===");
  console.log(`  Items after filtering: ${enriched.length}`);
  console.log(`  Chains:                ${Object.keys(byChainAll).length}`);
  console.log(`  Window:                ${earliestFetched?.slice(0,10)} → ${latestFetched?.slice(0,10)}`);

  console.log("\n=== CATEGORY ROLLUPS (sorted by avg discount %) ===");
  console.log("  ROLLUP                  ITEMS  AVG    MEDIAN  P25    P75    RANGE          CHAINS≥5");
  for (const c of byCategory) {
    const range = `${c.min_discount_pct}-${c.max_discount_pct}%`;
    console.log(
      `  ${c.rollup.padEnd(22)}  ${String(c.items).padStart(5)}  ${String(c.avg_discount_pct).padStart(4)}%  ${String(c.median_discount_pct).padStart(5)}%  ${String(c.p25_discount_pct).padStart(4)}%  ${String(c.p75_discount_pct).padStart(4)}%  ${range.padEnd(13)}  ${c.chains_with_coverage}`
    );
  }

  console.log(`\n=== TOP 5 CHAINS BY AVG DISCOUNT % (≥${MIN_CHAIN_ITEMS} items) ===`);
  console.log(`  ${byChainQualified.length} of ${byChain.length} chains meet the ≥${MIN_CHAIN_ITEMS}-item threshold.`);
  for (const ch of byChainQualified.slice(0, 5)) {
    const top3 = ch.top_3_categories.map(t => `${t.rollup} ${t.avg_discount_pct}%`).join(", ") || "(no rollup ≥5 items)";
    console.log(`  ${ch.chain.padEnd(40)} ${String(ch.items).padStart(5)} items  avg ${ch.avg_discount_pct}%`);
    console.log(`    strengths: ${top3}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
