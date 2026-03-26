// ad-pipeline.js — Automated weekly ad collection + AI deal extraction
// Run weekly: node ad-pipeline.js
// Or for a specific store: node ad-pipeline.js --store publix

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ══════════════════════════════════════════════════════════════════════════
// STORE CONFIGURATIONS — add new stores here
// ══════════════════════════════════════════════════════════════════════════

const STORES = [
  {
    id: "publix",
    name: "Publix",
    adPageUrl: "https://www.igroceryads.com/publix-weekly-specials/",
  },
  {
    id: "meijer",
    name: "Meijer",
    adPageUrl: "https://www.igroceryads.com/meijer-weekly-ad-deals/",
  },
  {
    id: "food-lion",
    name: "Food Lion",
    adPageUrl: "https://www.igroceryads.com/food-lion-circular/",
  },
  {
    id: "hyvee",
    name: "Hy-Vee",
    adPageUrl: "https://www.igroceryads.com/hy-vee-weekly-ad/",
  },
  {
    id: "sprouts",
    name: "Sprouts",
    adPageUrl: "https://www.igroceryads.com/sprouts-weekly-ad-sales/",
  },
  {
    id: "giant-eagle",
    name: "Giant Eagle",
    adPageUrl: "https://www.igroceryads.com/giant-eagle-weekly-sale-ad/",
  },
  {
    id: "albertsons",
    name: "Albertsons",
    adPageUrl: "https://www.igroceryads.com/albertsons-weekly-ad-cat/",
  },
  {
    id: "safeway",
    name: "Safeway",
    adPageUrl: "https://www.igroceryads.com/safeway-weekly-ad-cat/",
  },
  // ── FIXED URLs (were pointing to category pages) ──
  {
    id: "winn-dixie",
    name: "Winn-Dixie",
    adPageUrl: "https://www.igroceryads.com/winn-dixie-sales/",
  },
  {
    id: "save-a-lot",
    name: "Save-A-Lot",
    adPageUrl: "https://www.igroceryads.com/save-a-lot-ad-specials/",
  },
  {
    id: "shoprite",
    name: "ShopRite",
    adPageUrl: "https://www.igroceryads.com/shoprite-this-week-sale-circular/",
  },
  {
    id: "lidl",
    name: "Lidl",
    adPageUrl: "https://www.igroceryads.com/lidl-promotions/",
  },
  {
    id: "stop-and-shop",
    name: "Stop & Shop",
    adPageUrl: "https://www.igroceryads.com/stop-and-shop-weekly-circular/",
  },
  {
    id: "acme",
    name: "Acme",
    adPageUrl: "https://www.igroceryads.com/acme-weekly-ad-acme-markets-circular/",
  },
  {
    id: "piggly-wiggly",
    name: "Piggly Wiggly",
    adPageUrl: "https://www.igroceryads.com/piggly-wiggly-weekly-ad/",
  },
  {
    id: "ingles",
    name: "Ingles",
    adPageUrl: "https://www.igroceryads.com/ingles-weekly-ad-ingles-markets-ad/",
  },
  {
    id: "food-city",
    name: "Food City",
    adPageUrl: "https://www.igroceryads.com/food-city-weekly-ad-current-circulars/",
  },
  {
    id: "giant-food",
    name: "Giant Food",
    adPageUrl: "https://www.igroceryads.com/giant-food-weekly-ad-deals/",
  },
  {
    id: "hannaford",
    name: "Hannaford",
    adPageUrl: "https://www.igroceryads.com/hannaford-flyer/",
  },
  {
    id: "big-y",
    name: "Big Y",
    adPageUrl: "https://www.igroceryads.com/big-y-flyer-big-y-circular/",
  },
  {
    id: "key-food",
    name: "Key Food",
    adPageUrl: "https://www.igroceryads.com/key-food-circular/",
  },
  {
    id: "rouses",
    name: "Rouses",
    adPageUrl: "https://www.igroceryads.com/rouses-ad/",
  },
  {
    id: "bashas",
    name: "Bashas'",
    adPageUrl: "https://www.igroceryads.com/bashas-weekly-ad/",
  },
  // ── ladysavings.com stores (paginated, images on hotcouponworld.com) ──
  {
    id: "harris-teeter",
    name: "Harris Teeter",
    adPageUrl: "https://www.ladysavings.com/harristeeter-weekly-ad/",
    paginated: true,
  },
  {
    id: "fresh-thyme",
    name: "Fresh Thyme",
    adPageUrl: "https://www.ladysavings.com/freshthyme-weekly-ad/",
    paginated: true,
  },
  {
    id: "grocery-outlet",
    name: "Grocery Outlet",
    adPageUrl: "https://www.ladysavings.com/groceryoutlet-weekly-ad/",
    paginated: true,
  },
  {
    id: "winco",
    name: "WinCo",
    adPageUrl: "https://www.iweeklyads.com/winco-weekly-ad/",
  },
  {
    id: "festival-foods",
    name: "Festival Foods",
    adPageUrl: "https://www.ladysavings.com/festivalfoods-weekly-ad/",
    paginated: true,
  },
  // ── iweeklyads.com stores (text extraction) ──
  {
    id: "schnucks",
    name: "Schnucks",
    adPageUrl: "https://www.iweeklyads.com/schnucks-weekly-ad/",
  },
  {
    id: "whole-foods",
    name: "Whole Foods",
    adPageUrl: "https://www.iweeklyads.com/whole-foods-ad-specials/",
  },
];

