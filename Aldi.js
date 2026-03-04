/**
 * Aldi Weekly Specials Scraper
 * Scrapes ALDI Finds + weekly grocery deals from aldi.us
 * Saves results to Supabase table: aldi_deals
 *
 * Run manually:  node scrapers/aldi.js
 * Schedule:      Every Wednesday at 8am (when Aldi resets their weekly ad)
 *
 * Supabase table needed:
 *   CREATE TABLE aldi_deals (
 *     id          TEXT PRIMARY KEY,
 *     name        TEXT,
 *     brand       TEXT,
 *     category    TEXT,
 *     price       TEXT,
 *     regular_price TEXT,
 *     savings     TEXT,
 *     image       TEXT,
 *     product_url TEXT,
 *     week_start  TEXT,
 *     week_end    TEXT,
 *     scraped_at  TIMESTAMPTZ DEFAULT NOW()
 *   );
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ALDI_FINDS_URL = "https://www.aldi.us/weekly-specials/this-weeks-aldi-finds";
const ALDI_WEEKLY_URL = "https://www.aldi.us/weekly-specials/weekly-ads";

// Grocery-relevant categories to keep (filter out home goods, clothing, etc.)
const GROCERY_KEYWORDS = [
  "meat", "poultry", "seafood", "fish", "beef", "chicken", "pork",
  "produce", "fruit", "vegetable", "dairy", "egg", "cheese", "milk",
  "butter", "yogurt", "bread", "bakery", "pasta", "rice", "grain",
  "frozen", "snack", "beverage", "drink", "juice", "coffee", "tea",
  "cereal", "breakfast", "pantry", "sauce", "soup", "condiment",
  "deli", "food", "grocery", "fresh", "organic", "nutrition"
];

function isGroceryItem(name, category) {
  const text = `${name} ${category}`.toLowerCase();
  return GROCERY_KEYWORDS.some(kw => text.includes(kw));
}

async function scrapeAldiFinds(page) {
  console.log("📦 Scraping ALDI Finds...");
  await page.goto(ALDI_FINDS_URL, { waitUntil: "networkidle", timeout: 60000 });

  // Wait for product cards to appear
  await page.waitForSelector("[class*='product'], [class*='card'], article", { timeout: 30000 }).catch(() => {});

  // Extract product data from the page
  const products = await page.evaluate(() => {
    const items = [];

    // Try multiple selectors Aldi might use
    const selectors = [
      "[data-test='product-tile']",
      "[class*='ProductTile']",
      "[class*='product-tile']",
      ".product-card",
      "article[class*='product']",
      "[class*='weeklyFeat']",
      "[class*='aldi-find']",
    ];

    let productEls = [];
    for (const sel of selectors) {
      productEls = [...document.querySelectorAll(sel)];
      if (productEls.length > 0) break;
    }

    // Fallback: grab all items with a price
    if (productEls.length === 0) {
      productEls = [...document.querySelectorAll("li, article, div[class*='item']")]
        .filter(el => el.querySelector("img") && el.textContent.includes("$"));
    }

    productEls.forEach((el, i) => {
      const nameEl = el.querySelector("h2, h3, h4, [class*='title'], [class*='name'], [class*='description']");
      const priceEl = el.querySelector("[class*='price'], .price, [data-test*='price']");
      const imgEl = el.querySelector("img");
      const linkEl = el.querySelector("a");
      const categoryEl = el.querySelector("[class*='category'], [class*='type']");

      const name = nameEl?.textContent?.trim() || "";
      const price = priceEl?.textContent?.trim() || "";
      const image = imgEl?.src || imgEl?.getAttribute("data-src") || "";
      const link = linkEl?.href || "";
      const category = categoryEl?.textContent?.trim() || "ALDI Finds";

      if (name && price && price.includes("$")) {
        items.push({
          id: `aldi-${i}-${name.slice(0, 20).replace(/\s+/g, "-").toLowerCase()}`,
          name,
          price,
          image,
          link,
          category,
        });
      }
    });

    return items;
  });

  console.log(`  Found ${products.length} ALDI Finds items`);
  return products;
}

async function scrapeWeeklyGrocery(page) {
  console.log("🛒 Scraping weekly grocery deals...");

  // Aldi's grocery category pages with weekly specials
  const groceryCategories = [
    { url: "https://www.aldi.us/products/fresh-meat-seafood/k/12", name: "Fresh Meat & Seafood" },
    { url: "https://www.aldi.us/products/fresh-produce/k/13", name: "Fresh Produce" },
    { url: "https://www.aldi.us/products/dairy-eggs/k/10", name: "Dairy & Eggs" },
    { url: "https://www.aldi.us/products/bakery-bread/k/6", name: "Bakery & Bread" },
    { url: "https://www.aldi.us/products/frozen-foods/k/14", name: "Frozen Foods" },
    { url: "https://www.aldi.us/products/pantry-essentials/k/16", name: "Pantry Essentials" },
  ];

  const allProducts = [];

  for (const cat of groceryCategories) {
    await page.goto(cat.url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const products = await page.evaluate((catName) => {
      const items = [];
      const selectors = [
        "[data-test='product-tile']",
        "[class*='ProductTile']",
        "[class*='product-tile']",
        ".product-card",
        "article",
      ];

      let productEls = [];
      for (const sel of selectors) {
        productEls = [...document.querySelectorAll(sel)];
        if (productEls.length > 0) break;
      }

      productEls.slice(0, 30).forEach((el, i) => {
        const nameEl = el.querySelector("h2, h3, h4, [class*='title'], [class*='name']");
        const priceEl = el.querySelector("[class*='price']");
        const wasEl = el.querySelector("[class*='was'], [class*='regular'], [class*='original'], s, strike");
        const imgEl = el.querySelector("img");
        const linkEl = el.querySelector("a");

        const name = nameEl?.textContent?.trim() || "";
        const price = priceEl?.textContent?.trim() || "";
        const wasPrice = wasEl?.textContent?.trim() || "";
        const image = imgEl?.src || imgEl?.getAttribute("data-src") || "";
        const link = linkEl?.href || "";

        if (name && price && price.includes("$")) {
          items.push({
            id: `aldi-cat-${catName.slice(0,5)}-${i}-${name.slice(0, 15).replace(/\s+/g, "-").toLowerCase()}`,
            name,
            price,
            regularPrice: wasPrice,
            image,
            link,
            category: catName,
          });
        }
      });

      return items;
    }, cat.name);

    console.log(`  ${cat.name}: ${products.length} items`);
    allProducts.push(...products);
    await page.waitForTimeout(1500); // polite delay
  }

  return allProducts;
}

function parsePrice(priceStr) {
  const match = priceStr?.match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

function getWeekDates() {
  const now = new Date();
  // Aldi weeks run Wed–Tue
  const day = now.getDay(); // 0=Sun, 3=Wed
  const daysToWed = (3 - day + 7) % 7 || 7;
  const nextWed = new Date(now);
  nextWed.setDate(now.getDate() + daysToWed - 7);
  const weekStart = nextWed.toISOString().split("T")[0];
  const weekEnd = new Date(nextWed.getTime() + 6 * 86400000).toISOString().split("T")[0];
  return { weekStart, weekEnd };
}

async function saveToSupabase(deals) {
  if (deals.length === 0) {
    console.log("⚠️  No deals to save");
    return;
  }

  // Clear old deals first
  const { error: deleteError } = await supabase.from("aldi_deals").delete().neq("id", "____");
  if (deleteError) console.error("Delete error:", deleteError.message);

  // Upsert new deals in batches of 100
  const BATCH = 100;
  for (let i = 0; i < deals.length; i += BATCH) {
    const batch = deals.slice(i, i + BATCH);
    const { error } = await supabase.from("aldi_deals").upsert(batch);
    if (error) console.error("Upsert error:", error.message);
    else console.log(`  ✅ Saved batch ${Math.floor(i / BATCH) + 1} (${batch.length} items)`);
  }
}

async function main() {
  console.log("🛒 Starting Aldi scraper...");
  const { weekStart, weekEnd } = getWeekDates();
  console.log(`📅 Week: ${weekStart} → ${weekEnd}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  try {
    const [finds, groceries] = await Promise.allSettled([
      scrapeAldiFinds(page),
      scrapeWeeklyGrocery(page),
    ]);

    const allProducts = [
      ...(finds.status === "fulfilled" ? finds.value : []),
      ...(groceries.status === "fulfilled" ? groceries.value : []),
    ];

    // Deduplicate by id
    const seen = new Set();
    const unique = allProducts.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    // Format for Supabase
    const deals = unique.map(p => ({
      id: p.id,
      name: p.name,
      brand: p.brand || "",
      category: p.category || "General",
      price: p.price,
      regular_price: p.regularPrice || "",
      savings: (() => {
        const sale = parsePrice(p.price);
        const reg = parsePrice(p.regularPrice);
        if (sale && reg && reg > sale) return `$${(reg - sale).toFixed(2)}`;
        return "";
      })(),
      image: p.image,
      product_url: p.link,
      week_start: weekStart,
      week_end: weekEnd,
    }));

    console.log(`\n📊 Total unique items: ${deals.length}`);
    await saveToSupabase(deals);
    console.log("\n✅ Aldi scrape complete!");

  } catch (err) {
    console.error("❌ Scraper error:", err.message);
  } finally {
    await browser.close();
  }
}

main();
