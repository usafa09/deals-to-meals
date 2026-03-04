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

// Keywords that indicate ALDI Finds (non-grocery items) — skip these
const ALDI_FINDS_KEYWORDS = [
  "candle", "storage", "furniture", "clothing", "shirt", "pants", "jacket",
  "tool", "drill", "vacuum", "mop", "broom", "fan", "heater", "lamp",
  "towel", "sheets", "pillow", "blanket", "mat", "rug", "curtain",
  "planter", "garden", "hose", "shovel", "rake", "ladder",
  "luggage", "backpack", "bag", "wallet", "shoe", "boot", "sandal",
  "toy", "game", "puzzle", "book", "stationery",
  "air fryer", "instant pot", "blender", "coffee maker", "toaster",
  "television", "speaker", "headphone", "tablet", "laptop", "phone",
  "exercise", "yoga", "dumbbell", "weight", "bike",
];

function isAldiFind(name) {
  const lower = name.toLowerCase();
  return ALDI_FINDS_KEYWORDS.some(kw => lower.includes(kw));
}

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
  console.log(`\n📄 Scraping: ${url}`);
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});

  // Scroll to load all products
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
  }

  const products = await page.evaluate(() => {
    const items = [];
    const selectors = [
      "[data-test='product-tile']",
      "[class*='ProductTile']",
      "[class*='product-tile']",
      "[class*='productTile']",
      "[class*='ProductCard']",
      "article",
    ];

    let productEls = [];
    for (const sel of selectors) {
      const found = [...document.querySelectorAll(sel)].filter(
        el => el.querySelector("img") && el.textContent.trim().length > 5
      );
      if (found.length > 2) { productEls = found; break; }
    }

    productEls.forEach((el, i) => {
      const nameEl = el.querySelector("h2, h3, h4, [class*='title'], [class*='name'], [class*='description']");
      const name = nameEl?.textContent?.trim() || "";
      if (!name || name.length < 3) return;

      // Skip if tagged as ALDI Find in the HTML
      const elHTML = el.innerHTML.toLowerCase();
      if (elHTML.includes("aldi find") || elHTML.includes("aldifind")) return;

      // Check for any section/label that says "ALDI Finds"
      const labelEl = el.querySelector("[class*='label'], [class*='badge'], [class*='tag'], [class*='Label']");
      const label = labelEl?.textContent?.toLowerCase() || "";
      if (label.includes("find")) return;

      const priceEls = [...el.querySelectorAll("[class*='price'], [class*='Price']")];
      const allPrices = priceEls.map(p => p.textContent.trim()).filter(t => t.includes("$"));

      const wasEl = el.querySelector("s, strike, del, [class*='was'], [class*='Was'], [class*='regular'], [class*='Regular'], [class*='original'], [class*='before'], [class*='old']");
      const wasText = wasEl?.textContent?.trim() || "";

      let priceText = allPrices.find(p => p !== wasText) || allPrices[0] || "";
      if (!priceText) {
        const match = el.textContent.match(/\$[\d]+\.[\d]{2}/);
        priceText = match ? match[0] : "";
      }

      if (!priceText) return;

      const salePrice = parseFloat(priceText.replace(/[^0-9.]/g, ""));
      const regPrice = wasText ? parseFloat(wasText.replace(/[^0-9.]/g, "")) : null;
      if (!salePrice || salePrice > 50) return;

      const imgEl = el.querySelector("img");
      const image = imgEl?.src || imgEl?.getAttribute("data-src") || "";
      const linkEl = el.querySelector("a[href]");
      const link = linkEl?.href || "";

      items.push({ name, priceText, wasText, salePrice, regPrice, hasPriceDrop: !!(regPrice && regPrice > salePrice), image, link });
    });

    return items;
  });

  // Filter out ALDI Finds by name
  const groceryOnly = products.filter(p => !isAldiFind(p.name));
  console.log(`   Found ${products.length} total → ${groceryOnly.length} grocery items after filtering ALDI Finds`);
  return groceryOnly;
}

async function saveToSupabase(deals, weekStart, weekEnd) {
  if (deals.length === 0) { console.log("⚠️  No deals to save"); return; }
  await supabase.from("aldi_deals").delete().neq("id", "____");
  const rows = deals.map((p, i) => ({
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
  const { error } = await supabase.from("aldi_deals").upsert(rows);
  if (error) console.error("❌ Error:", error.message);
  else console.log(`✅ Saved ${rows.length} items to Supabase`);
}

async function main() {
  console.log("🛒 Starting Aldi scraper (grocery items only, no ALDI Finds)...");
  const { weekStart, weekEnd } = getWeekDates();
  console.log(`📅 Week: ${weekStart} → ${weekEnd}`);

  const browser = await chromium.launch({ headless: false, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const allProducts = [];

  for (const source of SOURCES) {
    const items = await scrapePage(page, source.url, source.name);
    items.forEach(p => p.source = source.name);
    allProducts.push(...items);
    await page.waitForTimeout(2000);
  }

  await browser.close();

  // Deduplicate by name
  const seen = new Set();
  const unique = allProducts.filter(p => {
    const key = p.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n📊 Total unique grocery items: ${unique.length}`);
  await saveToSupabase(unique, weekStart, weekEnd);
  console.log("\n✅ Done!");
}

main().catch(console.error);
