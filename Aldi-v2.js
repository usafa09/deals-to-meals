/**
 * ALDI Scraper v2 — No Browser Needed
 * 
 * Fetches ALDI category pages via HTTP, parses __NUXT_DATA__ payload,
 * extracts product names, prices, slugs, and images.
 *
 * Run:  node Aldi-v2.js
 * Test: node Aldi-v2.js --dry-run   (prints products without saving)
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

const DRY_RUN = process.argv.includes("--dry-run");

const supabase = DRY_RUN
  ? null
  : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ══════════════════════════════════════════════════════════════════════
// Categories to scrape
// ══════════════════════════════════════════════════════════════════════
const CATEGORIES = [
  { slug: "fresh-meat-seafood/fresh-beef", id: "84", label: "Fresh Beef" },
  { slug: "fresh-meat-seafood/fresh-poultry", id: "86", label: "Fresh Poultry" },
  { slug: "fresh-meat-seafood/fresh-pork", id: "85", label: "Fresh Pork" },
  { slug: "fresh-meat-seafood/fresh-sausage", id: "87", label: "Fresh Sausage" },
  { slug: "fresh-meat-seafood/fresh-seafood", id: "88", label: "Fresh Seafood" },
  { slug: "fresh-meat-seafood/other-meat-plant-based-proteins", id: "171", label: "Other Meat" },
  { slug: "fresh-produce/fresh-fruit", id: "89", label: "Fresh Fruit" },
  { slug: "fresh-produce/fresh-vegetables", id: "90", label: "Fresh Vegetables" },
  { slug: "dairy-eggs/cheese", id: "73", label: "Cheese" },
  { slug: "dairy-eggs/eggs", id: "75", label: "Eggs" },
  { slug: "dairy-eggs/milk-milk-substitutes", id: "76", label: "Milk" },
  { slug: "dairy-eggs/butter", id: "72", label: "Butter" },
  { slug: "dairy-eggs/yogurt-sour-cream", id: "77", label: "Yogurt" },
  { slug: "pantry-essentials/canned-foods", id: "102", label: "Canned Foods" },
  { slug: "pantry-essentials/pasta-rice-grains", id: "108", label: "Pasta & Rice" },
  { slug: "pantry-essentials/sauces-salsa", id: "104", label: "Sauces" },
  { slug: "pantry-essentials/condiments-dressings", id: "166", label: "Condiments" },
  { slug: "pantry-essentials/soups-broth", id: "105", label: "Soups & Broth" },
  { slug: "pantry-essentials/oils-vinegars", id: "103", label: "Oils & Vinegars" },
  { slug: "pantry-essentials/baking-supplies-ingredients", id: "101", label: "Baking" },
  { slug: "pantry-essentials/spices", id: "106", label: "Spices" },
  { slug: "frozen-foods/frozen-meat-poultry-seafood", id: "94", label: "Frozen Meat" },
  { slug: "frozen-foods/frozen-vegetables", id: "163", label: "Frozen Vegetables" },
  { slug: "frozen-foods/frozen-meals-sides", id: "137", label: "Frozen Meals" },
  { slug: "frozen-foods/frozen-pizza", id: "95", label: "Frozen Pizza" },
  { slug: "frozen-foods/frozen-breakfast", id: "91", label: "Frozen Breakfast" },
  { slug: "frozen-foods/frozen-fruit", id: "155", label: "Frozen Fruit" },
  { slug: "frozen-foods/frozen-appetizers-snacks", id: "138", label: "Frozen Snacks" },
  { slug: "deli/deli-meat", id: "78", label: "Deli Meat" },
  { slug: "deli/lunch-meat", id: "81", label: "Lunch Meat" },
  { slug: "deli/dips-hummus", id: "79", label: "Dips & Hummus" },
  { slug: "bakery-bread/bread", id: "69", label: "Bread" },
  { slug: "bakery-bread/baked-goods-desserts", id: "68", label: "Baked Goods" },
  { slug: "snacks/chips-crackers-popcorn", id: "127", label: "Chips & Crackers" },
  { slug: "snacks/nuts-dried-fruit", id: "129", label: "Nuts & Dried Fruit" },
  { slug: "snacks/cookies-sweets", id: "128", label: "Cookies" },
  { slug: "breakfast-cereals/cereal", id: "70", label: "Cereal" },
  { slug: "beverages/juice-cider", id: "62", label: "Juice" },
  { slug: "beverages/coffee", id: "60", label: "Coffee" },
  { slug: "featured/price-drops", id: "280", label: "Price Drops" },
];

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════
function getWeekDates() {
  const now = new Date();
  const day = now.getDay();
  const daysSinceWed = (day - 3 + 7) % 7;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - daysSinceWed);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { weekStart: fmt(weekStart), weekEnd: fmt(weekEnd) };
}

/** Convert a product slug to a readable name:
 *  "black-angus-beef-choice-boneless-ribeye-steak-per-lb"
 *  → "Black Angus Beef Choice Boneless Ribeye Steak"
 */