// ══════════════════════════════════════════════════════════════════════════
// STEP 1: Fetch ad page images from igroceryads.com
// ══════════════════════════════════════════════════════════════════════════

async function fetchAdPageImages(store) {
  console.log(`\n📰 Fetching ad page for ${store.name}...`);
  
  const res = await fetch(store.adPageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
  });
  const html = await res.text();

  // For paginated ladysavings stores, fetch each page and collect hotcouponworld images
  if (store.paginated) {
    const allImages = [];
    // Extract image from first page
    const hcwRegex = /https:\/\/www\.hotcouponworld\.com\/wp-content\/uploads\/\d{4}\/\d{2}\/[^"'\s)]+\.(?:jpg|jpeg|png|webp)/gi;
    const firstPageImages = (html.match(hcwRegex) || []).filter(url => !url.includes("-150x150") && !url.includes("-300x") && !url.includes("_header"));
    if (firstPageImages.length > 0) allImages.push(firstPageImages[0]);

    // Detect total pages from "N of M" pattern
    const pageMatch = html.match(/1\s+of\s+(\d+)/);
    const totalPages = pageMatch ? parseInt(pageMatch[1]) : 1;
    console.log(`  📄 Ladysavings paginated: ${totalPages} pages detected`);

    // Fetch remaining pages
    for (let p = 2; p <= Math.min(totalPages, 25); p++) {
      try {
        await new Promise(r => setTimeout(r, 500));
        const pageRes = await fetch(`${store.adPageUrl}${p}/`, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        const pageHtml = await pageRes.text();
        const pageImages = (pageHtml.match(hcwRegex) || []).filter(url => !url.includes("-150x150") && !url.includes("-300x") && !url.includes("_header"));
        if (pageImages.length > 0) allImages.push(pageImages[0]);
      } catch (e) { console.error(`  Page ${p} error: ${e.message}`); }
    }
    console.log(`  Found ${allImages.length} ad pages`);
    return { images: allImages.slice(0, 25), html };
  }

  // Standard: extract image URLs from the page (igroceryads/iweeklyads)

  // Extract image URLs from the page (WordPress wp-content/uploads pattern)
  const imgRegex = /https:\/\/www\.(?:igroceryads|iweeklyads)\.com\/wp-content\/uploads\/\d{4}\/\d{2}\/[^"'\s)]+\.(?:webp|jpg|jpeg|png)/gi;
  const allImages = [...new Set(html.match(imgRegex) || [])];
  
  // Filter out thumbnails and duplicates
  let adPages = allImages
    .filter(url => !url.includes("-150x150"))
    .filter(url => !url.includes("-300x"))
    .filter(url => !url.includes("-100x"))
    .filter(url => !url.includes("-200x200"))
    // Sort by page number — handles page_N, imgNNN, hash-NN-scaled patterns
    .sort((a, b) => {
      const extractNum = (url) => {
        const fname = url.split("/").pop();
        const m = fname.match(/page_(\d+)/) || fname.match(/img(\d+)/) || fname.match(/-(\d+)-scaled/) || fname.match(/-(\d+)\./);
        return parseInt(m?.[1] || "0");
      };
      return extractNum(a) - extractNum(b);
    });

  // Deduplicate
  adPages = [...new Set(adPages)];

  // If we found very few images, try to detect a numbered pattern and generate missing URLs
  // (handles lazy-loaded images that aren't in the raw HTML)
  if (adPages.length <= 3 && adPages.length > 0) {
    const sample = adPages[0];
    // Try pattern: hash-N-scaled.ext (e.g. a6d10174-1-scaled.jpg)
    const scaledMatch = sample.match(/^(.*-)(\d+)(-scaled\.\w+)$/);
    // Try pattern: imgNNN.ext (e.g. img001.jpg)
    const imgMatch = sample.match(/^(.*img)(\d+)(\.\w+)$/);
    // Try pattern: page_N_level_4_HASH.ext
    const pageMatch = sample.match(/^(.*page_)(\d+)(_level_4_\d+\.\w+)$/);

    if (scaledMatch) {
      const [, prefix, , suffix] = scaledMatch;
      console.log(`  🔎 Detected numbered pattern, probing for more pages...`);
      for (let n = 1; n <= 30; n++) {
        const url = `${prefix}${n}${suffix}`;
        if (!adPages.includes(url)) {
          try {
            const probe = await fetch(url, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } });
            if (probe.ok && (probe.headers.get("content-type") || "").startsWith("image/")) {
              adPages.push(url);
            } else break; // stop when we hit a 404
          } catch { break; }
        }
      }
      adPages.sort((a, b) => {
        const na = parseInt(a.match(/-(\d+)-scaled/)?.[1] || "0");
        const nb = parseInt(b.match(/-(\d+)-scaled/)?.[1] || "0");
        return na - nb;
      });
    } else if (imgMatch) {
      const [, prefix, , suffix] = imgMatch;
      const pad = imgMatch[2].length; // preserve zero-padding
      console.log(`  🔎 Detected numbered pattern, probing for more pages...`);
      for (let n = 1; n <= 30; n++) {
        const url = `${prefix}${String(n).padStart(pad, "0")}${suffix}`;
        if (!adPages.includes(url)) {
          try {
            const probe = await fetch(url, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } });
            if (probe.ok && (probe.headers.get("content-type") || "").startsWith("image/")) {
              adPages.push(url);
            } else break;
          } catch { break; }
        }
      }
    }
    console.log(`  Found ${adPages.length} ad pages (after probing)`);
  } else {
    console.log(`  Found ${adPages.length} ad pages`);
  }
  
  return { images: adPages.slice(0, 25), html }; // cap at 25 pages
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 2: Download image and convert to base64
// ══════════════════════════════════════════════════════════════════════════

