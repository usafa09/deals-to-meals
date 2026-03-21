/**
 * Aldi Weekly Ad Scraper
 * Sources:
 *   1. https://www.aldi.us/weekly-specials/weekly-ads  (image flyer with overlay buttons)
 *   2. https://www.aldi.us/products/featured/price-drops/k/280 (product cards)
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

const ZIP_CODE = "45432";

function formatDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
}

function getWeekDates() {
  const now = new Date();
  const day = now.getDay();
  const daysSinceWed = (day - 3 + 7) % 7;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - daysSinceWed);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  return { weekStart: formatDate(weekStart), weekEnd: formatDate(weekEnd) };
}

const NON_FOOD = [
  "rug", "area rug", "mat", "planter", "vase", "stand", "ladder", "tile",
  "magnetic", "coir", "suncatcher", "garden", "appliance", "clothing",
  "apparel", "storage", "furniture", "decor", "candle", "pillow", "towel",
  "sheet", "lamp", "bulb", "battery", "cleaner", "detergent", "laundry",
  "trash", "plant holder", "geode", "propagation", "sewing", "sponge",
  "chair", "patio", "trellis", "irrigation", "saucer", "wreath", "gnome",
  "runner", "dustpan", "brush set", "scrubber", "vacuum", "organizer",
  "sensory bin", "gaming table", "trunk", "dryer ball", "sign",
  "kirkton", "belavi", "easy home", "ride + go", "ambiano", "joie",
  "creativity for kids", "power force"
];

// ALDI brand prefixes to strip
const ALDI_BRANDS = [
  "appleton farms", "happy farms", "never any!", "never any",
  "fremont fish market", "simply nature", "carlini", "cattlemen's ranch",
  "cattlemens ranch", "southern grove", "stonemill", "baker's corner",
  "bakers corner", "specially selected", "park street deli", "casa mamita",
  "mama cozzi's pizza kitchen", "mama cozzis pizza kitchen",
  "millville", "brookdale", "chef's cupboard", "chefs cupboard",
  "reggano", "savoritz", "emporium selection", "friendly farms",
  "barissimo", "choceur", "clancy's", "clancys", "moser roth",
  "elevation", "health-ade", "health ade", "northern catch",
  "poppi", "bremer", "mag melon", "driscoll's", "driscolls",
];

// Flavor/preparation words that turn prepared products into generic ingredients
const PREP_DESCRIPTORS = [
  "cedar plank", "orange ginger", "mediterranean herb", "black forest",
  "lemon pepper", "teriyaki", "cajun", "buffalo", "honey garlic",
  "garlic herb", "herb crusted", "breaded", "battered", "smoked",
  "applewood smoked", "hickory smoked", "maple glazed", "bbq",
  "barbecue", "sweet & sour", "sweet and sour", "sesame ginger",
  "fire roasted", "sun dried", "sun-dried", "fully cooked",
  "ready to eat", "oven ready", "instant", "quick cook",
  "antibiotic free", "family pack", "usda choice",
];

/**
 * Cleans an ALDI product name to a simple ingredient name:
 * - Strips brand prefix (e.g. "Appleton Farms —")
 * - Strips size suffix (e.g. ", 12 oz — 12 oz")
 * - Strips preparation descriptors (e.g. "Cedar Plank", "Orange Ginger")
 * - Strips "per lb" and similar units
 * - Title-cases the result
 */