function slugToName(slug) {
  return slug
    .replace(/-per-lb$/, "")
    .replace(/-\d+-oz$/, "")
    .replace(/-\d+-lb$/, "")
    .replace(/-\d+-ct$/, "")
    .replace(/-\d+-fl-oz$/, "")
    .replace(/-\d+-pack$/, "")
    .replace(/-\d+-count$/, "")
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .replace(/\s+S\b/g, "'s"); // "cattlemen-s" → "Cattlemen's"
}

// ══════════════════════════════════════════════════════════════════════
// Fetch and parse one category page
// ══════════════════════════════════════════════════════════════════════
async function fetchCategoryProducts(category) {
  const url = `https://www.aldi.us/products/${category.slug}/k/${category.id}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
    },
  });

  if (!res.ok) {
    console.error(`   ❌ HTTP ${res.status} for ${category.label}`);
    return [];
  }

  const html = await res.text();

  // Extract __NUXT_DATA__ — flexible regex to match any attribute order
  const nuxtMatch = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!nuxtMatch) {
    console.error(`   ⚠️ No __NUXT_DATA__ found for ${category.label}`);
    return [];
  }

  let raw;
  try {
    raw = JSON.parse(nuxtMatch[1]);
  } catch (e) {
    console.error(`   ⚠️ JSON parse error: ${e.message}`);
    return [];
  }

  return extractProducts(raw, category);
}

// ══════════════════════════════════════════════════════════════════════
// Extract products from the flat Nuxt payload
// ══════════════════════════════════════════════════════════════════════
function extractProducts(raw, category) {
  // Index all strings with their positions
  const indexed = [];
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] === "string") {
      indexed.push({ val: raw[i], idx: i });
    }
  }

  // ── Find product slugs (most reliable identifier) ──
  const slugs = indexed.filter(s =>
    s.val.length > 15 &&
    /^[a-z0-9][a-z0-9-]+[a-z0-9]$/.test(s.val) &&
    (s.val.includes("-lb") || s.val.includes("-oz") || s.val.includes("-ct") ||
     s.val.includes("-pack") || s.val.includes("-fl-oz") || s.val.includes("-gal") ||
     s.val.includes("-each") || s.val.includes("-qt") || s.val.includes("-ml") ||
     s.val.includes("-count")) &&
    !s.val.includes("subcat") && !s.val.includes("teaser") &&
    !s.val.includes("nav-") && !s.val.includes("cat-")
  );

  // ── Find explicit product names (contain size like "1 lb", "14 oz") ──
  const explicitNames = indexed.filter(s =>
    s.val.length > 8 &&
    s.val.length < 150 &&
    /\d+\.?\d*\s*(lb|lbs|oz|fl oz|ct|count|pack|pk|each|gal|qt|pt)\b/i.test(s.val) &&
    !s.val.startsWith("http") &&
    !s.val.startsWith("/") &&
    !s.val.startsWith("avg.") &&
    !s.val.includes(".jpg") &&
    !s.val.includes(".png") &&
    !s.val.includes("teaser") &&
    !s.val.includes("background") &&
    !s.val.includes("isolated") &&
    !s.val.includes("clipping") &&
    !/^[a-z0-9-]+$/.test(s.val)
  );

  // ── Find prices ──
  const prices = indexed.filter(s => /^\$\d+\.\d{2}$/.test(s.val) && s.val !== "$0.00");

  // ── Build products from slugs (primary method) ──
  const products = [];
  const usedPrices = new Set();

  for (const slugEntry of slugs) {
    const slugIdx = slugEntry.idx;
    const slug = slugEntry.val;

    // Check if there's an explicit product name right before this slug (within 5 positions)
    const explicitName = explicitNames.find(
      n => n.idx >= slugIdx - 5 && n.idx <= slugIdx + 5
    );

    // Use explicit name if found, otherwise derive from slug
    const name = explicitName ? explicitName.val.trim() : slugToName(slug);

    // Find closest price (look in a wider window around the slug)
    let bestPrice = null;
    let bestDist = Infinity;
    for (const p of prices) {
      if (usedPrices.has(p.idx)) continue;
      const dist = Math.abs(p.idx - slugIdx);
      if (dist < bestDist && dist < 35) {
        bestDist = dist;
        bestPrice = p;
      }
    }

    if (bestPrice) usedPrices.add(bestPrice.idx);

    // Find product image URL near this entry
    let image = "";
    for (let offset = -20; offset <= 20; offset++) {
      const checkIdx = slugIdx + offset;
      if (checkIdx >= 0 && checkIdx < raw.length && typeof raw[checkIdx] === "string") {
        const val = raw[checkIdx];
        if (val.includes("product/jpg") || (val.includes("/is/image/prod1amer/") && !val.includes("teaser"))) {
          image = val.includes("http") ? val.replace("{width}", "400") : `https://dm.cms.aldi.cx/is/image/prod1amer/${val}?wid=400`;
          break;
        }
      }
    }

    products.push({
      name,
      slug,
      price: bestPrice?.val || "",
      category: category.label,
      image,
      productUrl: `https://www.aldi.us/product/${slug}`,
    });
  }

  return products;
}

