/**
 * Aldi Weekly Ad Scraper
 * Sources:
 *   1. https://www.aldi.us/weekly-specials/weekly-ads
 *   2. https://www.aldi.us/products/featured/price-drops/k/280
 *
 * Run: node Aldi.js
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SOURCES = [
  { url: "https://www.aldi.us/products/featured/price-drops/k/280", name: "Price Drops" },
  { url: "https://www.aldi.us/weekly-specials/weekly-ads", name: "Weekly Ads" },
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

async function scrapePage(page, url, sourceName) {
  console.log(`\n📄 Scraping ${sourceName}...`);
  console.log(`   ${url}`);

  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  
  // Scroll to load all products
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
  }

  // Log what's on the page to help debug
  const pageInfo = await page.evaluate(() => {
    const allText = document.body.innerText.slice(0, 500);
    const imgs = document.querySelectorAll("img").length;
    const links = document.querySelectorAll("a").length;
    const articleCount = document.querySelectorAll("article").length;
    const liCount = document.querySelectorAll("li").length;
    return { allText, imgs, links, articleCount, liCount };
  });
  console.log(`   Page has ${pageInfo.imgs} images, ${pageInfo.articleCount} articles, ${pageInfo.liCount} list items`);

  const products = await page.evaluate((srcName) => {
    const items = [];

    // Try every possible product card selector
    const selectors = [
      "[data-test='product-tile']",
      "[class*='ProductTile']",
      "[class*='product-tile']",
      "[class*='productTile']",
      "[class*='ProductCard']",
      "[class*='product-card']",
      "article",
      "[class*='weekly'] li",
      "[class*='grid'] li",
      "[class*='item']",
    ];

    let productEls = [];
    for (const sel of selectors) {
      const found = [...document.querySelectorAll(sel)];
      // Must have an image and some text
      const valid = found.filter(el => el.querySelector("img") && el.textContent.trim().length > 5);
      if (valid.length > 2) {
        productEls = valid;
        break;
      }
    }

    productEls.forEach((el, i) => {
      const text = el.textContent || "";
      
      // Skip non-food items
      const nonFood = ["candle", "storage", "furniture", "clothing", "tool", "appliance", "gadget", "mat", "towel", "sheets", "pillow"];
      if (nonFood.some(w => text.toLowerCase().includes(w))) return;

      // Name
      const nameEl = el.querySelector("h2, h3, h4, [class*='title'], [class*='name'], [class*='description'], [class*='Title'], [class*='Name'], p");
      const name = nameEl?.textContent?.trim() || "";
      if (!name || name.length < 3) return;

      // All price elements
      const priceEls = [...el.querySelectorAll("[class*='price'], [class*='Price']")];
      const allPrices = priceEls.map(p => p.textContent.trim()).filter(t => t.includes("$"));

      // Crossed out / was price
      const wasEl = el.querySelector("s, strike, del, [class*='was'], [class*='Was'], [class*='regular'], [class*='Regular'], [class*='original'], [class*='Original'], [class*='before'], [class*='old']");
      const wasText = wasEl?.textContent?.trim() || "";

      // Current price (first $ amount that isn't the was price)
      let priceText = allPrices.find(p => p !== wasText) || allPrices[0] || "";
      if (!priceText) {
        const match = text.match(/\$[\d]+\.[\d]{2}/);
        priceText = match ? match[0] : "";
      }

      const imgEl = el.querySelector("img");
      const image = imgEl?.src || imgEl?.getAttribute("data-src") || "";
      const linkEl = el.querySelector("a[href]");
      const link = linkEl?.href || "";

      if (!priceText) return;

      const salePrice = parseFloat(priceText.replace(/[^0-9.]/g, ""));
      const regPrice = wasText ? parseFloat(wasText.replace(/[^0-9.]/g, "")) : null;

      if (!salePrice || salePrice > 50) return; // sanity check for grocery prices

      items.push({
        name,
        source: srcName,
        priceText,
        wasText,
        salePrice,
        regPrice,
        hasPriceDrop: !!(regPrice && regPrice > salePrice),
        image,
        link,
      });
    });

    return items;
  }, sourceName);

  console.log(`   ✓ Found ${products.length} items (${products.filter(p => p.hasPriceDrop).length} with price drops)`);
  return products;
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
  console.log("🛒 Starting Aldi scraper...");
  const { weekStart, weekEnd } = getWeekDates();
  console.log(`📅 Week: ${weekStart} → ${weekEnd}`);

  const browser = await chromium.launch({ 
    headless: false, // visible browser so we can see what's happening
    args: ["--no-sandbox"] 
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const allProducts = [];

  for (const source of SOURCES) {
    const items = await scrapePage(page, source.url, source.name);
    allProducts.push(...items);
    await page.waitForTimeout(2000);
  }

  await browser.close();

  // Deduplicate
  const seen = new Set();
  const unique = allProducts.filter((p) => {
    const key = p.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n📊 Total unique items: ${unique.length}`);

  const deals = unique.map((p, i) => ({
    id: `aldi-${i}-${p.name.slice(0, 20).replace(/\s+/g, "-").toLowerCase().replace(/[^a-z0-9-]/g, "")}`,
    name: p.name,
    brand: "",
    category: p.source,
    price: p.priceText,
    regular_price: p.wasText || "",
    savings: p.hasPriceDrop ? `$${(p.regPrice - p.salePrice).toFixed(2)}` : "",
    image: p.image,
    product_url: p.link,
    week_start: weekStart,
    week_end: weekEnd,
  }));

  await saveToSupabase(deals);
  console.log("\n✅ Done!");
}

main().catch(console.error);
