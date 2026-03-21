/**
 * Albertsons Scraper — Test Script
 * 
 * Tests whether Albertsons serves product data in server-rendered HTML
 * or if we need to use their authenticated API.
 *
 * Run: node albertsons-test.js
 */

const STORE_ID = "177"; // Boise, ID — change to your local store
const BASE = "https://www.albertsons.com";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
};

async function testApproach1_HTML() {
  console.log("=== APPROACH 1: Fetch category page HTML ===");
  const url = `${BASE}/shop/aisles/meat-seafood.html?loc=${STORE_ID}`;
  console.log("URL:", url);
  
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  console.log("Status:", res.status);
  const html = await res.text();
  console.log("HTML size:", html.length);
  
  // Check for product data in HTML
  const prices = [...html.matchAll(/\$(\d+\.\d{2})/g)].map(m => m[0]);
  const uniquePrices = [...new Set(prices)];
  console.log("Prices found:", uniquePrices.length, uniquePrices.slice(0, 10));
  
  const productIds = [...html.matchAll(/data-bpn="(\d+)"/g)].map(m => m[1]);
  console.log("Product IDs (data-bpn):", productIds.length, productIds.slice(0, 5));
  
  const names = [...html.matchAll(/alt="([^"]+(?:Oz|Lb|oz|lb|ct|Count|Pack)[^"]*)"/gi)].map(m => m[1]);
  console.log("Product names (from alt):", names.length);
  names.slice(0, 5).forEach(n => console.log("  *", n));
  
  const ariaNames = [...html.matchAll(/aria-label="([^"]+(?:Oz|Lb|oz|lb|ct|Count|Pack)[^"]*),/gi)].map(m => m[1]);
  console.log("Product names (from aria-label):", ariaNames.length);
  ariaNames.slice(0, 5).forEach(n => console.log("  *", n));

  return { prices: uniquePrices.length, products: productIds.length, names: names.length };
}

async function testApproach2_ProductPage() {
  console.log("\n=== APPROACH 2: Fetch individual product page ===");
  const url = `${BASE}/shop/product-details.971273851.html`;
  console.log("URL:", url);
  
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  console.log("Status:", res.status);
  const html = await res.text();
  console.log("HTML size:", html.length);
  
  const prices = [...html.matchAll(/\$(\d+\.\d{2})/g)].map(m => m[0]);
  console.log("Prices:", [...new Set(prices)]);
  
  const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  if (jsonLd) {
    jsonLd.forEach((block, i) => {
      const content = block.replace(/<\/?script[^>]*>/g, "");
      if (content.includes("price") || content.includes("Product")) {
        console.log("JSON-LD product data found!");
        console.log(content.slice(0, 500));
      }
    });
  }
}

async function testApproach3_XAPI() {
  console.log("\n=== APPROACH 3: Direct XAPI call (may need auth) ===");
  
  // Try the search endpoint
  const searchUrl = `${BASE}/abs/pub/xapi/wcax/pathway/search?rows=30&start=0&storeid=${STORE_ID}&channel=instore&facet=false&url=https://www.albertsons.com&banner=albertsons&q=chicken`;
  console.log("URL:", searchUrl.slice(0, 120));
  
  try {
    const res = await fetch(searchUrl, { headers: HEADERS });
    console.log("Status:", res.status);
    if (res.ok) {
      const data = await res.text();
      console.log("Response size:", data.length);
      console.log("Preview:", data.slice(0, 500));
    } else {
      console.log("Auth required — need to use HTML parsing approach");
    }
  } catch (e) {
    console.log("Error:", e.message);
  }

  // Try the preload endpoint (this one worked without auth)
  const preloadUrl = `${BASE}/abs/pub/xapi/preload/webpreload/storeflags/${STORE_ID}?zipcode=83713`;
  console.log("\nPreload URL:", preloadUrl);
  try {
    const res = await fetch(preloadUrl, { headers: HEADERS });
    console.log("Status:", res.status);
    if (res.ok) {
      const data = await res.text();
      console.log("Preload response:", data.slice(0, 300));
    }
  } catch(e) {
    console.log("Error:", e.message);
  }
}

async function testApproach4_Search() {
  console.log("\n=== APPROACH 4: Search page ===");
  const url = `${BASE}/shop/search-results.html?q=chicken&loc=${STORE_ID}`;
  console.log("URL:", url);
  
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  console.log("Status:", res.status);
  const html = await res.text();
  console.log("HTML size:", html.length);
  
  const prices = [...html.matchAll(/\$(\d+\.\d{2})/g)].map(m => m[0]);
  console.log("Prices found:", [...new Set(prices)].length);
  
  const productIds = [...html.matchAll(/data-bpn="(\d+)"/g)].map(m => m[1]);
  console.log("Product IDs:", productIds.length);
  
  const names = [...html.matchAll(/alt="([^"]{10,80})"/g)].map(m => m[1]).filter(n => !n.includes("logo") && !n.includes("icon"));
  console.log("Image alt names:", names.length);
  names.slice(0, 5).forEach(n => console.log("  *", n));
}

async function main() {
  console.log("Albertsons Scraper — Testing Data Access\n");
  console.log("Store ID:", STORE_ID, "\n");
  
  const r1 = await testApproach1_HTML();
  await testApproach2_ProductPage();
  await testApproach3_XAPI();
  await testApproach4_Search();

  console.log("\n" + "=".repeat(50));
  console.log("RESULTS SUMMARY:");
  if (r1.products > 0) {
    console.log("✅ HTML approach works! Products found in server-rendered HTML.");
    console.log("   Next step: Build full scraper using HTML parsing.");
  } else {
    console.log("⚠️ Products NOT in server-rendered HTML.");
    console.log("   Albertsons loads products via authenticated API calls.");
    console.log("   Options: Use Playwright, or authenticate via Okta.");
  }
}

main().catch(console.error);
