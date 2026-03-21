/**
 * ALDI Website Redesign Monitor
 * 
 * Run this daily (or after March 24) to check if the scraper still works.
 * It tests the key assumptions the v2 scraper relies on and reports status.
 *
 * Run:  node aldi-monitor.js
 * 
 * What it checks:
 *   1. Can we fetch ALDI category pages?
 *   2. Does __NUXT_DATA__ still exist in the HTML?
 *   3. Can we still extract product names and prices?
 *   4. Has the data format changed?
 *   5. Are there new API endpoints we should use instead?
 */

const TEST_PAGES = [
  { url: "https://www.aldi.us/products/fresh-meat-seafood/fresh-beef/k/84", label: "Fresh Beef" },
  { url: "https://www.aldi.us/products/dairy-eggs/eggs/k/75", label: "Eggs" },
  { url: "https://www.aldi.us/products/featured/price-drops/k/280", label: "Price Drops" },
];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
};

// ── Color helpers for terminal output ──
const green = (t) => `\x1b[32m${t}\x1b[0m`;
const red = (t) => `\x1b[31m${t}\x1b[0m`;
const yellow = (t) => `\x1b[33m${t}\x1b[0m`;
const bold = (t) => `\x1b[1m${t}\x1b[0m`;

async function checkPage(page) {
  const result = {
    label: page.label,
    url: page.url,
    status: null,
    htmlSize: 0,
    hasNuxtData: false,
    nuxtDataSize: 0,
    productCount: 0,
    priceCount: 0,
    sampleProducts: [],
    samplePrices: [],
    warnings: [],
    newPatterns: [],
  };

  try {
    // ── Step 1: Fetch the page ──
    const res = await fetch(page.url, { headers: HEADERS });
    result.status = res.status;

    if (!res.ok) {
      result.warnings.push(`HTTP ${res.status} — page may have moved`);
      return result;
    }

    const html = await res.text();
    result.htmlSize = html.length;

    // ── Step 2: Check for __NUXT_DATA__ ──
    const nuxtMatch = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    result.hasNuxtData = !!nuxtMatch;

    if (!nuxtMatch) {
      result.warnings.push("__NUXT_DATA__ NOT FOUND — site structure has changed!");

      // Check for alternative data sources
      if (html.includes("__NUXT__")) {
        result.newPatterns.push("Found window.__NUXT__ (inline script)");
      }
      if (html.includes("_payload.json")) {
        result.newPatterns.push("Found _payload.json reference (Nuxt 3 payload extraction)");
      }
      if (html.includes("__NEXT_DATA__")) {
        result.newPatterns.push("Found __NEXT_DATA__ — site may have switched to Next.js!");
      }
      if (html.includes("application/json")) {
        const jsonScripts = html.match(/<script[^>]*type="application\/json"[^>]*>/g) || [];
        result.newPatterns.push(`Found ${jsonScripts.length} JSON script tags`);
        jsonScripts.slice(0, 3).forEach(tag => result.newPatterns.push(`  Tag: ${tag}`));
      }

      // Check for new API patterns in script tags
      const apiUrls = html.match(/https?:\/\/[^"'\s]*api[^"'\s]*/gi) || [];
      const uniqueApis = [...new Set(apiUrls)].filter(u => u.includes("aldi"));
      if (uniqueApis.length) {
        result.newPatterns.push("New API URLs found:");
        uniqueApis.slice(0, 5).forEach(u => result.newPatterns.push(`  ${u}`));
      }

      // Check for GraphQL
      if (html.includes("graphql") || html.includes("GraphQL")) {
        result.newPatterns.push("GraphQL detected — site may use GraphQL API now");
      }

      // Look for prices in the raw HTML anyway
      const rawPrices = [...html.matchAll(/\$(\d+\.\d{2})/g)].map(m => m[0]);
      if (rawPrices.length > 5) {
        result.newPatterns.push(`Found ${rawPrices.length} prices in raw HTML (data is present, just packaged differently)`);
      }

      return result;
    }

    // ── Step 3: Parse and extract products ──
    result.nuxtDataSize = nuxtMatch[1].length;

    let raw;
    try {
      raw = JSON.parse(nuxtMatch[1]);
    } catch (e) {
      result.warnings.push(`JSON parse failed: ${e.message}`);
      return result;
    }

    const strs = [];
    for (let i = 0; i < raw.length; i++) {
      if (typeof raw[i] === "string") strs.push({ val: raw[i], idx: i });
    }

    // Find prices
    const prices = strs.filter(s => /^\$\d+\.\d{2}$/.test(s.val) && s.val !== "$0.00");
    result.priceCount = prices.length;
    result.samplePrices = prices.slice(0, 5).map(p => p.val);

    // Find product names
    const products = strs.filter(s =>
      s.val.length > 8 && s.val.length < 150 &&
      /\d+\.?\d*\s*(lb|lbs|oz|fl oz|ct|count|pack|pk|each|gal|qt|pt)\b/i.test(s.val) &&
      !s.val.startsWith("http") && !s.val.startsWith("/") &&
      !s.val.includes(".jpg") && !s.val.includes("background") &&
      !s.val.includes("isolated") && !s.val.startsWith("avg.") &&
      !/^[a-z0-9-]+$/.test(s.val)
    );
    result.productCount = products.length;
    result.sampleProducts = products.slice(0, 5).map(p => p.val);

    // Find slugs
    const slugs = strs.filter(s =>
      s.val.length > 15 &&
      /^[a-z0-9][a-z0-9-]+[a-z0-9]$/.test(s.val) &&
      (s.val.includes("-lb") || s.val.includes("-oz") || s.val.includes("-ct")) &&
      !s.val.includes("subcat") && !s.val.includes("teaser")
    );

    // ── Step 4: Validate quality ──
    if (prices.length === 0) {
      result.warnings.push("No prices found in __NUXT_DATA__ — price format may have changed");
    }
    if (products.length === 0 && slugs.length === 0) {
      result.warnings.push("No product names or slugs found — data structure may have changed");
    }
    if (products.length > 0 && prices.length > 0 && slugs.length > 0) {
      // Check if pairing still works
      const testProduct = products[0];
      const nearbyPrice = prices.find(p => Math.abs(p.idx - testProduct.idx) < 35);
      if (!nearbyPrice) {
        result.warnings.push("Products and prices no longer appear near each other — pairing logic may need updating");
      }
    }

    // Check for new data patterns we might want to use
    const publishUrls = strs.filter(s => s.val.includes("publish.prod.amer"));
    if (publishUrls.length) {
      result.newPatterns.push(`CMS API still uses publish.prod.amer.cms.aldi.cx (${publishUrls.length} refs)`);
    }

    const newDomains = strs
      .filter(s => s.val.startsWith("https://") && !s.val.includes("aldi.us") && !s.val.includes("aldi.cx") && !s.val.includes("schema.org"))
      .map(s => { try { return new URL(s.val).hostname; } catch { return null; } })
      .filter(Boolean);
    const uniqueDomains = [...new Set(newDomains)];
    if (uniqueDomains.length) {
      result.newPatterns.push(`External domains referenced: ${uniqueDomains.join(", ")}`);
    }

  } catch (err) {
    result.warnings.push(`Fetch error: ${err.message}`);
  }

  return result;
}

async function main() {
  console.log(bold("\n🔍 ALDI Website Redesign Monitor"));
  console.log(bold("═".repeat(55)));
  console.log(`📅 Date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`);
  console.log(`⏰ Time: ${new Date().toLocaleTimeString("en-US")}`);

  const march24 = new Date("2026-03-24");
  const now = new Date();
  const daysUntil = Math.ceil((march24 - now) / (1000 * 60 * 60 * 24));
  if (daysUntil > 0) {
    console.log(yellow(`\n⏳ ${daysUntil} days until ALDI's redesign launch (March 24)`));
  } else if (daysUntil === 0) {
    console.log(red("\n🚨 TODAY IS LAUNCH DAY — March 24!"));
  } else {
    console.log(yellow(`\n📢 ALDI redesign launched ${Math.abs(daysUntil)} days ago`));
  }

  console.log("\nChecking pages...\n");

  let allGood = true;

  for (const page of TEST_PAGES) {
    const r = await checkPage(page);

    console.log(bold(`── ${r.label} ──`));
    console.log(`   URL: ${r.url}`);
    console.log(`   HTTP: ${r.status === 200 ? green("200 OK") : red(r.status)}`);
    console.log(`   HTML size: ${(r.htmlSize / 1024).toFixed(0)} KB`);

    if (r.hasNuxtData) {
      console.log(`   __NUXT_DATA__: ${green("✅ Found")} (${(r.nuxtDataSize / 1024).toFixed(0)} KB)`);
      console.log(`   Products: ${r.productCount > 0 ? green(r.productCount) : red("0")} found`);
      console.log(`   Prices: ${r.priceCount > 0 ? green(r.priceCount) : red("0")} found`);

      if (r.sampleProducts.length) {
        console.log(`   Sample: ${r.sampleProducts[0]} → ${r.samplePrices[0] || "no price"}`);
      }
    } else {
      console.log(`   __NUXT_DATA__: ${red("❌ NOT FOUND")}`);
      allGood = false;
    }

    if (r.warnings.length) {
      r.warnings.forEach(w => console.log(`   ${red("⚠️ " + w)}`));
      allGood = false;
    }

    if (r.newPatterns.length) {
      console.log(`   ${yellow("📡 New patterns detected:")}`);
      r.newPatterns.forEach(p => console.log(`      ${p}`));
    }

    console.log();
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Final verdict ──
  console.log(bold("═".repeat(55)));
  if (allGood) {
    console.log(green(bold("\n✅ ALL CHECKS PASSED — Aldi-v2.js scraper should work fine.")));
    console.log("   No action needed. Run 'node Aldi-v2.js' to scrape as usual.\n");
  } else {
    console.log(red(bold("\n⚠️ ISSUES DETECTED — the scraper may need updates.")));
    console.log("   Share the output above with Claude to get a fix.\n");
    console.log("   Quick steps:");
    console.log("   1. Copy this entire terminal output");
    console.log("   2. Paste it to Claude");
    console.log("   3. Say 'the ALDI monitor found issues, help me fix the scraper'\n");
  }
}

main().catch(console.error);