// ══════════════════════════════════════════════════════════════════════
// Non-food filter
// ══════════════════════════════════════════════════════════════════════
const NON_FOOD_KEYWORDS = [
  "rug", "planter", "vase", "ladder", "tile", "candle", "pillow",
  "towel", "sheet", "lamp", "bulb", "battery", "cleaner", "detergent",
  "laundry", "trash", "chair", "patio", "vacuum", "organizer",
  "diaper", "wipes", "shampoo", "deodorant", "napkin", "glove",
  "t-shirt", "clothing", "toy", "hammer", "tool", "decor",
  "paper towel", "trash bag", "aluminum foil", "plastic wrap",
];

function isFood(name) {
  const lower = name.toLowerCase();
  return !NON_FOOD_KEYWORDS.some(kw => lower.includes(kw));
}

// ══════════════════════════════════════════════════════════════════════
// Clean product name for recipe matching
// ══════════════════════════════════════════════════════════════════════
const ALDI_BRANDS = [
  "simply nature", "appleton farms", "happy farms", "never any",
  "fremont fish market", "carlini", "cattlemen's", "cattlemens",
  "southern grove", "stonemill", "baker's corner", "specially selected",
  "park street deli", "casa mamita", "mama cozzi's", "millville",
  "brookdale", "chef's cupboard", "reggano", "savoritz",
  "emporium selection", "friendly farms", "barissimo", "choceur",
  "clancy's", "moser roth", "elevation", "northern catch",
  "bremer", "fit & active", "little salad bar", "priano",
  "season's choice", "kirkwood", "roseland", "black angus",
  "usda choice", "tyson",
];

