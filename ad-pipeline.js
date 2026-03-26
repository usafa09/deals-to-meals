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
    category: "publix-weekly-ads-weekly-bogo-sales",
    regions: ["southeastern US"],
    zip3s: ["300", "301", "302", "303", "320", "321", "322", "323", "324", "325", "326", "327", "328", "329", "330", "331", "332", "333", "334", "335", "336", "337", "338", "339", "340", "341", "342", "344", "346", "347", "349", "350", "351", "352", "354", "355", "356", "357", "358", "359", "360", "361", "362", "363", "364", "365", "366", "367", "368", "369", "370", "371", "372", "373", "374", "376", "377", "378", "379", "290", "291", "292", "293", "294", "295", "296", "297"],
  },
  {
    id: "meijer",
    name: "Meijer",
    adPageUrl: "https://www.igroceryads.com/meijer-weekly-ad-deals/",
    category: "meijer-weekly-ad-meijer-ad",
    regions: ["midwest US"],
    zip3s: ["430", "431", "432", "433", "434", "435", "436", "437", "438", "439", "440", "441", "442", "443", "444", "445", "446", "447", "448", "449", "460", "461", "462", "463", "464", "465", "466", "467", "468", "469", "480", "481", "482", "483", "484", "485", "486", "487", "488", "489", "490", "491", "492", "493", "494", "495", "496", "497", "498", "499", "530", "531", "532", "534", "535", "537", "538", "539", "600", "601", "602", "603", "604", "605", "606"],
  },
  {
    id: "food-lion",
    name: "Food Lion",
    adPageUrl: "https://www.igroceryads.com/food-lion-circular/",
    category: "food-lion-weekly-ad",
    regions: ["mid-atlantic, southeast US"],
    zip3s: ["270", "271", "272", "273", "274", "275", "276", "277", "278", "279", "280", "281", "282", "283", "284", "285", "286", "287", "288", "289", "220", "221", "222", "223", "224", "225", "226", "227", "228", "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240", "241", "242", "243", "244", "245", "246"],
  },
  {
    id: "hyvee",
    name: "Hy-Vee",
    adPageUrl: "https://www.igroceryads.com/hy-vee-weekly-ad/",
    category: "hyvee-weekly-ads-grocery-sales",
    regions: ["midwest US"],
    zip3s: ["500", "501", "502", "503", "504", "505", "506", "507", "508", "509", "510", "511", "512", "513", "514", "515", "516", "520", "521", "522", "523", "524", "525", "527", "528", "550", "551", "553", "554", "556", "557", "558", "559", "560", "561", "562", "563", "564", "565", "566", "567", "570", "571", "572", "573", "574", "575", "576", "577"],
  },
  {
    id: "sprouts",
    name: "Sprouts",
    adPageUrl: "https://www.igroceryads.com/sprouts-weekly-ad-sales/",
    category: "sprouts-specials",
    regions: ["western, southern US"],
    zip3s: ["850", "851", "852", "853", "856", "857", "900", "901", "902", "903", "904", "905", "906", "907", "908", "910", "911", "912", "913", "914", "915", "916", "917", "918", "919", "920", "921", "922", "923", "924", "925", "926", "927", "928", "930", "931", "932", "933", "934", "935", "936", "937", "939", "940", "941", "943", "944", "945", "946", "947", "948", "949", "950", "951", "952", "953", "954"],
  },
  {
    id: "giant-eagle",
    name: "Giant Eagle",
    adPageUrl: "https://www.igroceryads.com/giant-eagle-weekly-sale-ad/",
    category: "giant-eagle-weekly-ad-sales-flyer",
    regions: ["ohio, pennsylvania, west virginia"],
    zip3s: ["430", "431", "432", "433", "434", "435", "436", "437", "438", "439", "440", "441", "442", "443", "444", "445", "446", "447", "448", "449", "150", "151", "152", "153", "154", "155", "156", "157", "158", "159", "160", "161", "162", "163", "164", "165", "166", "260", "261", "262", "263", "264", "265", "266", "267", "268"],
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

  // Extract image URLs from the page (WordPress wp-content/uploads pattern)
  const imgRegex = /https:\/\/www\.igroceryads\.com\/wp-content\/uploads\/\d{4}\/\d{2}\/[^"'\s)]+\.(?:webp|jpg|jpeg|png)/gi;
  const allImages = [...new Set(html.match(imgRegex) || [])];
  
  // Filter out thumbnails and duplicates
  let adPages = allImages
    .filter(url => !url.includes("-150x150"))
    .filter(url => !url.includes("-300x"))
    .filter(url => !url.includes("-100x"))
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
  
  return adPages.slice(0, 25); // cap at 25 pages
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

async function storeDealsBatch(storeName, storeId, allDeals, zip3s) {
  // Add metadata to each deal
  const enriched = allDeals.map((d, i) => ({
    ...d,
    id: `${storeId}-${Date.now()}-${i}`,
    storeName: storeName,
    source: "ad-extract",
    image: null,
  }));

  // Store for each zip3 in the store's region
  const cacheKey = `ad-extract:${storeId}`;
  
  // Store one master copy
  const { error } = await supabase.from("deal_cache").upsert({
    cache_key: cacheKey,
    data: enriched,
    fetched_at: new Date().toISOString(),
  }, { onConflict: "cache_key" });

  if (error) {
    console.error(`  ❌ Failed to cache deals for ${storeName}: ${error.message}`);
    return false;
  }

  // Also store with zip3 keys so regional endpoint can find them
  for (const zip3 of zip3s.slice(0, 10)) { // limit to first 10 zip3s to avoid too many writes
    const regionKey = `ad-extract:${storeId}:${zip3}`;
    await supabase.from("deal_cache").upsert({
      cache_key: regionKey,
      data: enriched,
      fetched_at: new Date().toISOString(),
    }, { onConflict: "cache_key" });
  }

  console.log(`  ✅ Stored ${enriched.length} deals for ${storeName} (${zip3s.length} regions)`);
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
    // Step 1: Get ad page image URLs
    const imageUrls = await fetchAdPageImages(store);
    if (imageUrls.length === 0) {
      console.log(`  ⚠ No ad images found for ${store.name}`);
      return { store: store.name, deals: 0, error: "No images found" };
    }

    // Step 2-3: Download each image and extract deals
    const allDeals = [];
    const maxPages = Math.min(imageUrls.length, 25); // cap at 25 pages
    
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

    // Deduplicate by name + price
    const seen = new Set();
    const unique = allDeals.filter(d => {
      const key = `${d.name}:${d.salePrice}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`\n  📊 ${store.name}: ${unique.length} unique deals from ${maxPages} pages`);

    // Step 4: Store in Supabase
    if (unique.length > 0) {
      await storeDealsBatch(store.name, store.id, unique, store.zip3s);
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
