import { Router } from "express";
import fetch from "node-fetch";
import {
  supabase, validateZip, validateStoreName, isKrogerFamilyBrand,
  getAdRegions, summarizeRegions, geocodeZip,
  getCachedDeals, setCachedDeals, getCachedStores, setCachedStores,
  getCategoryImage, findIgroceryadsUrl, canonicalizeStoreId, extractingStores,
  storesWithDealsCache, logSearch, logApiUsage, logError, GOOGLE_MAPS_KEY, DEAL_CACHE_TTL,
} from "../lib/utils.js";
import { fetchKrogerDeals } from "./kroger.js";
import { fetchWalmartDeals } from "./walmart.js";
import { notifyStoreRequest } from "../lib/email.js";

const router = Router();

// ══ NEARBY GROCERY STORES (Google Places API with 30-day cache) ═══════════════

router.get("/api/nearby-stores", async (req, res) => {
  const { zip, radius: radiusMiles } = req.query;
  if (!validateZip(zip)) return res.status(400).json({ error: "Valid 5-digit zip is required" });
  const miles = parseInt(radiusMiles) || 10;
  const radiusMeters = Math.min(miles * 1609, 48000);
  // v2 cache key: invalidates pre-fix entries that contained phantom Walmart/Kroger/ALDI
  // entries injected unconditionally regardless of proximity.
  const cacheKey = `nearby-stores:v2:${zip}:${miles}mi`;

  try {
    const cached = await getCachedStores(zip, cacheKey);
    if (cached) {
      const filtered = cached.filter(s => s.hasDeals || s.canExtract || findIgroceryadsUrl(s.name));
      console.log(`Nearby stores for ${zip} (${miles}mi): ${filtered.length} stores [cached]`);
      logSearch(zip, filtered.length, 0);
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
      else if (lower.includes("fred meyer")) brand = "Fred Meyer";
      else if (lower.includes("king soopers")) brand = "King Soopers";
      else if (lower.includes("ralphs")) brand = "Ralphs";
      else if (lower.includes("fry's food") || lower.includes("frys food")) brand = "Fry's";
      else if (lower.includes("smith's food") || lower.includes("smiths food")) brand = "Smith's";
      else if (lower.includes("qfc")) brand = "QFC";
      else if (lower.includes("dillons")) brand = "Dillons";
      else if (lower.includes("pick n save") || lower.includes("pick 'n save")) brand = "Pick 'n Save";
      else if (lower.includes("mariano")) brand = "Mariano's";

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
          || isKrogerFamilyBrand(s.name) || s.name === "ALDI" || s.name === "Walmart",
        canExtract: !!findIgroceryadsUrl(s.name) || isKrogerFamilyBrand(s.name) || s.name === "ALDI" || s.name === "Walmart",
        krogerFamily: isKrogerFamilyBrand(s.name),
      }))
      .filter(s => s.hasDeals || s.canExtract);

    await setCachedStores(zip, enrichedStores, cacheKey);
    console.log(`Nearby stores for ${zip} (${miles}mi): ${enrichedStores.length} brands (${enrichedStores.filter(s=>s.hasDeals).length} with deals) from ${allPlaces.length} places [live]`);

    logSearch(zip, enrichedStores.length, 0);
    res.json({ stores: enrichedStores, cached: false });
  } catch (err) {
    console.error("Nearby stores error:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
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
  } catch (err) { console.error("Ad regions error:", err.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
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

    // Kroger-family deals: fetch if locationId is provided (works for all Kroger banners)
    const krogerRegion = summary.find(s => s.store === "kroger");
    if (locationId) {
      const banner = krogerRegion?.banner || "Kroger";
      const division = krogerRegion?.division || "";
      fetchPromises.push((async () => {
        const cacheKey = `kroger:${locationId}`;
        const cached = await getCachedDeals(cacheKey);
        if (cached) {
          results.kroger = cached.map(d => d.source ? d : { ...d, storeName: d.storeName || banner, source: "kroger" });
          results.sources.push({ store: "kroger", banner, division, deals: cached.length, cached: true });
          console.log(`  Kroger ${banner}: ${cached.length} deals [cached]`);
        } else {
          try {
            const unique = await fetchKrogerDeals(locationId, banner);
            await setCachedDeals(cacheKey, unique);
            results.kroger = unique;
            results.sources.push({ store: "kroger", banner, division, deals: unique.length, cached: false });
            console.log(`  Kroger ${banner}: ${unique.length} deals [live]`);
          } catch (e) {
            console.error(`  Kroger fetch error: ${e.message}`);
            results.sources.push({ store: "kroger", banner, deals: 0, error: e.message });
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
      // ALDI deals come from the ad-aggregator OCR pipeline (ad-extract:aldi cache),
      // populated weekly by the GH Action POST /api/extract-store. Same path as the
      // 80+ other chains we OCR — no bespoke ALDI scraper anymore. Cutover May 2026
      // (see commit "Replace broken ALDI scraper with OCR via aldi.weeklyad.us.com").
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
        // Don't assign category images — let frontend use emoji fallback instead of unreliable URLs
        adExtractDeals = adExtractDeals.map(d => d.image ? d : { ...d, image: null });
        results.sources.push({ store: "ad-extract", deals: adExtractDeals.length, cached: true });
        console.log(`  Ad-extracted deals: ${adExtractDeals.length} deals`);
      }
    } catch (e) {
      console.log(`  No ad-extracted deals found`);
    }

    let allDeals = [
      ...(results.kroger || []),
      ...(results.aldi || []),
      ...(results.walmart || []),
      ...adExtractDeals,
    ];

    // Deduplicate: keep the one with better price data
    const beforeDedup = allDeals.length;
    const seen = new Map();
    allDeals = allDeals.filter(d => {
      const key = (d.name || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
      if (!key) return false; // filter empty names
      if (seen.has(key)) {
        const existing = seen.get(key);
        // Keep existing if it has better price data
        if (!existing.salePrice && d.salePrice) { seen.set(key, d); return false; }
        return false;
      }
      seen.set(key, d);
      return true;
    });
    // Replace with best versions
    allDeals = [...seen.values()];

    // Filter bad prices
    const beforeFilter = allDeals.length;
    allDeals = allDeals.filter(d => {
      if (!d.name || d.name.trim() === "") return false;
      const price = parseFloat(String(d.salePrice || "").replace(/[^0-9.]/g, ""));
      if (price > 500) return false; // data error
      return true;
    });
    const removed = beforeDedup - allDeals.length;
    if (removed > 0) console.log(`  Cleaned: ${beforeDedup - beforeFilter} dupes, ${beforeFilter - allDeals.length} bad prices removed`);

    // Sanitize images — remove unreliable external URLs, set null so frontend uses emoji fallback
    allDeals = allDeals.map(d => {
      if (d.image && (d.image.includes("unsplash.com") || d.image.includes("pexels.com") || d.image.includes("igroceryads") || d.image.includes("iweeklyads") || d.image.includes("ladysavings"))) {
        d.image = null;
      }
      return d;
    });

    // Server-side brand filtering (if brands param provided)
    const brandsParam = req.query.brands;
    if (brandsParam) {
      const requestedBrands = brandsParam.split(",").map(b => b.trim().toLowerCase());
      const hasKrogerBrand = requestedBrands.some(b => isKrogerFamilyBrand(b));
      const beforeBrandFilter = allDeals.length;
      allDeals = allDeals.filter(d => {
        const store = (d.storeName || d.source || "").toLowerCase();
        // Kroger family expansion: if any Kroger banner requested, include all kroger-source deals
        if (hasKrogerBrand && d.source === "kroger") return true;
        // Direct match: storeName or source contains a requested brand (or vice versa)
        return requestedBrands.some(b => store.includes(b) || b.includes(store));
      });
      console.log(`  Brand filter: ${beforeBrandFilter} → ${allDeals.length} (brands: ${brandsParam})`);
    }

    console.log(`═══ Total: ${allDeals.length} deals from ${results.sources.length} sources ═══\n`);
    logSearch(zip, results.sources.length, allDeals.length);

    // Get the most recent fetched_at from deal_cache for this set of sources
    let dealsUpdatedAt = null;
    try {
      const cacheKeys = [];
      if (locationId) cacheKeys.push(`kroger:${locationId}`);
      cacheKeys.push("aldi:national", "walmart:national");
      const { data: cacheRows } = await supabase
        .from("deal_cache")
        .select("fetched_at")
        .in("cache_key", cacheKeys)
        .order("fetched_at", { ascending: false })
        .limit(1);
      if (cacheRows && cacheRows.length > 0) {
        dealsUpdatedAt = cacheRows[0].fetched_at;
      }
    } catch (e) { /* ignore */ }

    // Server-side pagination
    const total = allDeals.length;
    const limit = Math.min(parseInt(req.query.limit) || total, total);
    const offset = Math.min(parseInt(req.query.offset) || 0, total);
    const paged = limit < total ? allDeals.slice(offset, offset + limit) : allDeals;
    if (total > 1000) console.warn(`⚠️ Large deals pool: ${total} deals (${Math.round(JSON.stringify(allDeals).length / 1024)}KB)`);
    console.log(`  Serving: ${paged.length} of ${total} deals (${Math.round(JSON.stringify(paged).length / 1024)}KB) [limit=${limit} offset=${offset}]`);

    res.json({
      zip3,
      totalDeals: total,
      deals: paged,
      sources: results.sources,
      availableChains: summary.map(s => s.banner),
      dealsUpdatedAt,
      limit,
      offset,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    console.error("Regional deals error:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ══ ON-DEMAND AD EXTRACTION ═══════════════════════════════════════════════════

router.post("/api/extract-store", async (req, res) => {
  const { storeName } = req.body;
  if (!validateStoreName(storeName)) return res.status(400).json({ error: "Valid storeName is required (letters, numbers, spaces, hyphens, max 50 chars)" });

  const storeId = canonicalizeStoreId(storeName);

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
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate"
      }
    });
    const html = await pageRes.text();

    const isLadySavings = adUrl.includes("ladysavings.com");
    const isWeeklyAdUS = adUrl.includes("weeklyad.us.com");
    let images = [];

    if (isWeeklyAdUS) {
      // weeklyad.us.com network: sister subdomains ({chain}.weeklyad.us.com) each
      // serve ad pages at /images/{chain}/view/{N}.webp with sequential numbering.
      // Used for ALDI because igroceryads/ladysavings only mirror ALDI Finds (non-food
      // merchandise), while this aggregator carries the actual in-store food ad pages.
      // Probe sequentially from N=1 until first 404 to discover all pages.
      const slug = new URL(adUrl).hostname.split(".")[0];
      console.log(`On-demand: ${storeName} — weeklyad.us.com slug "${slug}", probing pages...`);
      for (let n = 1; n <= 20; n++) {
        const u = `https://${slug}.weeklyad.us.com/images/${slug}/view/${n}.webp`;
        try {
          const probe = await fetch(u, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
          if (probe.ok && (probe.headers.get("content-type") || "").startsWith("image/")) {
            images.push(u);
          } else break;
        } catch { break; }
      }
    } else if (isLadySavings) {
      const looksLikeChallenge = html.length < 50000 && /Just a moment|cf-chl-bypass|cloudflare/i.test(html);
      console.log(`[ladysavings fetch] ${storeName} page 1: status=${pageRes.status} bytes=${html.length}${looksLikeChallenge ? ' CHALLENGE' : ''}`);
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
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
              "Accept-Encoding": "gzip, deflate"
            }
          });
          const pHtml = await pRes.text();
          const pLooksLikeChallenge = pHtml.length < 50000 && /Just a moment|cf-chl-bypass|cloudflare/i.test(pHtml);
          console.log(`[ladysavings fetch] ${storeName} page ${p}: status=${pRes.status} bytes=${pHtml.length}${pLooksLikeChallenge ? ' CHALLENGE' : ''}`);
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
    // Per-chain OCR observability. apiOkCount tallies Anthropic 2xx; apiNon2xxCount
    // tallies HTTP errors (429/529/5xx); parseFailCount is a sub-tally of pages
    // where the API returned 2xx but JSON parse + recovery both failed. Without
    // these we cannot distinguish "Anthropic rate-limited us" from "image was bad"
    // — both look identical in the cache state.
    let apiOkCount = 0, apiNon2xxCount = 0, parseFailCount = 0;
    const perPageOutcome = [];
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
                { type: "text", text: `Extract grocery deals from this ${storeName} weekly ad image. Return ONLY a valid JSON array. No markdown, no commentary. Include every item that shows a price.

Output shape per item:
{"name":"","brand":"","salePrice":null,"unit":"","regularPrice":null,"dealType":"sale/bogo/percent_off","category":"meat/produce/dairy/bakery/frozen/pantry/snacks/beverages/deli/seafood/household/other","size":"","notes":""}

salePrice: the per-unit price the shopper pays. Always a number; never a phrase.
- "$3.99" -> 3.99
- "5 for $10" or "5/$10" -> 2.00. Put "5 for $10" in notes.
- "2/$5" -> 2.50. Put "2 for $5" in notes.
- B1G1 on a $4 item -> 2.00. Set dealType to "bogo".
- B1G1 50%-off on a $4 item -> 3.00. Set dealType to "bogo".
- If you cannot determine a per-unit price, omit the row.

regularPrice: the non-sale per-unit price. Compute from any of:
- "Was $5.99" -> 5.99
- "SAVE $2", "$2 off", "save up to $2" -> salePrice + 2
- "SAVE $1.50 PER LB" on a $0.79/lb item -> 2.29
- "SAVE UP TO 80¢" -> use the upper bound (salePrice + 0.80)
- For BOGO, regularPrice is the listed single-item price.
- If the ad shows no reference price and no savings amount, set regularPrice to null. Do NOT guess. Do NOT copy salePrice.

unit: "lb" if priced per pound; otherwise "each" or the package unit ("12 pk", "case").
dealType: "sale" for marked-down items, "bogo" for buy-one-get-one (any percentage), "percent_off" for "20% off" markdowns.

Use JSON null (not "") for unknown numeric fields. Return [] if the page has no extractable items.` }
              ]
            }]
          })
        });

        if (!aiRes.ok) {
          apiNon2xxCount++;
          const errBody = await aiRes.text().catch(() => "");
          console.error(`Vision API non-2xx for ${storeName} page ${i+1}: HTTP ${aiRes.status} — ${errBody.substring(0, 200)}`);
          perPageOutcome.push({ page: i+1, status: aiRes.status, kind: "api_non2xx" });
          if (i < maxPages - 1) await new Promise(r => setTimeout(r, 500));
          continue;
        }
        apiOkCount++;

        const aiData = await aiRes.json();
        const text = aiData.content?.map(c => c.text || "").join("") || "";
        let cleaned = text.replace(/```json|```/g, "").trim();
        let parsedOk = false;
        let pageDeals = 0;
        try {
          const deals = JSON.parse(cleaned);
          deals.forEach(d => { d.adImage = images[i]; d.adPage = i + 1; });
          allDeals.push(...deals);
          parsedOk = true;
          pageDeals = deals.length;
        } catch (e) {
          console.error(`OCR page ${i+1} JSON parse error:`, e.message);
          const lastBrace = cleaned.lastIndexOf("}");
          if (lastBrace > 0) {
            try {
              const recovered = JSON.parse(cleaned.substring(0, lastBrace + 1) + "]");
              recovered.forEach(d => { d.adImage = images[i]; d.adPage = i + 1; });
              allDeals.push(...recovered);
              parsedOk = true;
              pageDeals = recovered.length;
            } catch (e2) { console.error(`OCR page ${i+1} recovery parse error:`, e2.message); }
          }
        }
        if (parsedOk) {
          perPageOutcome.push({ page: i+1, ok: true, deals: pageDeals });
        } else {
          parseFailCount++;
          perPageOutcome.push({ page: i+1, kind: "parse_fail" });
        }
        if (i < maxPages - 1) await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.error(`  Page ${i+1} error: ${e.message}`);
        perPageOutcome.push({ page: i+1, kind: "page_outer_error", err: e.message });
      }
    }

    console.log(`OCR summary for ${storeName}: ${apiOkCount} ok, ${apiNon2xxCount} non-2xx, ${parseFailCount} parse-fail across ${images.length} pages. Per-page: ${JSON.stringify(perPageOutcome)}`);

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
          if (!textAiRes.ok) {
            const errBody = await textAiRes.text().catch(() => "");
            console.error(`Text fallback Vision API non-2xx for ${storeName}: HTTP ${textAiRes.status} — ${errBody.substring(0, 200)}`);
          }
          const textAiData = textAiRes.ok ? await textAiRes.json() : { content: [] };
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

    // Drop rows the model couldn't price. The Vision prompt instructs "if you
    // cannot determine a per-unit price, omit the row" but the model sometimes
    // includes the row anyway with salePrice=null. Those rows are useless to
    // UI and analysis alike, so filter them at the cache boundary.
    const beforeNullFilter = unique.length;
    unique = unique.filter(d => d.salePrice != null && d.salePrice !== "");
    if (unique.length < beforeNullFilter) {
      console.log(`On-demand: ${storeName} — dropped ${beforeNullFilter - unique.length} rows with null salePrice`);
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
      logApiUsage("anthropic", "extract-store", 0, 0, maxPages * 0.003); // ~$0.003 per page estimate
    } else {
      // Extraction yielded 0 deals — overwrite cache with [] so the failure becomes
      // observable (fetched_at updated, data=[]) rather than silently leaving stale
      // prior-week data in place. Both read paths treat [] as "no deals" cleanly.
      // See audit findings (commit "Replace broken ALDI scraper..."): this same
      // pattern previously hid 7 broken chains for up to 26 days.
      await setCachedDeals(`ad-extract:${storeId}`, []);
      console.warn(`On-demand: ${storeName} — extraction yielded 0 deals; cache cleared. OCR: ${apiOkCount} ok, ${apiNon2xxCount} non-2xx, ${parseFailCount} parse-fail.`);
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
  const storeId = canonicalizeStoreId(store);

  if (extractingStores.has(storeId)) {
    return res.json({ status: "extracting" });
  }
  const cached = await getCachedDeals(`ad-extract:${storeId}`);
  if (cached && cached.length > 0) {
    return res.json({ status: "ready", deals: cached.length });
  }
  res.json({ status: "none" });
});

