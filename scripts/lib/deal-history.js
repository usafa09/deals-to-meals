// Shared helpers for snapshotting deal_cache rows into deal_history.
//
// Used by:
//   scripts/analysis/backfill-deal-history.js  (one-time, captured_at = source fetched_at)
//   scripts/cron/capture-weekly-deals.js       (weekly, captured_at = NOW)
//
// Design: snapshot-only. We never trigger fresh OCR extraction here. Whatever
// is in deal_cache at the moment of capture is what gets recorded. If a chain
// has not been searched recently, the snapshot is stale relative to the live
// weekly ad. Coverage improves over time as user traffic and the weekly cron
// run together accumulate.

import { createClient } from "@supabase/supabase-js";

export function makeSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env");
    process.exit(1);
  }
  return createClient(url, key);
}

export function inferSource(cacheKey) {
  if (cacheKey.startsWith("ad-extract")) return "ad-extract";
  if (cacheKey.startsWith("kroger")) return "kroger";
  if (cacheKey.startsWith("walmart")) return "walmart";
  return "other";
}

export function inferStoreIdFromKey(cacheKey) {
  // ad-extract:foo or ad-extract:foo:zip3 → "foo"
  // kroger:locationId → locationId
  // walmart:national → "national"
  const parts = cacheKey.split(":");
  return parts[1] || cacheKey;
}

export function priceToNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Build a deal_history row from a raw cached item. Returns null if the item
// cannot produce a useful history record:
//   - sale_price unparseable (no discount to track)
//   - item_name empty (cannot identify across captures)
//   - chain empty (cannot group cross-time)
export function buildHistoryRow(rawItem, cacheKey, capturedAt) {
  if (!rawItem || typeof rawItem !== "object") return null;

  const salePrice = priceToNumber(rawItem.salePrice ?? rawItem.sale_price);
  if (salePrice == null) return null;

  const itemName = (rawItem.name || rawItem.title || rawItem.item || "")
    .toString()
    .trim();
  if (!itemName) return null;

  const source = inferSource(cacheKey);
  const storeNameRaw = (
    rawItem.storeName ||
    rawItem.store_name ||
    rawItem.store ||
    inferStoreIdFromKey(cacheKey)
  )
    .toString()
    .trim();
  const chain = storeNameRaw.toLowerCase();
  if (!chain) return null;

  const category = (rawItem.category ?? "").toString().trim().toLowerCase();
  const brand = (rawItem.brand || "").toString().trim();
  const unit = (rawItem.priceUnit || rawItem.unit || "").toString().trim();
  const dealType = (rawItem.dealType || rawItem.deal_type || "").toString().trim();

  // Stable per-chain product identifier for week-over-week item matching. Only
  // the API-sourced chains carry one, and both expose it on the `id` field:
  //   Walmart  -> id = affiliate itemId (e.g. "44391147"); also has `upc`
  //   Kroger   -> id = productId (e.g. "0085706300202"); `upc` is empty
  // OCR / ad-extract deals have no stable id, so product_id stays null for them.
  let productId = null;
  if (source === "walmart" || source === "kroger") {
    const rawId = (rawItem.id ?? rawItem.itemId ?? rawItem.productId ?? "").toString().trim();
    const rawUpc = (rawItem.upc ?? "").toString().trim();
    productId = rawId || rawUpc || null;
  }

  return {
    source,
    chain,
    store_name: storeNameRaw || null,
    store_id: source === "kroger" ? inferStoreIdFromKey(cacheKey) : null,
    product_id: productId,
    item_name: itemName,
    brand: brand || null,
    category: category || null,
    sale_price: salePrice,
    regular_price: priceToNumber(rawItem.regularPrice ?? rawItem.regular_price),
    unit: unit || null,
    deal_type: dealType || null,
    week_start: null,
    captured_at: capturedAt,
  };
}

// Pull deal_cache rows from the three history-eligible sources. Skips empty
// arrays so callers do not have to.
export async function fetchEligibleCacheRows(supabase) {
  const { data, error } = await supabase
    .from("deal_cache")
    .select("cache_key, data, fetched_at")
    .or("cache_key.like.kroger%,cache_key.like.ad-extract%,cache_key.like.walmart%");
  if (error) throw new Error(`deal_cache query failed: ${error.message}`);
  return (data || []).filter(r => Array.isArray(r.data) && r.data.length > 0);
}

// Insert history rows in chunks. Uses ON CONFLICT DO NOTHING against the
// (chain, item_name, sale_price, captured_at) unique index, so re-running is
// safe. Returns the count of newly inserted rows.
export async function insertHistoryRows(supabase, rows, { batchSize = 500 } = {}) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const { data, error } = await supabase
      .from("deal_history")
      .upsert(chunk, {
        onConflict: "chain,item_name,sale_price,captured_at",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) {
      throw new Error(
        `Insert failed at batch ${i}-${i + chunk.length}: ${error.message}`
      );
    }
    inserted += Array.isArray(data) ? data.length : 0;
  }
  return inserted;
}