function cleanName(rawName) {
  let name = rawName;

  // 1. Strip brand prefix — everything before and including " — " or " - "
  const dashMatch = name.match(/^(.+?)\s*[—–]+\s*/);
  if (dashMatch) {
    const beforeDash = dashMatch[1].toLowerCase().trim();
    const isBrand = ALDI_BRANDS.some(b => beforeDash.includes(b));
    if (isBrand) {
      name = name.slice(dashMatch[0].length).trim();
    }
  }

  // 2. Strip size suffix — ", 12 oz" / ", 1 lb" / ", 6 count" / ", per lb" etc.
  name = name
    .replace(/,\s*\d[\d.\s]*\s*(oz|lb|lbs|fl oz|ct|count|pack|pk)\b.*/i, "")
    .replace(/,?\s*per\s+lb\b.*/i, "")
    .replace(/\s*—\s*\d[\d.\s]*(oz|lb|lbs|fl oz|ct|count|pack|pk)\b.*/i, "")
    .trim();

  // 3. Strip preparation descriptors
  for (const desc of PREP_DESCRIPTORS) {
    const re = new RegExp(`\\b${desc}\\b`, "gi");
    if (re.test(name)) {
      name = name.replace(re, "").replace(/\s{2,}/g, " ").trim();
    }
  }

  // 4. Clean up leftover punctuation and whitespace
  name = name
    .replace(/^[,\s—–\-!]+/, "")
    .replace(/[,\s—–\-!]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // 5. Title-case
  name = name.replace(/\b\w/g, c => c.toUpperCase());

  return name || rawName; // fall back to original if cleaning produces empty string
}

function isFood(name) {
  const lower = name.toLowerCase();
  return !NON_FOOD.some(w => lower.includes(w));
}

async function scrapeWeeklyAds(page) {
  console.log(`\n🌐 Navigating to Weekly Ads page...`);

  await page.goto("https://www.aldi.us/store-locator", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const zipInput = await page.locator("input[placeholder*='zip'], input[type='text'], input[name*='zip'], input[id*='zip']").first();
  if (await zipInput.isVisible().catch(() => false)) {
    await zipInput.fill(ZIP_CODE);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    console.log(`   📍 Set location to ${ZIP_CODE}`);
  }

  await page.goto("https://www.aldi.us/weekly-specials/weekly-ads", { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
  }

  const products = await page.evaluate(() => {
    const docsToSearch = [document];
    [...document.querySelectorAll("iframe")].forEach(iframe => {
      try { if (iframe.contentDocument) docsToSearch.push(iframe.contentDocument); } catch(e) {}
    });

    let buttons = [];
    docsToSearch.forEach(doc => {
      buttons = [...buttons, ...doc.querySelectorAll("button.item-overlay[aria-label]")];
    });

    const items = [];
    buttons.forEach(btn => {
      const label = btn.getAttribute("aria-label") || "";
      if (!label) return;

      const cleaned = label.replace(/\.\s*select for details\.?/i, "").trim();
      const priceMatch = cleaned.match(/\$[\d]+\.[\d]{2}/);
      if (!priceMatch) return;

      const priceText = priceMatch[0];
      const salePrice = parseFloat(priceText.replace("$", ""));
      if (!salePrice || salePrice > 100) return;

      const hasPriceDrop = /price drops?/i.test(cleaned);

      let name = cleaned
        .replace(/price drops?/i, "")
        .replace(/\$[\d]+\.[\d]{2}.*$/, "")
        .replace(/,\s*,/g, ",")
        .replace(/,\s*$/, "")
        .trim();

      if (!name || name.length < 3) return;

      const parts = name.split(",").map(s => s.trim()).filter(Boolean);
      const productName = parts[0] || name;
      const size = parts[1] || "";
      const globalId = btn.getAttribute("data-global-id") || "";

      items.push({
        name: productName + (size ? `, ${size}` : ""),
        priceText,
        salePrice,
        hasPriceDrop,
        wasText: "",
        regPrice: null,
        image: "",
        link: globalId ? `https://www.aldi.us/p/${globalId}` : "",
        source: "Weekly Ads",
      });
    });

    return items;
  });

  console.log(`   ✓ Found ${products.length} items from Weekly Ads flyer`);
  return products;
}

async function scrapePriceDrops(page) {
  console.log(`\n🌐 Navigating to Price Drops page...`);

  await page.goto("https://www.aldi.us/products/featured/price-drops/k/280", { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});

  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
  }

  const products = await page.evaluate(() => {
    const items = [];
    const allEls = [...document.querySelectorAll("*")];

    let productEls = allEls.filter(el => {
      const hasImg = !!el.querySelector("img");
      const hasPrice = el.textContent.includes("$");
      const childCount = el.children.length;
      const tag = el.tagName.toLowerCase();
      return hasImg && hasPrice && childCount >= 2 && childCount <= 15 && tag !== "body" && tag !== "html";
    });

    productEls = productEls.filter(el => !productEls.some(other => other !== el && el.contains(other)));

    productEls.forEach((el) => {
      const allTextEls = [...el.querySelectorAll("p, span, h1, h2, h3, h4, h5, div")].filter(t => {
        const txt = t.textContent.trim();
        const directText = [...t.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join("");
        return directText.length > 2 && !txt.includes("$") && txt.length < 100;
      });

      const priceEls = [...el.querySelectorAll("*")].filter(e => {
        const txt = e.textContent.trim();
        return txt.startsWith("$") && txt.length < 15;
      });

      const wasEl = el.querySelector("s, strike, del, [class*='was'], [class*='Was'], [class*='regular'], [class*='Regular'], [class*='original'], [class*='before'], [class*='old'], [class*='compare']");
      const wasText = wasEl?.textContent?.trim() || "";

      const prices = priceEls.map(p => ({
        text: p.textContent.trim(),
        val: parseFloat(p.textContent.replace(/[^0-9.]/g, "")),
        isWas: wasEl?.contains(p),
      })).filter(p => p.val && p.val > 0);

      const currentPrice = prices.find(p => !p.isWas) || prices[0];
      if (!currentPrice) return;
      if (currentPrice.val > 50) return;

      const cleanPriceText = `$${currentPrice.val.toFixed(2)}`;

      const nameParts = allTextEls
        .map(e => e.textContent.trim())
        .filter(t => t.length > 2 && !t.startsWith("$") && !t.startsWith("You save") && t !== cleanPriceText && t !== wasText)
        .filter((t, idx, arr) => arr.indexOf(t) === idx);

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
        source: "Price Drops",
        priceText: cleanPriceText,
        wasText,
        salePrice: currentPrice.val,
        regPrice,
        hasPriceDrop,
        image,
        link,
      });
    });

    return items;
  });

  console.log(`   ✓ Found ${products.length} items from Price Drops`);
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

  const browser = await chromium.launch({ headless: false, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  const weeklyItems = await scrapeWeeklyAds(page);
  await page.waitForTimeout(2000);
  const priceDropItems = await scrapePriceDrops(page);

  await browser.close();

  const allProducts = [...weeklyItems, ...priceDropItems].filter(p => isFood(p.name));

  const seen = new Set();
  const unique = allProducts.filter((p) => {
    const key = `${p.name.toLowerCase().trim()}-${p.salePrice}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n📊 Total unique items: ${unique.length}`);

  const deals = unique.map((p, i) => {
    const cleanedName = cleanName(p.name);
    console.log(`  - "${cleanedName}"  (original: "${p.name}")  ${p.priceText} [${p.source}]`);
    return {
      id: `aldi-${i}-${cleanedName.slice(0, 20).replace(/\s+/g, "-").toLowerCase().replace(/[^a-z0-9-]/g, "")}`,
      name: cleanedName,
      brand: "",
      category: p.source,
      price: p.priceText,
      regular_price: p.wasText || "",
      savings: p.hasPriceDrop && p.regPrice ? `$${(p.regPrice - p.salePrice).toFixed(2)}` : "",
      image: p.image,
      product_url: p.link,
      week_start: weekStart,
      week_end: weekEnd,
    };
  });

  console.log(`\n💾 Saving ${deals.length} items to Supabase...`);
  await saveToSupabase(deals);
  console.log("\n✅ Done!");
}

main().catch(console.error);