// ── Store Requests ─────────────────────────────────────────────────────────
router.post("/api/store-requests", async (req, res) => {
  const { storeName, zip } = req.body;
  if (!storeName || typeof storeName !== "string" || storeName.trim().length < 2 || storeName.trim().length > 60) {
    return res.status(400).json({ error: "Store name is required (2-60 characters)" });
  }
  if (!zip || !/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: "Valid 5-digit zip code is required" });
  }
  try {
    const { data: row, error } = await supabase.from("store_requests").insert({
      store_name: storeName.trim(),
      zip: zip.trim(),
    }).select().single();
    if (error) throw error;
    console.log(`Store request: "${storeName.trim()}" from zip ${zip}`);
    res.json({ success: true });
    // Fire-and-forget admin notification — must not block the response or crash the handler
    setImmediate(() => {
      notifyStoreRequest({
        id: row?.id,
        store_name: row?.store_name ?? storeName.trim(),
        zip: row?.zip ?? zip.trim(),
        created_at: row?.created_at,
      }).catch(err => {
        console.error(`[${new Date().toISOString()}] notifyStoreRequest threw:`, err?.message || err);
      });
    });
  } catch (e) {
    console.error("Store request error:", e.message);
    res.status(500).json({ error: "Failed to save request" });
  }
});

export default router;
