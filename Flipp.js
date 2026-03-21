/**
 * Universal Grocery Deals Scraper — Powered by Flipp
 * 
 * One scraper to rule them all. Fetches weekly deals from ALL grocery stores
 * near a zip code using Flipp's public search API. No browser, no auth.
 *
 * Covers: Publix, Albertsons, Safeway, Target, Meijer, HEB, Food Lion,
 *         WinCo, Grocery Outlet, Sprouts, and hundreds more.
 *
 * (Keep your existing Kroger, Walmart, and ALDI scrapers — they use
 *  official APIs with better data. This fills in EVERYTHING else.)
 *
 * Run:  node Flipp.js --zip 83713
 * Test: node Flipp.js --zip 83713 --dry-run
 * One store: node Flipp.js --zip 83713 --store "Publix" --dry-run
 *
 * Requires: nothing extra (just Node 18+ with built-in fetch)
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx > -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const ZIP_CODE = getArg("zip", "83713");
const STORE_FILTER = getArg("store", ""); // e.g. "Publix" or "" for all

const supabase = DRY_RUN
  ? null
  : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const FLIPP_API = "https://backflipp.wishabi.com/flipp";

// ══════════════════════════════════════════════════════════════════════
// Search terms — food categories to query
// We search by category rather than browsing flyers, because the search
// API returns deals from ALL nearby stores at once.
// ══════════════════════════════════════════════════════════════════════
const SEARCH_TERMS = [
  // Proteins
  "chicken", "beef", "pork", "ground beef", "steak", "salmon", "shrimp",
  "turkey", "sausage", "bacon", "hot dogs", "tilapia", "cod", "tuna",
  "lamb", "ribs", "roast", "meatballs", "chicken breast", "chicken thighs",
  // Produce
  "apples", "bananas", "oranges", "strawberries", "blueberries", "grapes",
  "avocado", "tomatoes", "potatoes", "onions", "broccoli", "carrots",
  "lettuce", "spinach", "peppers", "celery", "corn", "mushrooms",
  "cucumber", "lemons", "limes",
  // Dairy
  "milk", "eggs", "cheese", "butter", "yogurt", "cream cheese",
  "sour cream", "shredded cheese", "cottage cheese",
  // Pantry
  "pasta", "rice", "bread", "cereal", "oatmeal", "flour", "sugar",
  "canned tomatoes", "beans", "soup", "broth", "peanut butter",
  "olive oil", "vegetable oil", "vinegar", "soy sauce", "salsa",
  "ketchup", "mustard", "mayonnaise", "tortillas",
  // Frozen
  "frozen pizza", "frozen vegetables", "ice cream", "frozen fruit",
  "frozen meals", "frozen chicken", "frozen shrimp",
  // Snacks & Beverages
  "chips", "crackers", "nuts", "juice", "coffee", "tea",
];

// Stores to SKIP — we already scrape these directly with better data
const SKIP_STORES = new Set([
  "walmart", "aldi", "kroger", "ralphs", "fred meyer", "king soopers",
  "harris teeter", "smith's", "fry's", "qfc", "mariano's", "dillons",
  "pick n save", "city market", "baker's",
]);

function shouldSkipStore(merchantName) {
  const lower = (merchantName || "").toLowerCase();
  for (const skip of SKIP_STORES) {
    if (lower.includes(skip)) return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════
// Fetch deals from Flipp search API
// ══════════════════════════════════════════════════════════════════════
async function searchDeals(query, postalCode) {
  const url = `${FLIPP_API}/items/search?q=${encodeURIComponent(query)}&postal_code=${postalCode}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      if (res.status === 429) {
        // Rate limited — wait and retry
        await new Promise(r => setTimeout(r, 5000));
        return searchDeals(query, postalCode);
      }
      return [];
    }

    const data = await res.json();
    return (data.items || []).map(item => ({
      id: `flipp-${item.id || item.flyer_item_id}`,
      flippId: item.id || item.flyer_item_id,
      name: item.name || "",
      merchant: item.merchant_name || "",
      merchantId: item.merchant_id,
      currentPrice: item.current_price,
      originalPrice: item.original_price,
      prePriceText: item.pre_price_text || "",
      postPriceText: item.post_price_text || "",
      saleStory: item.sale_story || "",
      image: item.clean_image_url || item.clipping_image_url || "",
      validFrom: item.valid_from || "",
      validTo: item.valid_to || "",
      category: query,
    }));
  } catch (err) {
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════
// Clean product name for recipe matching
// ══════════════════════════════════════════════════════════════════════
function cleanName(rawName) {
  let name = rawName;

  // Strip common size suffixes
  name = name
    .replace(/,?\s*\d[\d.\s]*(oz|lb|lbs|fl oz|ct|count|pack|pk|each|gal|qt|pt|ml|l|kg|g)\b.*$/i, "")
    .replace(/\s*-\s*\d[\d.\s]*(oz|lb|lbs|fl oz|ct|count|pack|pk|each|gal|qt|pt)\s*$/i, "")
    .trim();

  // Strip brand names at the beginning if followed by ® or ™
  name = name.replace(/^[A-Z][a-zA-Z']+[®™]\s+/g, "").trim();

  // Clean up
  name = name
    .replace(/^[,\s—–\-!]+/, "")
    .replace(/[,\s—–\-!]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return name || rawName;
}

// ══════════════════════════════════════════════════════════════════════
// Format price
// ══════════════════════════════════════════════════════════════════════
function formatPrice(price) {
  if (!price && price !== 0) return "";
  return `$${parseFloat(price).toFixed(2)}`;
}

// ══════════════════════════════════════════════════════════════════════
// Save to Supabase
// ══════════════════════════════════════════════════════════════════════
async function saveToSupabase(deals) {
  if (!supabase || deals.length === 0) return;

  const TABLE = "flipp_deals";

  // Clear old deals
  await supabase.from(TABLE).delete().neq("id", "____");

  const BATCH = 100;
  for (let i = 0; i < deals.length; i += BATCH) {
    const batch = deals.slice(i, i + BATCH);
    const { error } = await supabase.from(TABLE).upsert(batch);
    if (error) console.error(`  ❌ Supabase error: ${error.message}`);
    else console.log(`  ✅ Saved batch: ${batch.length} items`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════
async function main() {
  console.log("🛒 Universal Grocery Deals — Powered by Flipp");
  console.log("═".repeat(50));
  console.log(`📍 Zip code: ${ZIP_CODE}`);
  if (STORE_FILTER) console.log(`🏪 Store filter: ${STORE_FILTER}`);
  if (DRY_RUN) console.log("🧪 DRY RUN — will not save to database");
  console.log();

  const allDeals = [];
  const storeSet = new Set();

  for (let i = 0; i < SEARCH_TERMS.length; i++) {
    const term = SEARCH_TERMS[i];
    process.stdout.write(`🔍 ${term.padEnd(20)}`);

    const items = await searchDeals(term, ZIP_CODE);

    // Filter out stores we already scrape directly
    const filtered = items.filter(item => {
      if (shouldSkipStore(item.merchant)) return false;
      if (STORE_FILTER && !item.merchant.toLowerCase().includes(STORE_FILTER.toLowerCase())) return false;
      return true;
    });

    filtered.forEach(item => storeSet.add(item.merchant));
    allDeals.push(...filtered);

    console.log(`→ ${filtered.length} deals${items.length !== filtered.length ? ` (${items.length - filtered.length} skipped: Kroger/Walmart/ALDI)` : ""}`);

    // Polite delay between requests
    await new Promise(r => setTimeout(r, 300));
  }

  // Deduplicate by Flipp item ID
  const seen = new Set();
  const unique = allDeals.filter(d => {
    if (seen.has(d.flippId)) return false;
    seen.add(d.flippId);
    return true;
  });

  // Build final deals
  const deals = unique.map(d => {
    const cleaned = cleanName(d.name);
    const savings = d.originalPrice && d.currentPrice && d.originalPrice > d.currentPrice
      ? (d.originalPrice - d.currentPrice).toFixed(2)
      : "";

    return {
      id: d.id,
      name: cleaned,
      brand: "",
      category: d.category,
      price: formatPrice(d.currentPrice),
      regular_price: formatPrice(d.originalPrice),
      savings: savings ? `$${savings}` : "",
      sale_story: d.saleStory,
      image: d.image,
      product_url: "",
      store_name: d.merchant,
      store_id: String(d.merchantId),
      valid_from: d.validFrom ? d.validFrom.split("T")[0] : "",
      valid_to: d.validTo ? d.validTo.split("T")[0] : "",
      source: "flipp",
      zip_code: ZIP_CODE,
    };
  });

  // Group by store for summary
  const storeCount = {};
  deals.forEach(d => {
    storeCount[d.store_name] = (storeCount[d.store_name] || 0) + 1;
  });

  console.log(`\n${"═".repeat(50)}`);
  console.log(`📊 Total unique deals: ${deals.length}`);
  console.log(`📊 Stores covered: ${Object.keys(storeCount).length}`);
  console.log(`\n🏪 Deals by store:`);
  Object.entries(storeCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([store, count]) => {
      console.log(`   ${String(count).padStart(4)} deals | ${store}`);
    });

  // Print samples
  console.log("\n📋 Sample deals (first 25):");
  deals.slice(0, 25).forEach(d => {
    const sale = d.sale_story ? ` [${d.sale_story}]` : "";
    const was = d.regular_price ? ` (was ${d.regular_price})` : "";
    console.log(`  ${(d.price || "???").padEnd(8)} ${d.name.padEnd(42)} ${d.store_name}${was}${sale}`);
  });

  if (DRY_RUN) {
    console.log(`\n🧪 Dry run complete. ${deals.length} deals would be saved.`);
    console.log("   Run without --dry-run to save to Supabase.");
    console.log(`\n💡 Tips:`);
    console.log(`   One store only:  node Flipp.js --zip 83713 --store "Publix" --dry-run`);
    console.log(`   Different area:  node Flipp.js --zip 30301 --dry-run`);
  } else {
    console.log(`\n💾 Saving ${deals.length} items to Supabase...`);
    await saveToSupabase(deals);
    console.log("\n✅ Done!");
  }
}

main().catch(console.error);
