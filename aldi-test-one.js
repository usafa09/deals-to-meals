/**
 * Quick test — fetch ONE category page and show what we extract
 * Run: node aldi-test-one.js
 */

const url = "https://www.aldi.us/products/fresh-meat-seafood/fresh-beef/k/84";

console.log("Testing ALDI page fetch...");
console.log("URL:", url, "\n");

try {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
    },
  });

  console.log("HTTP Status:", res.status);
  const html = await res.text();
  console.log("HTML size:", html.length, "chars");

  // ── Find __NUXT_DATA__ with flexible regex ──
  // Actual tag: <script id="__NUXT_DATA__" type="application/json" data-ssr="true">
  const nuxtMatch =
    html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) ||
    html.match(/<script[^>]*__NUXT_DATA__[^>]*>([\s\S]*?)<\/script>/);

  if (!nuxtMatch) {
    console.log("\nNo __NUXT_DATA__ tag found in server response.");
    console.log("Checking if the string exists at all...");
    const idx = html.indexOf("__NUXT_DATA__");
    if (idx > -1) {
      console.log("Found '__NUXT_DATA__' at position", idx);
      console.log("Context:", html.slice(idx - 30, idx + 200));
    } else {
      console.log("'__NUXT_DATA__' not present in HTML at all.");
      console.log("ALDI may serve different HTML to Node.js vs browsers.");
      console.log("\nChecking what IS in the HTML...");
      
      const prices = [...html.matchAll(/\$(\d+\.\d{2})/g)].map(m => m[0]);
      console.log("Prices found:", [...new Set(prices)].slice(0, 15));
      
      const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
      if (jsonLd) {
        console.log("\nJSON-LD blocks found:", jsonLd.length);
        jsonLd.forEach((block, i) => {
          const content = block.replace(/<\/?script[^>]*>/g, "");
          console.log("  Block " + (i+1) + ":", content.slice(0, 300));
        });
      }

      const bodyStart = html.indexOf("<body");
      if (bodyStart > -1) {
        console.log("\nFirst 1500 chars of body:");
        console.log(html.slice(bodyStart, bodyStart + 1500));
      }
    }
    process.exit(1);
  }

  console.log("Found __NUXT_DATA__:", nuxtMatch[1].length, "chars\n");

  const raw = JSON.parse(nuxtMatch[1]);
  console.log("Payload array length:", raw.length, "items");

  const indexed = [];
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] === "string") {
      indexed.push({ val: raw[i], idx: i });
    }
  }

  // ── Find prices ──
  const prices = indexed.filter(s => /^\$\d+\.\d{2}$/.test(s.val));
  console.log("\nPRICES (" + prices.length + " found):");
  console.log("  ", prices.slice(0, 20).map(p => p.val).join(", "));

  // ── Find product names (contain size units) ──
  const productNames = indexed.filter(s =>
    s.val.length > 8 &&
    s.val.length < 150 &&
    /\d+\.?\d*\s*(lb|lbs|oz|fl oz|ct|count|pack|pk|each|gal|qt|pt)\b/i.test(s.val) &&
    !s.val.startsWith("http") &&
    !s.val.startsWith("/") &&
    !s.val.includes(".jpg") &&
    !s.val.includes(".png") &&
    !s.val.includes("teaser") &&
    !s.val.includes("background") &&
    !s.val.includes("isolated") &&
    !/^[a-z0-9-]+$/.test(s.val)
  );
  console.log("\nPRODUCT NAMES (" + productNames.length + " found):");
  productNames.forEach(p => console.log("  *", p.val, "(index:" + p.idx + ")"));

  // ── Find slugs ──
  const slugs = indexed.filter(s =>
    s.val.length > 15 &&
    /^[a-z0-9][a-z0-9-]+[a-z0-9]$/.test(s.val) &&
    (s.val.includes("-lb") || s.val.includes("-oz") || s.val.includes("-ct") ||
     s.val.includes("-pack") || s.val.includes("-fl-oz") || s.val.includes("-gal")) &&
    !s.val.includes("subcat") && !s.val.includes("teaser")
  );
  console.log("\nSLUGS (" + slugs.length + " found):");
  slugs.forEach(s => console.log("  *", s.val, "(index:" + s.idx + ")"));

  // ── Pair products with prices ──
  console.log("\n=== PRODUCT + PRICE PAIRING ===");
  for (const name of productNames) {
    let closestPrice = null;
    let closestDist = Infinity;
    for (const p of prices) {
      const dist = Math.abs(p.idx - name.idx);
      if (dist < closestDist && dist < 30) {
        closestDist = dist;
        closestPrice = p;
      }
    }
    
    const slug = slugs.find(s => s.idx > name.idx && s.idx < name.idx + 10);
    
    console.log("  " + (closestPrice?.val || "no price").padEnd(8) + " | " + name.val + (slug ? " -> " + slug.val : ""));
  }

  console.log("\n" + "=".repeat(50));
  if (productNames.length > 0 && prices.length > 0) {
    console.log("SUCCESS! Found " + productNames.length + " products and " + prices.length + " prices.");
    console.log("The v2 scraper should work. Run: node Aldi-v2.js --dry-run");
  } else {
    console.log("Issue: products=" + productNames.length + " prices=" + prices.length);
    console.log("Share this output with Claude to debug further.");
  }

} catch (err) {
  console.error("Fetch error:", err.message);
}
