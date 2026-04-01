import { Router } from "express";
import fetch from "node-fetch";
import {
  supabase, validateZip, validateStoreName,
  getAdRegions, summarizeRegions, geocodeZip,
  getCachedDeals, setCachedDeals, getCachedStores, setCachedStores,
  getCategoryImage, findIgroceryadsUrl, extractingStores,
  storesWithDealsCache, GOOGLE_MAPS_KEY, DEAL_CACHE_TTL,
} from "../lib/utils.js";
import { fetchKrogerDeals } from "./kroger.js";
import { fetchWalmartDeals } from "./walmart.js";

const router = Router();

// ══ NEARBY GROCERY STORES (Google Places API with 30-day cache) ═══════════════

router.get("/api/nearby-stores", async (req, res) => {
  const { zip, radius: radiusMiles } = req.query;
  if (!validateZip(zip)) return res.status(400).json({ error: "Valid 5-digit zip is required" });
  const miles = parseInt(radiusMiles) || 10;
  const radiusMeters = Math.min(miles * 1609, 48000);
  const cacheKey = `nearby-stores:${zip}:${miles}mi`;

  try {
    const cached = await getCachedStores(zip, cacheKey);
    if (cached) {
      const filtered = cached.filter(s => s.hasDeals || s.canExtract || findIgroceryadsUrl(s.name) || s.name === "Kroger" || s.name === "ALDI" || s.name === "Walmart");
      console.log(`Nearby stores for ${zip} (${miles}mi): ${filtered.length} stores [cached]`);
      return res.json({ stores: filtered, cached: true });
    }

    if (!GOOGLE_MAPS_KEY) {
      console.log("Google Maps API key not configured, falling back to ad_regions");
      return res.json({ stores: [], error: "Google Maps API key not configured" });
    }

    const location = await geocodeZip(zip);
    if (!location) return res.status(400).json({ error: "Could not geocode zip code" });

    const searches = [
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location.lat},${location.lng}&radius=${radiusMeters}&type=supermarket&key=${GOOGLE_MAPS_KEY}`,
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location.lat},${location.lng}&radius=${radiusMeters}&keyword=grocery+store&key=${GOOGLE_MAPS_KEY}`,
    ];
    const allPlaces = [];
    const seenIds = new Set();
    for (const url of searches) {
      let nextUrl = url;
      let pages = 0;
      while (nextUrl && pages < 2) {
        const placesRes = await fetch(nextUrl);
        const placesData = await placesRes.json();
        if (placesData.status === "OK" && placesData.results) {
          for (const p of placesData.results) {
            if (!seenIds.has(p.place_id)) {
              seenIds.add(p.place_id);
              allPlaces.push(p);
            }
          }
        }
        if (placesData.next_page_token) {
          await new Promise(r => setTimeout(r, 2000));
          nextUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?pagetoken=${placesData.next_page_token}&key=${GOOGLE_MAPS_KEY}`;
        } else {
          nextUrl = null;
        }
        pages++;
      }
    }

    const brandMap = new Map();
    for (const place of allPlaces) {
      const name = place.name || "";
      let brand = name;
      const lower = name.toLowerCase();
      if (lower.includes("kroger")) brand = "Kroger";
      else if (lower.includes("aldi")) brand = "ALDI";
      else if (lower.includes("walmart")) brand = "Walmart";
      else if (lower.includes("meijer")) brand = "Meijer";
      else if (lower.includes("publix")) brand = "Publix";
      else if (lower.includes("giant eagle")) brand = "Giant Eagle";
      else if (lower.includes("food lion")) brand = "Food Lion";
      else if (lower.includes("hy-vee") || lower.includes("hyvee")) brand = "Hy-Vee";
      else if (lower.includes("sprouts")) brand = "Sprouts";
      else if (lower.includes("target")) brand = "Target";
      else if (lower.includes("costco")) brand = "Costco";
      else if (lower.includes("trader joe")) brand = "Trader Joe's";
      else if (lower.includes("save a lot") || lower.includes("save-a-lot")) brand = "Save-A-Lot";
      else if (lower.includes("dollar general")) brand = "Dollar General";
      else if (lower.includes("albertsons")) brand = "Albertsons";
      else if (lower.includes("safeway")) brand = "Safeway";
      else if (lower.includes("harris teeter")) brand = "Harris Teeter";
      else if (lower.includes("h-e-b") || lower === "heb") brand = "H-E-B";
      else if (lower.includes("wegman")) brand = "Wegmans";
      else if (lower.includes("shoprite")) brand = "ShopRite";
      else if (lower.includes("winn-dixie") || lower.includes("winn dixie")) brand = "Winn-Dixie";
      else if (lower.includes("lidl")) brand = "Lidl";
      else if (lower.includes("piggly wiggly")) brand = "Piggly Wiggly";
      else if (lower.includes("marc's") || lower.includes("marcs")) brand = "Marc's";
      else if (lower.includes("winco")) brand = "WinCo";
      else if (lower.includes("food city")) brand = "Food City";
      else if (lower.includes("ingles")) brand = "Ingles";
      else if (lower.includes("fred meyer")) brand = "Kroger";
      else if (lower.includes("king soopers")) brand = "Kroger";
      else if (lower.includes("ralphs")) brand = "Kroger";
      else if (lower.includes("fry's food")) brand = "Kroger";
      else if (lower.includes("smith's food") || lower.includes("smiths food")) brand = "Kroger";
      else if (lower.includes("qfc")) brand = "Kroger";
      else if (lower.includes("dillons")) brand = "Kroger";
      else if (lower.includes("pick n save") || lower.includes("pick 'n save")) brand = "Kroger";
      else if (lower.includes("mariano")) brand = "Kroger";

      if (!brandMap.has(brand)) {
        brandMap.set(brand, {
          name: brand,
          address: place.vicinity || "",
          lat: place.geometry?.location?.lat,
          lng: place.geometry?.location?.lng,
          count: 0,
        });
      }
      brandMap.get(brand).count++;
    }

    const stores = [...brandMap.values()].sort((a, b) => a.name.localeCompare(b.name));

    // Use in-memory storesWithDealsCache instead of querying Supabase
    const normalizeName = (n) => n.toLowerCase().replace(/['\s-]/g, "");
    const enrichedStores = stores
      .map(s => ({
        ...s,
        hasDeals: storesWithDealsCache.has(normalizeName(s.name))
          || s.name === "Kroger" || s.name === "ALDI" || s.name === "Walmart",
        canExtract: !!findIgroceryadsUrl(s.name) || s.name === "Kroger" || s.name === "ALDI" || s.name === "Walmart",
      }))
      .filter(s => s.hasDeals || s.canExtract);

    const existingNames = new Set(enrichedStores.map(s => s.name));
    const alwaysInclude = [
      { name: "Walmart", count: 1, address: "Nearby", hasDeals: true, canExtract: true, lat: location.lat, lng: location.lng },
      { name: "Kroger", count: 1, address: "Nearby", hasDeals: true, canExtract: true, lat: location.lat, lng: location.lng },
      { name: "ALDI", count: 1, address: "Nearby", hasDeals: true, canExtract: true, lat: location.lat, lng: location.lng },
    ];
    for (const s of alwaysInclude) {
      if (!existingNames.has(s.name)) enrichedStores.push(s);
    }

    await setCachedStores(zip, enrichedStores, cacheKey);
    console.log(`Nearby stores for ${zip} (${miles}mi): ${enrichedStores.length} brands (${enrichedStores.filter(s=>s.hasDeals).length} with deals) from ${allPlaces.length} places [live]`);

    res.json({ stores: enrichedStores, cached: false });
  } catch (err) {
    console.error("Nearby stores error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══ AD REGIONS ═══════════════════════════════════════════════════════════════

router.get("/api/ad-regions", async (req, res) => {
  const { zip } = req.query;
  if (!validateZip(zip)) return res.status(400).json({ error: "Valid 5-digit zip is required" });
  try {
    const zip3 = zip.substring(0, 3);
    const regions = await getAdRegions(zip);
    const summary = summarizeRegions(regions);

    // Use in-memory storesWithDealsCache instead of querying Supabase
    const enriched = summary.map(s => ({
      ...s,
      hasDeals: storesWithDealsCache.has(s.store) || s.store === "kroger" || s.store === "aldi",
    }));

    console.log(`Ad regions for zip ${zip} (${zip3}): ${summary.length} chains, ${enriched.filter(s => s.hasDeals).length} with deals`);
    res.json({ zip3, stores: enriched, count: enriched.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ REGIONAL DEALS ═══════════════════════════════════════════════════════════

router.get("/api/deals/regional", async (req, res) => {
  const { zip, locationId } = req.query;
  if (!validateZip(zip)) return res.status(400).json({ error: "Valid 5-digit zip is required" });

  try {
    const zip3 = zip.substring(0, 3);
    const regions = await getAdRegions(zip);
    const summary = summarizeRegions(regions);
    console.log(`\n═══ Regional deals for ${zip} (${zip3}) — ${summary.length} chains ═══`);

    const results = { kroger: null, aldi: null, walmart: null, sources: [] };
    const fetchPromises = [];

    const krogerRegion = summary.find(s => s.store === "kroger");
    if (krogerRegion && locationId) {
      fetchPromises.push((async () => {
        const cacheKey = `kroger:${locationId}`;
        const cached = await getCachedDeals(cacheKey);
        if (cached) {
          results.kroger = cached;
          results.sources.push({ store: "kroger", banner: krogerRegion.banner, division: krogerRegion.division, deals: cached.length, cached: true });
          console.log(`  Kroger ${krogerRegion.banner} (${krogerRegion.division}): ${cached.length} deals [cached]`);
        } else {
          try {
            const unique = await fetchKrogerDeals(locationId, krogerRegion.banner);
            await setCachedDeals(cacheKey, unique);
            results.kroger = unique;
            results.sources.push({ store: "kroger", banner: krogerRegion.banner, division: krogerRegion.division, deals: unique.length, cached: false });
            console.log(`  Kroger ${krogerRegion.banner} (${krogerRegion.division}): ${unique.length} deals [live]`);
          } catch (e) {
            console.error(`  Kroger fetch error: ${e.message}`);
            results.sources.push({ store: "kroger", banner: krogerRegion.banner, deals: 0, error: e.message });
          }
        }
      })());
    }

    // ALDI is national — always fetch regardless of ad_regions
    fetchPromises.push((async () => {
      // Try cache first
      const cacheKey = "aldi:national";
      const cached = await getCachedDeals(cacheKey);
      if (cached && cached.length > 0) {
        results.aldi = cached;
        results.sources.push({ store: "aldi", banner: "ALDI", division: "National", deals: cached.length, cached: true });
        console.log(`  ALDI National: ${cached.length} deals [cached]`);
        return;
      }
      // Try aldi_deals table directly
      try {
        const { data: aldiData } = await supabase.from("aldi_deals").select("*").order("name").limit(500);
        if (aldiData && aldiData.length > 0) {
          const deals = aldiData.map(d => ({
            id: String(d.id), upc: "", name: d.name, brand: d.brand || "", category: d.category || "ALDI",
            regularPrice: d.regular_price || "", salePrice: d.price, savings: d.savings || "",
            pctOff: (() => { const s=parseFloat(d.price?.replace(/[^0-9.]/g,"")); const r=parseFloat(d.regular_price?.replace(/[^0-9.]/g,"")); return s&&r&&r>s?Math.round(((r-s)/r)*100):0; })(),
            size: "", image: d.image || null, source: "aldi", storeName: "ALDI",
          }));
          await setCachedDeals(cacheKey, deals);
          results.aldi = deals;
          results.sources.push({ store: "aldi", banner: "ALDI", division: "National", deals: deals.length, cached: false });
          console.log(`  ALDI National: ${deals.length} deals [table]`);
          return;
        }
      } catch (e) { console.error("ALDI table query error:", e.message); }
      // Fall back to ad-extracted ALDI deals
      const adCached = await getCachedDeals("ad-extract:aldi");
      if (adCached && adCached.length > 0) {
        results.aldi = adCached;
        results.sources.push({ store: "aldi", banner: "ALDI", division: "National", deals: adCached.length, cached: true });
        console.log(`  ALDI National: ${adCached.length} deals [ad-extract]`);
      } else {
        results.sources.push({ store: "aldi", banner: "ALDI", division: "National", deals: 0, note: "No deals available" });
        console.log(`  ALDI National: no deals`);
      }
    })());

    // ── Walmart: national rollback deals, cache as walmart:national ──
    fetchPromises.push((async () => {
      const cacheKey = "walmart:national";
      const cached = await getCachedDeals(cacheKey);
      if (cached) {
        results.walmart = cached;
        results.sources.push({ store: "walmart", banner: "Walmart", division: "National", deals: cached.length, cached: true });
        console.log(`  Walmart National: ${cached.length} deals [cached]`);
      } else {
        try {
          const deals = await fetchWalmartDeals();
          if (deals.length > 0) {
            await setCachedDeals(cacheKey, deals);
          }
          results.walmart = deals;
          results.sources.push({ store: "walmart", banner: "Walmart", division: "National", deals: deals.length, cached: false });
          console.log(`  Walmart National: ${deals.length} deals [live]`);
        } catch (e) {
          console.error(`  Walmart fetch error: ${e.message}`);
          results.sources.push({ store: "walmart", banner: "Walmart", deals: 0, error: e.message });
        }
      }
    })());

    await Promise.all(fetchPromises);

    let adExtractDeals = [];
    try {
      const { data: zip3Data } = await supabase.from("deal_cache").select("data, cache_key").like("cache_key", `ad-extract:%:${zip3}`);
      const zip3StoreIds = new Set();
      if (zip3Data) {
        for (const row of zip3Data) {
          if (row.data) {
            adExtractDeals.push(...row.data);
            const parts = row.cache_key.split(":");
            if (parts[1]) zip3StoreIds.add(parts[1]);
          }
        }
      }
      const { data: masterData } = await supabase
        .from("deal_cache")
        .select("data, cache_key")
        .like("cache_key", "ad-extract:%")
        .not("cache_key", "like", "ad-extract:%:%");
      if (masterData) {
        for (const row of masterData) {
          const storeId = row.cache_key.split(":")[1];
          if (!zip3StoreIds.has(storeId) && row.data) {
            adExtractDeals.push(...row.data);
          }
        }
      }
      if (adExtractDeals.length > 0) {
        adExtractDeals = adExtractDeals.map(d => d.image ? d : { ...d, image: getCategoryImage(d.category) });
        results.sources.push({ store: "ad-extract", deals: adExtractDeals.length, cached: true });
        console.log(`  Ad-extracted deals: ${adExtractDeals.length} deals`);
      }
    } catch (e) {
      console.log(`  No ad-extracted deals found`);
    }

    const allDeals = [
      ...(results.kroger || []),
      ...(results.aldi || []),
      ...(results.walmart || []),
      ...adExtractDeals,
    ];

    console.log(`═══ Total: ${allDeals.length} deals from ${results.sources.length} sources ═══\n`);

    res.json({
      zip3,
      totalDeals: allDeals.length,
      deals: allDeals,
      sources: results.sources,
      availableChains: summary.map(s => s.banner),
    });
  } catch (err) {
    console.error("Regional deals error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══ ON-DEMAND AD EXTRACTION ═══════════════════════════════════════════════════

router.post("/api/extract-store", async (req, res) => {
  const { storeName } = req.body;
  if (!validateStoreName(storeName)) return res.status(400).json({ error: "Valid storeName is required (letters, numbers, spaces, hyphens, max 50 chars)" });

  const storeId = storeName.toLowerCase().replace(/['\s]+/g, "-").replace(/--+/g, "-");

  const existing = await getCachedDeals(`ad-extract:${storeId}`);
  if (existing && existing.length >= 10) {
    return res.json({ status: "ready", deals: existing.length, storeId });
  }

  if (extractingStores.has(storeId)) {
    return res.json({ status: "extracting", message: "Deal extraction in progress" });
  }

  const adUrl = findIgroceryadsUrl(storeName);
  if (!adUrl) {
    return res.json({ status: "not-found", message: "No ad source found for this store. Upload a photo of their weekly ad to add deals." });
  }

  extractingStores.add(storeId);
  res.json({ status: "extracting", message: `Found ${storeName} ad — extracting deals now. This takes about 2-3 minutes.` });

  try {
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) { extractingStores.delete(storeId); return; }

    const pageRes = await fetch(adUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    const html = await pageRes.text();

    const isLadySavings = adUrl.includes("ladysavings.com");
    let images = [];

    if (isLadySavings) {
      const hcwRegex = /https:\/\/www\.hotcouponworld\.com\/wp-content\/uploads\/\d{4}\/\d{2}\/[^"'\s)]+\.(?:jpg|jpeg|png|webp)/gi;
      const firstPageImages = (html.match(hcwRegex) || []).filter(url => !url.includes("-150x150") && !url.includes("-300x") && !url.includes("_header"));
      if (firstPageImages.length > 0) images.push(firstPageImages[0]);

      const pageMatch = html.match(/1\s+of\s+(\d+)/);
      const totalPages = pageMatch ? parseInt(pageMatch[1]) : 1;
      console.log(`On-demand: ${storeName} — ladysavings paginated, ${totalPages} pages`);

      for (let p = 2; p <= Math.min(totalPages, 20); p++) {
        try {
          await new Promise(r => setTimeout(r, 500));
          const pRes = await fetch(`${adUrl}${p}/`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
          });
          const pHtml = await pRes.text();
          const pImages = (pHtml.match(hcwRegex) || []).filter(url => !url.includes("-150x150") && !url.includes("-300x") && !url.includes("_header"));
          if (pImages.length > 0) images.push(pImages[0]);
        } catch (e) { console.error(`LadySavings page ${p} fetch error:`, e.message); }
      }
    } else {
      const imgRegex = /https:\/\/www\.(?:igroceryads|iweeklyads)\.com\/wp-content\/uploads\/\d{4}\/\d{2}\/[^"'\s)]+\.(?:webp|jpg|jpeg|png)/gi;
      images = [...new Set(html.match(imgRegex) || [])]
        .filter(url => !url.includes("-150x150") && !url.includes("-300x") && !url.includes("-100x") && !url.includes("-200x200"))
        .sort((a, b) => {
          const extractNum = (url) => {
            const fname = url.split("/").pop();
            const m = fname.match(/page_(\d+)/) || fname.match(/img(\d+)/) || fname.match(/-(\d+)-scaled/) || fname.match(/-(\d+)\./);
            return parseInt(m?.[1] || "0");
          };
          return extractNum(a) - extractNum(b);
        });
      images = [...new Set(images)];

      if (images.length <= 3 && images.length > 0) {
        const sample = images[0];
        const scaledMatch = sample.match(/^(.*-)(\d+)(-scaled\.\w+)$/);
        if (scaledMatch) {
          const [, prefix, , suffix] = scaledMatch;
          for (let n = 1; n <= 30; n++) {
            const url = `${prefix}${n}${suffix}`;
            if (!images.includes(url)) {
              try {
                const probe = await fetch(url, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } });
                if (probe.ok && (probe.headers.get("content-type") || "").startsWith("image/")) {
                  images.push(url);
                } else break;
              } catch { break; }
            }
          }
        }
      }
    }

    console.log(`On-demand extraction for ${storeName}: ${images.length} pages found`);

    const allDeals = [];
    const maxPages = Math.min(images.length, 20);
    for (let i = 0; i < maxPages; i++) {
      try {
        const imgRes = await fetch(images[i], {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        if (!imgRes.ok) continue;
        const contentType = imgRes.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) continue;
        const buffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        if (base64.length < 1000) continue;

        const mediaType = images[i].endsWith(".webp") ? "image/webp" : images[i].endsWith(".png") ? "image/png" : "image/jpeg";

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
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
                { type: "text", text: `Extract grocery deals from this ${storeName} weekly ad image. Return ONLY a valid JSON array. For each item: {"name":"","brand":"","salePrice":"","unit":"","regularPrice":"","dealType":"sale/bogo/percent_off","category":"meat/produce/dairy/bakery/frozen/pantry/snacks/beverages/deli/seafood/household/other","size":"","notes":""}. No markdown. Include all items with prices.` }
              ]
            }]
          })
        });
        const aiData = await aiRes.json();
        const text = aiData.content?.map(c => c.text || "").join("") || "";
        let cleaned = text.replace(/```json|```/g, "").trim();
        try {
          const deals = JSON.parse(cleaned);
          deals.forEach(d => { d.adImage = images[i]; d.adPage = i + 1; });
          allDeals.push(...deals);
        } catch (e) {
          console.error(`OCR page ${i+1} JSON parse error:`, e.message);
          const lastBrace = cleaned.lastIndexOf("}");
          if (lastBrace > 0) {
            try {
              const recovered = JSON.parse(cleaned.substring(0, lastBrace + 1) + "]");
              recovered.forEach(d => { d.adImage = images[i]; d.adPage = i + 1; });
              allDeals.push(...recovered);
            } catch (e2) { console.error(`OCR page ${i+1} recovery parse error:`, e2.message); }
          }
        }
        if (i < maxPages - 1) await new Promise(r => setTimeout(r, 500));
      } catch (e) { console.error(`  Page ${i+1} error: ${e.message}`); }
    }

    const seen = new Set();
    let unique = allDeals.filter(d => {
      const key = `${d.name}:${d.salePrice}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (unique.length < 10) {
      console.log(`  Only ${unique.length} deals from images — trying text extraction fallback...`);
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
          const textAiRes = await fetch("https://api.anthropic.com/v1/messages", {
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
                content: `Extract grocery deals from this ${storeName} weekly ad text. The text was scraped from a weekly ad page.

TEXT:
${textContent}

Return ONLY a valid JSON array of deals. For each item with a price mentioned:
{"name":"","brand":"","salePrice":"","unit":"","regularPrice":"","dealType":"sale/bogo/percent_off","category":"meat/produce/dairy/bakery/frozen/pantry/snacks/beverages/deli/seafood/household/other","size":"","notes":""}

Rules:
- Only include items that have a clear price
- For "2/$5" deals, set salePrice to "2.50" and notes to "2 for $5"
- For per-lb prices like "$3.99 lb", set unit to "/lb"
- No markdown backticks, return ONLY the JSON array
- If no deals found, return []`
              }]
            })
          });
          const textAiData = await textAiRes.json();
          const textResult = textAiData.content?.map(c => c.text || "").join("") || "";
          let textCleaned = textResult.replace(/```json|```/g, "").trim();
          try {
            const textDeals = JSON.parse(textCleaned);
            if (textDeals.length > unique.length) {
              console.log(`  Text fallback found ${textDeals.length} deals (vs ${unique.length} from images)`);
              const textSeen = new Set();
              unique = textDeals.filter(d => {
                const key = `${d.name}:${d.salePrice}`;
                if (textSeen.has(key)) return false;
                textSeen.add(key);
                return true;
              });
            }
          } catch (e) {
            console.error("Text fallback JSON parse error:", e.message);
            const lastBrace = textCleaned.lastIndexOf("}");
            if (lastBrace > 0) {
              try {
                const recovered = JSON.parse(textCleaned.substring(0, lastBrace + 1) + "]");
                if (recovered.length > unique.length) {
                  console.log(`  Text fallback found ${recovered.length} deals (recovered)`);
                  unique = recovered;
                }
              } catch (e2) { console.error("Text fallback recovery parse error:", e2.message); }
            }
          }
        }
      } catch (e) {
        console.error(`  Text fallback error: ${e.message}`);
      }
    }

    unique = unique.map((d, i) => ({
      ...d,
      id: `${storeId}-${Date.now()}-${i}`,
      storeName,
      source: "ad-extract",
      image: getCategoryImage(d.category),
      adSourceUrl: adUrl,
    }));

    if (unique.length > 0) {
      await setCachedDeals(`ad-extract:${storeId}`, unique);
      console.log(`On-demand: ${storeName} — ${unique.length} deals cached`);
    } else {
      console.log(`On-demand: ${storeName} — no deals extracted`);
    }
  } catch (err) {
    console.error(`On-demand extraction error for ${storeName}:`, err.message);
  } finally {
    extractingStores.delete(storeId);
  }
});

router.get("/api/extract-status", async (req, res) => {
  const { store } = req.query;
  if (!validateStoreName(store)) return res.status(400).json({ error: "Valid store name is required" });
  const storeId = store.toLowerCase().replace(/['\s]+/g, "-").replace(/--+/g, "-");

  if (extractingStores.has(storeId)) {
    return res.json({ status: "extracting" });
  }
  const cached = await getCachedDeals(`ad-extract:${storeId}`);
  if (cached && cached.length > 0) {
    return res.json({ status: "ready", deals: cached.length });
  }
  res.json({ status: "none" });
});

export default router;
