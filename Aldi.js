/**
 * Aldi Weekly Ad Scraper
 * Scrapes weekly grocery SALE items from aldi.us category pages
 * Focuses only on items with actual price drops (sale price vs regular price)
 * Saves results to Supabase table: aldi_deals
 *
 * Run manually:  node Aldi.js
 * Schedule:      Every Wednesday at 8am (when Aldi resets their weekly ad)
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Weekly ad grocery category pages on aldi.us
const GROCERY_CATEGORIES = [
  { url: "https://www.aldi.us/products/fresh-meat-seafood/k/12", name: "Fresh Meat & Seafood" },
  { url: "https://www.aldi.us/products/fresh-produce/k/13", name: "Fresh Produce" },
  { url: "https://www.aldi.us/products/dairy-eggs/k/10", name: "Dairy & Eggs" },
  { url: "https://www.aldi.us/products/bakery-bread/k/6", name: "Bakery & Bread" },
  { url: "https://www.aldi.us/products/frozen-foods/k/14", name: "Frozen Foods" },
  { url: "https://www.aldi.us/products/pantry-essentials/k/16", name: "Pantry Essentials" },
  { url: "https://www.aldi.us/products/snacks/k/20", name: "Snacks" },
  { url: "https://www.aldi.us/products/breakfast-cereals/k/9", name: "Breakfast & Cereals" },
  { url: "https://www.aldi.us/products/beverages/k/7", name: "Beverages" },
  { url: "https://www.aldi.us/products/deli/k/11", name: "Deli" },
];

function getWeekDates() {
  const now = new Date();
  const day = now.getDay();
  const daysToWed = (3 - day + 7) % 7 || 7;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - (7 - daysToWed));
  const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);
  return {
    weekStart: weekStart.toISOString().split("T")[0],
    weekEnd: weekEnd.toISOString().split("T")[0],
  };
}

async function scrapeCategory(page, url, categoryName) {
  console.log(`  Scraping ${categoryName}...`);

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
  } catch (e) {
    console.log(`    ⚠️  Timeout on ${categoryName}, continuing...`);
  }

  const products = await page.evaluate((catName) => {
    const items = [];
    const selectors = [
      "[data-test='product-tile']",
      "[class*='ProductTile']",
      "[class*='product-tile']",
      "[class*='productTile']",
      "article[class*='product']",
      "li[class*='product']",
    ];

    let productEls = [];
    for (const sel of selectors) {
      productEls = [...document.querySelectorAll(sel)];
      if (productEls.length > 0) break;
    }

    productEls.forEach((el, i) => {
      const nameEl = el.querySelector(
        "h2, h3, h4, [class*='title'], [class*='name'], [class*='description'], [class*='Title'], [class*='Name']"
      );
      const name = nameEl?.textContent?.trim() || "";
      if (!name) return;

      const priceEl = el.querySelector("[class*='price'], [data-test*='price']");
      const priceText = priceEl?.textContent?.trim() || "";

      const wasEl = el.querySelector(
        "[class*='was'], [class*='regular'], [class*='original'], [class*='before'], s, strike, del"
      );
      const wasText = wasEl?.textContent?.trim() || "";

      const imgEl = el.querySelector("img");
      const image = imgEl?.src || imgEl?.getAttribute("data-src") || "";

      const linkEl = el.querySelector("a");
      const link = linkEl?.href || "";

      if (!priceText || !priceText.includes("$")) return;

      const salePrice = parseFloat(priceText.replace(/[^0-9.]/g, ""));
      const regPrice = wasText ? parseFloat(wasText.replace(/[^0-9.]/g, "")) : null;
      const hasPriceDrop = regPrice && regPrice > salePrice;

      if (salePrice) {
        items.push({ name, category: catName, priceText, wasText, salePrice, regPrice, hasPriceDrop, image, link, index: i });
      }
    });

    return items;
  }, categoryName);

  const withDrops = products.filter(p => p.hasPriceDrop);
  const result = withDrops.length > 0 ? withDrops : products;
  console.log(`    ✓ ${result.length} items (${withDrops.length} with price drops)`);
  return result;
}

async function saveToSupabase(deals) {
  if (deals.length === 0) { console.log("⚠️  No deals to save"); return; }
  await supabase.from("aldi_deals").delete().neq("id", "____");
  const BATCH = 100;
  for (let i = 0; i < deals.length; i += BATCH) {
    const batch = deals.slice(i, i + BATCH);
    const { error } = await supabase.from("aldi_deals").upsert(batch);
    if (error) console.error("  ❌ Error:", error.message);
    else console.log(`  ✅ Saved ${batch.length} items`);
  }
}

async function main() {
  console.log("🛒 Starting Aldi Weekly Ad scraper...");
  const { weekStart, weekEnd } = getWeekDates();
  console.log(`📅 Week: ${weekStart} → ${weekEnd}\n`);

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const allProducts = [];

  for (const cat of GROCERY_CATEGORIES) {
    const items = await scrapeCategory(page, cat.url, cat.name);
    allProducts.push(...items);
    await page.waitForTimeout(1000);
  }

  await browser.close();

  const seen = new Set();
  const unique = allProducts.filter((p) => {
    const key = `${p.name}-${p.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n📊 Total unique grocery items: ${unique.length}`);

  const deals = unique.map((p, i) => ({
    id: `aldi-${i}-${p.name.slice(0, 20).replace(/\s+/g, "-").toLowerCase().replace(/[^a-z0-9-]/g, "")}`,
    name: p.name,
    brand: "",
    category: p.category,
    price: p.priceText,
    regular_price: p.wasText || "",
    savings: p.hasPriceDrop ? `$${(p.regPrice - p.salePrice).toFixed(2)}` : "",
    image: p.image,
    product_url: p.link,
    week_start: weekStart,
    week_end: weekEnd,
  }));

  await saveToSupabase(deals);
  console.log("\n✅ Aldi scrape complete!");
}

main().catch(console.error);
