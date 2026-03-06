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
  { url: "https://www.aldi.us/weekly-specials/weekly-ads", name: "Weekly Ads" },
  { url: "https://www.aldi.us/products/featured/price-drops/k/280", name: "Price Drops" },
];

function getWeekDates() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  // How many days ago was the most recent Wednesday?
  const daysSinceWed = (day - 3 + 7) % 7;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - daysSinceWed);
  const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);
  return {
    weekStart: weekStart.toISOString().split("T")[0],
    weekEnd: weekEnd.toISOString().split("T")[0],
  };
}

async function scrapePage(page, url, sourceName) {
  console.log(`\n🌐 Navigating to: ${url}`);

  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});

  // Scroll multiple times to load all lazy-loaded products
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
  }
  // Scroll back to top and down again to catch any missed items
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
  }

  // Debug: log all classes on the page to find the right selector
  const debugInfo = await page.evaluate(() => {
    // Find elements that look like product cards (have image + price)
    const allEls = [...document.querySelectorAll("*")];
    const candidates = allEls.filter(el => {
      const hasImg = el.querySelector("img");
      const hasPrice = el.textContent.includes("$");
      const children = el.children.length;
      return hasImg && hasPrice && children > 1 && children < 20;
    });
    // Get unique class names from top candidates
    const classNames = [...new Set(candidates.slice(0, 20).map(el => el.className).filter(c => c && typeof c === "string"))];
    return { count: candidates.length, classNames: classNames.slice(0, 10) };
  });
  console.log(`   Found ${debugInfo.count} candidate elements`);
  console.log(`   Classes: ${debugInfo.classNames.join(" | ")}`);

  const products = await page.evaluate((srcName) => {
    const items = [];

    // Find all product card elements by looking for elements with both an image and a price
    const allEls = [...document.querySelectorAll("*")];
    let productEls = allEls.filter(el => {
      const hasImg = !!el.querySelector("img");
      const hasPrice = el.textContent.includes("$");
      const childCount = el.children.length;
      const tag = el.tagName.toLowerCase();
      // Exclude wrapper/layout elements that are too big
      return hasImg && hasPrice && childCount >= 2 && childCount <= 15 && tag !== "body" && tag !== "html";
    });

    // Remove elements that contain other matching elements (keep the innermost)
    productEls = productEls.filter(el => {
      return !productEls.some(other => other !== el && el.contains(other));
    });

    productEls.forEach((el, i) => {
      // Get ALL text nodes to build full product name
      const allTextEls = [...el.querySelectorAll("p, span, h1, h2, h3, h4, h5, div")].filter(t => {
        const txt = t.textContent.trim();
        const directText = [...t.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join("");
        return directText.length > 2 && !txt.includes("$") && txt.length < 100;
      });

      // Price elements
      const priceEls = [...el.querySelectorAll("*")].filter(e => {
        const txt = e.textContent.trim();
        return txt.startsWith("$") && txt.length < 15;
      });

      // Crossed out price
      const wasEl = el.querySelector("s, strike, del, [class*='was'], [class*='Was'], [class*='regular'], [class*='Regular'], [class*='original'], [class*='before'], [class*='old'], [class*='compare']");
      const wasText = wasEl?.textContent?.trim() || "";

      // Current price — smallest $ value or first non-was price
      const prices = priceEls.map(p => ({
        text: p.textContent.trim(),
        val: parseFloat(p.textContent.replace(/[^0-9.]/g, "")),
        isWas: wasEl?.contains(p),
      })).filter(p => p.val && p.val > 0);

      const currentPrice = prices.find(p => !p.isWas) || prices[0];
      if (!currentPrice) return;
      if (currentPrice.val > 50) return; // not a grocery item

      // Filter out non-food/home goods items
      const NON_FOOD = [
        "mat", "planter", "vase", "stand", "ladder", "tiles", "magnetic",
        "coir", "suncatcher", "hanging", "garden", "tool", "appliance",
        "clothing", "apparel", "storage", "furniture", "decor", "candle",
        "pillow", "towel", "sheet", "lamp", "light", "bulb", "battery",
        "cleaner", "detergent", "laundry", "dish", "trash", "bag",
        "plant holder", "geode", "propagation", "vases", "wood stand",
        "travel magnetic", "piece micro", "spring coir", "sun catcher"
      ];
      const nameCheck = fullName.toLowerCase();
      if (NON_FOOD.some(w => nameCheck.includes(w))) return;

      // Build full name from all text elements, joining brand + description
      const nameParts = allTextEls
        .map(e => e.textContent.trim())
        .filter(t => t.length > 2 && !t.startsWith("$") && t !== currentPrice.text && t !== wasText)
        .filter((t, idx, arr) => arr.indexOf(t) === idx); // unique

      const fullName = nameParts.slice(0, 3).join(" — ").trim();
      if (!fullName || fullName.length < 3) return;

      const imgEl = el.querySelector("img");
      const image = imgEl?.src || imgEl?.getAttribute("data-src") || "";
      const linkEl = el.querySelector("a[href]");
      const link = linkEl?.href || "";

      const regPrice = wasText ? parseFloat(wasText.replace(/[^0-9.]/g, "")) : null;
      const hasPriceDrop = !!(regPrice && regPrice > currentPrice.val);

      items.push({
        name: fullName,
        source: srcName,
        priceText: currentPrice.text,
        wasText,
        salePrice: currentPrice.val,
        regPrice,
        hasPriceDrop,
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
    headless: false,
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

  // Deduplicate by full name + price combo
  const seen = new Set();
  const unique = allProducts.filter((p) => {
    const key = `${p.name.toLowerCase().trim()}-${p.salePrice}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n📊 Total unique items: ${unique.length}`);
  console.log("Items found:");
  unique.forEach(p => console.log(`  - ${p.name} (${p.priceText})${p.hasPriceDrop ? ` was ${p.wasText}` : ""} [${p.source}]`));

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

  console.log(`\n💾 Saving ${deals.length} items to Supabase...`);
  await saveToSupabase(deals);
  console.log("\n✅ Done!");
}

main().catch(console.error);