function getMediaType(url) {
  if (url.endsWith(".webp")) return "image/webp";
  if (url.endsWith(".png")) return "image/png";
  return "image/jpeg"; // jpg, jpeg, or default
}

async function imageToBase64(imageUrl) {
  const res = await fetch(imageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
  });
  if (!res.ok) {
    console.log(`     ⚠ Failed to download image: ${res.status} ${res.statusText}`);
    return null;
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    console.log(`     ⚠ Not an image: ${contentType} — ${imageUrl.slice(-40)}`);
    return null;
  }
  const buffer = await res.arrayBuffer();
  const b64 = Buffer.from(buffer).toString("base64");
  console.log(`     📷 Downloaded ${Math.round(buffer.byteLength / 1024)}KB — ${imageUrl.split("/").pop()}`);
  return b64;
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 3: Extract deals from image using Claude Vision
// ══════════════════════════════════════════════════════════════════════════

async function extractDealsFromImage(base64Image, storeName, pageNum, mediaType) {
  console.log(`  🔍 Extracting deals from page ${pageNum}...`);
  
  // Validate we actually got image data
  if (!base64Image || base64Image.length < 1000) {
    console.log(`     ⚠ Skipping page ${pageNum} — image too small or empty`);
    return [];
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
          { type: "text", text: `You are extracting grocery deals from a ${storeName} weekly ad image.

For EVERY sale item visible, return a JSON array. Include ALL items you can see with prices.

For each item return:
{
  "name": "Product Name",
  "brand": "Brand if visible or empty string",
  "salePrice": "2.49",
  "unit": "/lb or /ea or empty string",
  "regularPrice": "3.99 or empty string if not shown",
  "dealType": "sale or bogo or percent_off",
  "category": "meat/produce/dairy/bakery/frozen/pantry/snacks/beverages/deli/seafood/household/other",
  "size": "16 oz or 1 lb or empty string if not shown",
  "notes": "any special conditions or empty string"
}

IMPORTANT:
- Return ONLY a valid JSON array, no other text, no markdown backticks
- Include every deal item with a price visible
- For BOGO items, set dealType to "bogo" and salePrice to the price of one item
- If "2 for $5", set salePrice to "2.50" and notes to "2 for $5"
- If the item is priced per pound, set unit to "/lb"
- Skip non-food items (coolers, bags, etc.) unless they are clearly grocery items
- If the page has no grocery deals (e.g. just a header or lifestyle image), return an empty array []` }
        ]
      }]
    })
  });

  const data = await response.json();
  const text = data.content?.map(c => c.text || "").join("") || "";
  
  try {
    let cleaned = text.replace(/```json|```/g, "").trim();
    
    // Try parsing as-is first
    try {
      const deals = JSON.parse(cleaned);
      console.log(`     → ${deals.length} deals extracted`);
      return deals;
    } catch {
      // If truncated, try to recover by closing open JSON
      // Find the last complete object (ends with })
      const lastBrace = cleaned.lastIndexOf("}");
      if (lastBrace > 0) {
        const recovered = cleaned.substring(0, lastBrace + 1) + "]";
        try {
          const deals = JSON.parse(recovered);
          console.log(`     → ${deals.length} deals extracted (recovered from truncation)`);
          return deals;
        } catch { /* fall through to error */ }
      }
      throw new Error("Could not parse JSON");
    }
  } catch (err) {
    console.error(`     ⚠ Failed to parse deals from page ${pageNum}: ${err.message}`);
    console.error(`     Raw response: ${text.substring(0, 200)}...`);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 4: Store deals in Supabase cache
// ══════════════════════════════════════════════════════════════════════════

async function storeDealsBatch(storeName, storeId, allDeals) {
  // Add metadata to each deal
  const enriched = allDeals.map((d, i) => ({
    ...d,
    id: `${storeId}-${Date.now()}-${i}`,
    storeName: storeName,
    source: "ad-extract",
    image: null,
  }));

  // Store one master copy (served to all zip codes via fallback)
  const cacheKey = `ad-extract:${storeId}`;
  const { error } = await supabase.from("deal_cache").upsert({
    cache_key: cacheKey,
    data: enriched,
    fetched_at: new Date().toISOString(),
  }, { onConflict: "cache_key" });

  if (error) {
    console.error(`  ❌ Failed to cache deals for ${storeName}: ${error.message}`);
    return false;
  }

  console.log(`  ✅ Stored ${enriched.length} deals for ${storeName}`);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN PIPELINE
// ══════════════════════════════════════════════════════════════════════════

async function processStore(store) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`Processing: ${store.name}`);
  console.log(`${"═".repeat(60)}`);

  try {
    // Step 1: Get ad page image URLs and raw HTML
    const { images: imageUrls, html } = await fetchAdPageImages(store);

    // Step 2-3: Download each image and extract deals
    const allDeals = [];
    const maxPages = Math.min(imageUrls.length, 25); // cap at 25 pages
    
    if (maxPages > 0) {
      for (let i = 0; i < maxPages; i++) {
        try {
          const base64 = await imageToBase64(imageUrls[i]);
          if (!base64) continue; // skip failed downloads
          const mediaType = getMediaType(imageUrls[i]);
          const deals = await extractDealsFromImage(base64, store.name, i + 1, mediaType);
          allDeals.push(...deals);
          
          // Small delay between pages to avoid rate limits
          if (i < maxPages - 1) await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
          console.error(`  ⚠ Error on page ${i + 1}: ${err.message}`);
        }
      }
    }

    // Deduplicate by name + price
    const seen = new Set();
    let unique = allDeals.filter(d => {
      const key = `${d.name}:${d.salePrice}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // TEXT FALLBACK: If images found fewer than 10 deals, try extracting from page text
    if (unique.length < 10 && html) {
      console.log(`  📝 Only ${unique.length} deals from images — trying text extraction...`);
      try {
        const textContent = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 8000);

        if (textContent.length > 200) {
          const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": ANTHROPIC_KEY,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 8000,
              messages: [{
                role: "user",
                content: `Extract grocery deals from this ${store.name} weekly ad text.

TEXT:
${textContent}

Return ONLY a valid JSON array. For each item with a price:
{"name":"","brand":"","salePrice":"","unit":"","regularPrice":"","dealType":"sale/bogo/percent_off","category":"meat/produce/dairy/bakery/frozen/pantry/snacks/beverages/deli/seafood/household/other","size":"","notes":""}
For "2/$5" deals, set salePrice to "2.50" and notes to "2 for $5". For per-lb prices, set unit to "/lb". No markdown. Return ONLY the JSON array.`
              }]
            })
          });
          const aiData = await aiRes.json();
          const text = aiData.content?.map(c => c.text || "").join("") || "";
          let cleaned = text.replace(/```json|```/g, "").trim();
          try {
            const textDeals = JSON.parse(cleaned);
            if (textDeals.length > unique.length) {
              console.log(`  📝 Text extraction found ${textDeals.length} deals (vs ${unique.length} from images)`);
              const textSeen = new Set();
              unique = textDeals.filter(d => {
                const key = `${d.name}:${d.salePrice}`;
                if (textSeen.has(key)) return false;
                textSeen.add(key);
                return true;
              });
            }
          } catch {
            const lastBrace = cleaned.lastIndexOf("}");
            if (lastBrace > 0) {
              try {
                const recovered = JSON.parse(cleaned.substring(0, lastBrace + 1) + "]");
                if (recovered.length > unique.length) unique = recovered;
              } catch {}
            }
          }
        }
      } catch (e) { console.error(`  Text fallback error: ${e.message}`); }
    }

    console.log(`\n  📊 ${store.name}: ${unique.length} unique deals`);

    // Step 4: Store in Supabase
    if (unique.length > 0) {
      await storeDealsBatch(store.name, store.id, unique);
    }

    return { store: store.name, deals: unique.length, pages: maxPages };
  } catch (err) {
    console.error(`  ❌ Failed to process ${store.name}: ${err.message}`);
    return { store: store.name, deals: 0, error: err.message };
  }
}

async function main() {
  console.log("🚀 Dishcount Ad Extraction Pipeline");
  console.log(`   ${new Date().toISOString()}`);
  console.log(`   ${STORES.length} stores configured\n`);

  if (!ANTHROPIC_KEY) { console.error("❌ ANTHROPIC_API_KEY not set"); process.exit(1); }
  if (!SUPABASE_URL) { console.error("❌ SUPABASE_URL not set"); process.exit(1); }

  // Check if a specific store was requested
  const storeArg = process.argv.find(a => a.startsWith("--store="))?.split("=")[1] 
    || (process.argv.includes("--store") ? process.argv[process.argv.indexOf("--store") + 1] : null);

  const storesToProcess = storeArg 
    ? STORES.filter(s => s.id === storeArg || s.name.toLowerCase() === storeArg.toLowerCase())
    : STORES;

  if (storeArg && storesToProcess.length === 0) {
    console.error(`❌ Store "${storeArg}" not found. Available: ${STORES.map(s => s.id).join(", ")}`);
    process.exit(1);
  }

  const results = [];
  for (const store of storesToProcess) {
    const result = await processStore(store);
    results.push(result);
  }

  // Summary
  console.log("\n" + "═".repeat(60));
  console.log("📋 PIPELINE SUMMARY");
  console.log("═".repeat(60));
  let totalDeals = 0;
  for (const r of results) {
    const status = r.error ? `❌ ${r.error}` : `✅ ${r.deals} deals`;
    console.log(`  ${r.store.padEnd(20)} ${status}`);
    totalDeals += r.deals || 0;
  }
  console.log(`\n  Total: ${totalDeals} deals from ${results.filter(r => !r.error).length} stores`);
  console.log(`  Cost estimate: ~$${(totalDeals * 0.003).toFixed(2)} in API calls`);
}

main().catch(err => { console.error("Pipeline failed:", err); process.exit(1); });