function cleanName(rawName) {
  let name = rawName;

  // Strip ALDI brand prefixes
  const lower = name.toLowerCase();
  for (const brand of ALDI_BRANDS) {
    if (lower.startsWith(brand)) {
      name = name.slice(brand.length).trim();
      name = name.replace(/^[,\s—–\-!:]+/, "").trim();
      break;
    }
  }

  // Strip size suffix
  name = name
    .replace(/,\s*\d[\d.\s]*\s*(oz|lb|lbs|fl oz|ct|count|pack|pk|each|gal|qt|pt|ml|kg|g)\b.*/i, "")
    .replace(/,?\s*per\s+lb\b.*/i, "")
    .replace(/,?\s*avg\.?\s*[\d.]+\s*lb.*/i, "")
    .trim();

  // Clean up leftover punctuation
  name = name
    .replace(/^[,\s—–\-!:]+/, "")
    .replace(/[,\s—–\-!:]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Title-case
  name = name.replace(/\b\w/g, c => c.toUpperCase());

  return name || rawName;
}

// ══════════════════════════════════════════════════════════════════════
// Save to Supabase
// ══════════════════════════════════════════════════════════════════════
async function saveToSupabase(deals) {
  if (!supabase || deals.length === 0) return;

  // Clear old deals
  await supabase.from("aldi_deals").delete().neq("id", "____");

  const BATCH = 100;
  for (let i = 0; i < deals.length; i += BATCH) {
    const batch = deals.slice(i, i + BATCH);
    const { error } = await supabase.from("aldi_deals").upsert(batch);
    if (error) console.error(`  ❌ Supabase error: ${error.message}`);
    else console.log(`  ✅ Saved batch: ${batch.length} items`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════
async function main() {
  console.log("🛒 ALDI Scraper v2 — No Browser Needed");
  console.log("═".repeat(50));
  if (DRY_RUN) console.log("🧪 DRY RUN MODE — will not save to database\n");

  const { weekStart, weekEnd } = getWeekDates();
  console.log(`📅 Week: ${weekStart} → ${weekEnd}\n`);

  const allProducts = [];
  let successCount = 0;
  let errorCount = 0;

  for (const cat of CATEGORIES) {
    process.stdout.write(`📦 ${cat.label.padEnd(22)}`);

    try {
      const products = await fetchCategoryProducts(cat);
      const foodOnly = products.filter(p => isFood(p.name));
      const withPrice = foodOnly.filter(p => p.price);
      console.log(`→ ${products.length} items, ${withPrice.length} with prices`);
      allProducts.push(...foodOnly);
      successCount++;
    } catch (err) {
      console.log(`→ ❌ ${err.message}`);
      errorCount++;
    }

    // Polite delay between requests
    await new Promise(r => setTimeout(r, 400));
  }

  // Deduplicate by slug (most reliable unique key)
  const seen = new Set();
  const unique = allProducts.filter(p => {
    const key = p.slug || `${p.name.toLowerCase()}-${p.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n${"═".repeat(50)}`);
  console.log(`📊 Categories scraped: ${successCount}/${CATEGORIES.length} (${errorCount} errors)`);
  console.log(`📊 Total unique food items: ${unique.length}`);

  // Build deals for Supabase
  const deals = unique.map((p, i) => {
    const cleaned = cleanName(p.name);
    return {
      id: `aldi-${i}-${p.slug.slice(0, 30) || cleaned.slice(0, 20).replace(/\s+/g, "-").toLowerCase().replace(/[^a-z0-9-]/g, "")}`,
      name: cleaned,
      brand: "",
      category: p.category,
      price: p.price,
      regular_price: "",
      savings: "",
      image: p.image,
      product_url: p.productUrl,
      week_start: weekStart,
      week_end: weekEnd,
    };
  });

  // Print samples
  console.log("\n📋 Sample products (first 20):");
  deals.slice(0, 20).forEach(d => {
    console.log(`  ${(d.price || "???").padEnd(8)} ${d.name.padEnd(50)} [${d.category}]`);
  });

  if (DRY_RUN) {
    console.log(`\n🧪 Dry run complete. ${deals.length} deals would be saved.`);
    console.log("   Run without --dry-run to save to Supabase.");
  } else {
    console.log(`\n💾 Saving ${deals.length} items to Supabase...`);
    await saveToSupabase(deals);
    console.log("\n✅ Done!");
  }
}

main().catch(console.error);
