/**
 * Albertsons / Safeway Scraper — Stealth Mode
 * 
 * Uses playwright-extra with stealth plugin to bypass bot detection.
 * Works for ALL Albertsons banners: Safeway, Vons, Jewel-Osco, Shaw's, ACME, etc.
 *
 * Run:  node Albertsons.js
 * Test: node Albertsons.js --dry-run
 * Pick: node Albertsons.js --banner safeway --store 2948 --zip 94102 --dry-run
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

// Apply stealth plugin — hides automation fingerprints
chromium.use(StealthPlugin());

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx > -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const BANNER   = getArg("banner", "albertsons");
const STORE_ID = getArg("store", "177");
const ZIP_CODE = getArg("zip", "83713");

const BANNER_DOMAINS = {
  albertsons: "www.albertsons.com",
  safeway:    "www.safeway.com",
  vons:       "www.vons.com",
  jewelosco:  "www.jewelosco.com",
  shaws:      "www.shaws.com",
  acme:       "www.acmemarkets.com",
  starmarket: "www.starmarket.com",
  randalls:   "www.randalls.com",
  tomthumb:   "www.tomthumb.com",
  pavilions:  "www.pavilions.com",
  haggen:     "www.haggen.com",
};

const DOMAIN = BANNER_DOMAINS[BANNER] || BANNER_DOMAINS.albertsons;
const BASE_URL = `https://${DOMAIN}`;

const supabase = DRY_RUN
  ? null
  : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ══════════════════════════════════════════════════════════════════════
// Food categories to scrape
// ══════════════════════════════════════════════════════════════════════
const CATEGORIES = [
  { path: "meat-seafood", label: "Meat & Seafood" },
  { path: "meat-seafood/beef", label: "Beef" },
  { path: "meat-seafood/chicken-turkey", label: "Chicken & Turkey" },
  { path: "meat-seafood/pork", label: "Pork" },
  { path: "meat-seafood/fish-shellfish", label: "Fish & Shellfish" },
  { path: "meat-seafood/sausage-hot-dogs-bacon", label: "Sausage & Bacon" },
  { path: "produce", label: "Produce" },
  { path: "produce/fresh-fruits", label: "Fresh Fruits" },
  { path: "produce/fresh-vegetables", label: "Fresh Vegetables" },
  { path: "dairy/milk", label: "Milk" },
  { path: "dairy/cheese", label: "Cheese" },
  { path: "dairy/eggs", label: "Eggs" },
  { path: "dairy/butter-margarine", label: "Butter" },
  { path: "dairy/yogurt", label: "Yogurt" },
  { path: "pantry/canned-goods-soups", label: "Canned Goods & Soups" },
  { path: "pantry/pasta-pasta-sauce", label: "Pasta & Sauce" },
  { path: "pantry/rice-grains-dried-beans", label: "Rice & Grains" },
  { path: "pantry/condiments-dressings", label: "Condiments" },
  { path: "pantry/oils-vinegar-shortening", label: "Oils & Vinegar" },
  { path: "pantry/spices-seasoning", label: "Spices" },
  { path: "frozen/frozen-meals-entrees", label: "Frozen Meals" },
  { path: "frozen/frozen-meat-seafood", label: "Frozen Meat & Seafood" },
  { path: "frozen/frozen-vegetables", label: "Frozen Vegetables" },
  { path: "frozen/frozen-pizza", label: "Frozen Pizza" },
  { path: "frozen/frozen-breakfast", label: "Frozen Breakfast" },
  { path: "bread-bakery/bread", label: "Bread" },
  { path: "snacks/chips-pretzels", label: "Chips & Pretzels" },
  { path: "snacks/crackers", label: "Crackers" },
  { path: "snacks/nuts-trail-mix", label: "Nuts & Trail Mix" },
  { path: "beverages/juice-cider", label: "Juice" },
  { path: "beverages/coffee", label: "Coffee" },
  { path: "deli/salami-lunch-meats", label: "Lunch Meats" },
];

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

// ══════════════════════════════════════════════════════════════════════
// Extract products from a loaded page
// ══════════════════════════════════════════════════════════════════════
async function extractProducts(page, category) {
  return await page.evaluate((cat) => {
    const products = [];
    const seen = new Set();

    // Find all price elements
    const priceEls = document.querySelectorAll("[data-qa='prd-itm-prc']");

    priceEls.forEach((priceEl) => {
      try {
        // Get sale price
        const salePriceEl = priceEl.querySelector("[aria-hidden='true']");
        const salePrice = salePriceEl?.textContent?.trim()?.replace(/[^$0-9.]/g, "") || "";

        // Get regular/original price from <del> tag
        const parentDiv = priceEl.closest("[class*='price']");
        const delEl = parentDiv?.querySelector("del");
        const regularPrice = delEl?.textContent?.trim()?.replace(/[^$0-9.]/g, "") || "";

        // Walk up to find the product card
        let card = priceEl;
        for (let i = 0; i < 12; i++) {
          card = card.parentElement;
          if (!card) break;
          if (card.querySelector("[data-bpn]") || card.querySelector("a[href*='product-details']")) break;
        }
        if (!card) return;

        // Product ID
        const bpnEl = card.querySelector("[data-bpn]");
        const productId = bpnEl?.getAttribute("data-bpn") || "";
        if (seen.has(productId)) return;
        if (productId) seen.add(productId);

        // Product name from aria-label
        const linkEl = card.querySelector("a[aria-label]");
        let name = "";
        if (linkEl) {
          name = linkEl.getAttribute("aria-label")
            ?.split(",price")[0]
            ?.split(",Price")[0]
            ?.split(", price")[0]
            ?.split(", Price")[0]
            ?.trim() || "";
        }
        if (!name) {
          const imgEl = card.querySelector("img[alt]");
          name = imgEl?.getAttribute("alt") || "";
        }

        if (!name || !salePrice) return;

        // Product URL
        const href = linkEl?.getAttribute("href") ||
          card.querySelector("a[href*='product-details']")?.getAttribute("href") || "";

        // Image
        const imgEl = card.querySelector("img[data-qa='prd-pctr'], img[alt]");
        const image = imgEl?.getAttribute("src") || "";

        const onSale = !!regularPrice && regularPrice !== salePrice;

        products.push({
          name,
          productId,
          salePrice,
          regularPrice: onSale ? regularPrice : "",
          onSale,
          image: image.startsWith("//") ? "https:" + image : image,
          productUrl: href,
          category: cat.label,
        });
      } catch (e) {}
    });

    return products;
  }, category);
}

// ══════════════════════════════════════════════════════════════════════
// Scrape one category
// ══════════════════════════════════════════════════════════════════════
async function scrapeCategory(page, category) {
  const url = `${BASE_URL}/shop/aisles/${category.path}.html?loc=${STORE_ID}`;

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for product prices to appear
    await page.waitForSelector("[data-qa='prd-itm-prc']", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Scroll to load more products
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(800);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    return await extractProducts(page, category);
  } catch (err) {
    console.error(`   ❌ ${category.label}: ${err.message.split("\n")[0]}`);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════
// Clean name for recipe matching
// ══════════════════════════════════════════════════════════════════════
function cleanName(rawName) {
  let name = rawName;
  const brands = [
    "signature select", "signature farms", "signature cafe",
    "open nature", "o organics", "lucerne", "waterfront bistro",
    "primo taglio", "ready meals", "debi lilly", "soleil",
    "value corner", "chef's counter",
  ];
  const lower = name.toLowerCase();
  for (const brand of brands) {
    if (lower.startsWith(brand)) {
      name = name.slice(brand.length).trim().replace(/^[,\s—–\-!:]+/, "").trim();
      break;
    }
  }
  name = name
    .replace(/\s*-\s*\d[\d.\s]*(oz|lb|lbs|fl oz|ct|count|pack|pk|each|gal|qt|pt)\s*$/i, "")
    .replace(/,\s*\d[\d.\s]*(oz|lb|lbs|fl oz|ct|count|pack|pk|each|gal|qt|pt)\s*$/i, "")
    .replace(/^[,\s—–\-!]+/, "")
    .replace(/[,\s—–\-!]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return name || rawName;
}

const NON_FOOD = [
  "paper towel", "trash bag", "aluminum foil", "plastic wrap", "napkin",
  "diaper", "wipes", "shampoo", "soap", "detergent", "cleaner",
  "battery", "light bulb", "candle", "air freshener",
];

function isFood(name) {
  const lower = name.toLowerCase();
  return !NON_FOOD.some(kw => lower.includes(kw));
}

// ══════════════════════════════════════════════════════════════════════
// Save to Supabase
// ══════════════════════════════════════════════════════════════════════
async function saveToSupabase(deals) {
  if (!supabase || deals.length === 0) return;
  const TABLE = "albertsons_deals";
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
  const bannerName = BANNER.charAt(0).toUpperCase() + BANNER.slice(1);
  console.log(`🛒 ${bannerName} Scraper — Stealth Mode`);
  console.log("═".repeat(50));
  console.log(`🏪 Banner: ${bannerName} (${DOMAIN})`);
  console.log(`📍 Store: ${STORE_ID} | Zip: ${ZIP_CODE}`);
  if (DRY_RUN) console.log("🧪 DRY RUN — will not save to database");

  const { weekStart, weekEnd } = getWeekDates();
  console.log(`📅 Week: ${weekStart} → ${weekEnd}\n`);

  // Launch stealth browser
  console.log("🚀 Launching stealth browser...");
  const browser = await chromium.launch({
    headless: false,  // Visible browser — less likely to be blocked
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    timezoneId: "America/Boise",
  });

  // Remove webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });

  const page = await context.newPage();

  // Initial page load to establish cookies/session
  console.log("📍 Loading initial page and setting store...");
  try {
    await page.goto(`${BASE_URL}/shop/aisles/meat-seafood.html?loc=${STORE_ID}`, {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    await page.waitForTimeout(5000);

    // Check if we got blocked
    const title = await page.title();
    if (title.toLowerCase().includes("access denied") || title.toLowerCase().includes("error")) {
      console.log(`❌ BLOCKED by ${bannerName}'s security.`);
      console.log("   Title:", title);
      console.log("   The stealth plugin wasn't enough.");
      console.log("   Try again later or from a different network.");
      await browser.close();
      return;
    }

    console.log("   Page title:", title);

    // Dismiss any popups/modals
    try {
      const closeBtn = page.locator("button[aria-label='close'], [class*='close-modal'], [class*='dismiss']").first();
      if (await closeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await closeBtn.click();
        await page.waitForTimeout(500);
      }
    } catch (e) {}

    // Check if products loaded
    const priceCount = await page.locator("[data-qa='prd-itm-prc']").count();
    console.log(`   Products on first page: ${priceCount}`);

    if (priceCount === 0) {
      console.log("   ⚠️ No products found on initial page.");
      console.log("   The page may not have fully loaded, or we're still blocked.");
      // Take a screenshot for debugging
      await page.screenshot({ path: "albertsons-debug.png" });
      console.log("   Screenshot saved: albertsons-debug.png");
    } else {
      console.log("   ✅ Products loaded! Starting category scrape...\n");
    }

  } catch (e) {
    console.log(`   ⚠️ Initial load: ${e.message.split("\n")[0]}`);
  }

  // Scrape each category
  const allProducts = [];
  let successCount = 0;
  let errorCount = 0;

  for (const cat of CATEGORIES) {
    process.stdout.write(`📦 ${cat.label.padEnd(25)}`);

    const products = await scrapeCategory(page, cat);
    const foodOnly = products.filter(p => isFood(p.name));
    const onSale = foodOnly.filter(p => p.onSale);

    if (foodOnly.length > 0) {
      console.log(`→ ${foodOnly.length} items (${onSale.length} on sale)`);
      allProducts.push(...foodOnly);
      successCount++;
    } else {
      console.log(`→ 0 items`);
      errorCount++;
    }

    // Polite delay
    await page.waitForTimeout(1500);
  }

  await browser.close();

  // Deduplicate
  const seen = new Set();
  const unique = allProducts.filter(p => {
    const key = p.productId || `${p.name}-${p.salePrice}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n${"═".repeat(50)}`);
  console.log(`📊 Categories: ${successCount}/${CATEGORIES.length} (${errorCount} empty)`);
  console.log(`📊 Total unique food items: ${unique.length}`);
  console.log(`📊 Items on sale: ${unique.filter(p => p.onSale).length}`);

  const deals = unique.map((p, i) => {
    const cleaned = cleanName(p.name);
    const savings = p.onSale
      ? (parseFloat(p.regularPrice.replace("$", "")) - parseFloat(p.salePrice.replace("$", ""))).toFixed(2)
      : "";
    return {
      id: `abs-${p.productId || i}`,
      name: cleaned,
      brand: "",
      category: p.category,
      price: p.salePrice,
      regular_price: p.regularPrice,
      savings: savings ? `$${savings}` : "",
      image: p.image,
      product_url: p.productUrl ? `${BASE_URL}${p.productUrl}` : "",
      week_start: getWeekDates().weekStart,
      week_end: getWeekDates().weekEnd,
      source: BANNER,
      store_id: STORE_ID,
    };
  });

  console.log("\n📋 Sample products (first 20):");
  deals.slice(0, 20).forEach(d => {
    const sale = d.savings ? ` (was ${d.regular_price}, save ${d.savings})` : "";
    console.log(`  ${(d.price || "???").padEnd(8)} ${d.name.padEnd(45)} [${d.category}]${sale}`);
  });

  if (DRY_RUN) {
    console.log(`\n🧪 Dry run complete. ${deals.length} deals would be saved.`);
    console.log(`\n💡 Other banners: node Albertsons.js --banner safeway --store 2948 --zip 94102`);
  } else {
    console.log(`\n💾 Saving ${deals.length} items to Supabase...`);
    await saveToSupabase(deals);
    console.log("\n✅ Done!");
  }
}

main().catch(console.error);
