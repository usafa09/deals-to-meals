// Flatten deal_cache into a single item-level view, compute headline totals
// + category breakdown + a random sample, and dump everything to JSON for
// inspection. Intended for ad-hoc research (current target: Memorial Day BBQ
// data report); not part of the deploy pipeline.
//
// Usage: node scripts/analysis/deals-recon.js
//
// Output JSON is written to scripts/analysis/output/, which is gitignored.
import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "output");
const TODAY_ISO = new Date().toISOString().slice(0, 10);
const OUT_FILE = path.join(OUT_DIR, `deals-recon-${TODAY_ISO}.json`);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function inferSource(cacheKey) {
  if (cacheKey.startsWith("ad-extract")) return "ad-extract";
  if (cacheKey.startsWith("kroger")) return "kroger";
  return "other";
}

function inferStoreFromKey(cacheKey) {
  // ad-extract:foo or ad-extract:foo:zip3 → "foo"
  // kroger:locationId → locationId
  const parts = cacheKey.split(":");
  return parts[1] || cacheKey;
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
    brand: rawItem.brand || "",
    category: normalizeCategory(rawItem.category),
    sale_price: priceToNumber(rawItem.salePrice ?? rawItem.sale_price),
    sale_price_raw: rawItem.salePrice ?? rawItem.sale_price ?? null,
    regular_price: priceToNumber(rawItem.regularPrice ?? rawItem.regular_price),
    regular_price_raw: rawItem.regularPrice ?? rawItem.regular_price ?? null,
    unit: rawItem.unit || rawItem.priceUnit || "",
    size: rawItem.size || "",
    deal_type: rawItem.dealType || rawItem.deal_type || "",
    notes: rawItem.notes || "",
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  console.log(`Connecting to ${SUPABASE_URL}...`);

  // Pull all deal_cache rows whose key starts with ad-extract or kroger.
  // Supabase .or() takes a comma-separated PostgREST filter expression.
  const { data: rows, error } = await supabase
    .from("deal_cache")
    .select("cache_key, data, fetched_at")
    .or("cache_key.like.ad-extract%,cache_key.like.kroger%");

  if (error) {
    console.error("Supabase query failed:", error.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.error("No matching deal_cache rows.");
    process.exit(1);
  }

  console.log(`Fetched ${rows.length} cache rows. Flattening...`);

  // Track row-level info before flattening so we can report cache-empty rows
  // distinctly from non-array rows.
  const rowDiagnostics = { total: rows.length, with_items: 0, empty_array: 0, non_array: 0 };
  let earliestFetched = null;
  let latestFetched = null;
  const flat = [];

  for (const row of rows) {
    const data = row.data;
    if (!Array.isArray(data)) {
      rowDiagnostics.non_array++;
      continue;
    }
    if (data.length === 0) {
      rowDiagnostics.empty_array++;
      continue;
    }
    rowDiagnostics.with_items++;
    if (!earliestFetched || row.fetched_at < earliestFetched) earliestFetched = row.fetched_at;
    if (!latestFetched || row.fetched_at > latestFetched) latestFetched = row.fetched_at;
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      flat.push(buildFlatItem(item, row.cache_key, row.fetched_at));
    }
  }

  console.log(`Flattened to ${flat.length} item rows.`);

  // ── Aggregations ────────────────────────────────────────────────────────
  const bySource = {};
  const byCategory = {};
  const storeSet = new Set();

  for (const it of flat) {
    bySource[it.source] = bySource[it.source] || { items: 0, stores: new Set(), categories: new Set() };
    bySource[it.source].items++;
    bySource[it.source].stores.add(it.store_name);
    bySource[it.source].categories.add(it.category);
    storeSet.add(it.store_name);
    byCategory[it.category] = (byCategory[it.category] || 0) + 1;
  }

  // Convert source-Sets → counts
  const bySourceOut = {};
  for (const [k, v] of Object.entries(bySource)) {
    bySourceOut[k] = { items: v.items, unique_stores: v.stores.size, unique_categories: v.categories.size };
  }

  const totals = {
    items: flat.length,
    unique_stores: storeSet.size,
    unique_categories: Object.keys(byCategory).length,
    earliest_fetched: earliestFetched,
    latest_fetched: latestFetched,
  };

  const categoriesTop30 = Object.entries(byCategory)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  const sampleItems = shuffle(flat).slice(0, 20);

  const out = {
    generated_at: new Date().toISOString(),
    totals,
    by_source: bySourceOut,
    cache_row_diagnostics: rowDiagnostics,
    categories_top_30: categoriesTop30,
    sample_items: sampleItems,
  };

  // ── Write file ─────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_FILE}`);

  // ── Console summary ────────────────────────────────────────────────────
  console.log("\n=== TOTALS ===");
  console.log(JSON.stringify(totals, null, 2));
  console.log("\n=== BY SOURCE ===");
  console.log(JSON.stringify(bySourceOut, null, 2));
  console.log("\n=== CACHE ROW DIAGNOSTICS ===");
  console.log(JSON.stringify(rowDiagnostics, null, 2));
  console.log("\n=== TOP 30 CATEGORIES ===");
  for (const { category, count } of categoriesTop30) {
    console.log(`  ${String(count).padStart(6)}  ${category}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
