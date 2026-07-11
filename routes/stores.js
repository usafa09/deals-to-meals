import { Router } from "express";
import fetch from "node-fetch";
import {
  supabase, validateZip, validateStoreName, isKrogerFamilyBrand,
  getAdRegions, summarizeRegions, geocodeZip,
  getCachedDeals, setCachedDeals, getCachedStores, setCachedStores,
  getCategoryImage, findIgroceryadsUrl, canonicalizeStoreId, extractingStores,
  storesWithDealsCache, logSearch, logApiUsage, logError, GOOGLE_MAPS_KEY, DEAL_CACHE_TTL, AD_EXTRACT_CACHE_TTL, AD_EXTRACT_REFRESH_AFTER,
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
      const adCutoff = new Date(Date.now() - AD_EXTRACT_CACHE_TTL).toISOString();
      const { data: zip3Data } = await supabase.from("deal_cache").select("data, cache_key").like("cache_key", `ad-extract:%:${zip3}`).gte("fetched_at", adCutoff);
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
        .not("cache_key", "like", "ad-extract:%:%")
        .gte("fetched_at", adCutoff);
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
      // Scope dedupe to the same store: cross-store name matches are the
      // cross-chain comparison, not duplicates. Longer slice + trailing-s
      // strip catches near-identical names ("...Chops Bone In"/"...Chop Bone").
      const nameKey = (d.name || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "").slice(0, 40);
      if (!nameKey) return false; // filter empty names
      const key = `${(d.storeName || d.source || "").toLowerCase()}::${nameKey}`;
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

    // pctOff backfill: OCR-extracted deals carry both prices but no pctOff,
    // which sinks them in the client's discount-weighted ranking. Compute it
    // wherever both prices exist. Cap at 90 to keep OCR price errors from
    // fabricating absurd discounts.
    allDeals = allDeals.map(d => {
      if (Number(d.pctOff) > 0) return d;
      const s = parseFloat(String(d.salePrice || "").replace(/[^0-9.]/g, ""));
      const r = parseFloat(String(d.regularPrice || "").replace(/[^0-9.]/g, ""));
      if (Number.isFinite(s) && Number.isFinite(r) && r > 0 && s > 0 && s < r) {
        return { ...d, pctOff: Math.min(90, Math.round(((r - s) / r) * 100)) };
      }
      return d;
    });

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
    let paged;
    if (limit < total && offset === 0) {
      // Store-fair slice: round-robin across stores (each store's deals kept in
      // their original order) so the limit can't amputate an entire store.
      const byStore = new Map();
      for (const d of allDeals) {
        const s = (d.storeName || d.source || "other").toLowerCase();
        if (!byStore.has(s)) byStore.set(s, []);
        byStore.get(s).push(d);
      }
      const queues = [...byStore.values()];
      paged = [];
      let qi = 0, emptied = 0;
      while (paged.length < limit && emptied < queues.length) {
        const q = queues[qi % queues.length];
        if (q.length) paged.push(q.shift());
        qi++;
        emptied = queues.filter(q2 => q2.length === 0).length;
      }
    } else {
      paged = limit < total ? allDeals.slice(offset, offset + limit) : allDeals;
    }
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

// Global cap on concurrent OCR extractions. The per-store extractingStores
// guard prevents duplicate work on one store but nothing bounded the total.
// On 2026-07-08 the Wednesday cron ran 5-8 extractions concurrently (full-res
// buffers + sharp working memory each) and OOM-killed the Render instance
// repeatedly. Limit 2 drains 20 stores in ~25 min without approaching the
// memory ceiling. Queued stores still report status "extracting", which is
// truthful: queued means work is committed, just not started.
const EXTRACT_CONCURRENCY = 2;
let extractSlotsInUse = 0;
const extractWaitQueue = [];
function acquireExtractSlot(storeName) {
  if (extractSlotsInUse < EXTRACT_CONCURRENCY) {
    extractSlotsInUse++;
    return Promise.resolve();
  }
  console.log(`Extract queue: ${storeName} waiting (${extractSlotsInUse} running, ${extractWaitQueue.length + 1} queued)`);
  return new Promise((resolve) => extractWaitQueue.push(resolve));
}
function releaseExtractSlot() {
  const next = extractWaitQueue.shift();
  if (next) next();
  else extractSlotsInUse = Math.max(0, extractSlotsInUse - 1);
}

async function fetchBestImage(url, headers) {
  // WordPress appends -scaled to large uploads; the original usually exists
  // at the same URL without the suffix. Verified June 11: 4.6-6.4x the pixels.
  const tryFetch = async (u) => {
    try {
      const r = await fetch(u, { headers });
      if (!r.ok) return null;
      if (!(r.headers.get("content-type") || "").startsWith("image/")) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length > 1000 ? buf : null;
    } catch { return null; }
  };
  // 8MB ceiling on unscaled originals. Observed 15MB/168-megapixel originals
  // on igroceryads; decoding those risks memory pressure for no OCR benefit.
  const MAX_ORIGINAL_BYTES = 8 * 1024 * 1024;
  if (/-scaled\.(jpe?g|png|webp)$/i.test(url)) {
    const orig = await tryFetch(url.replace(/-scaled(\.(?:jpe?g|png|webp))$/i, "$1"));
    if (orig && orig.length <= MAX_ORIGINAL_BYTES) return orig;
    if (orig) console.log(`fetchBestImage: original is ${(orig.length / 1048576).toFixed(1)}MB (> 8MB cap), using -scaled version`);
  }
  return tryFetch(url);
}

async function tileImage(buffer) {
  // Crop tall pages into overlapping horizontal bands (~1400px tall, 150px
  // overlap) so each band stays under the vision API's effective-resolution
  // cap. Width is bounded to 1600px first. Short pages pass through whole.
  // Overlap duplicates are collapsed later by the existing name+price dedup.
  const sharp = (await import("sharp")).default;
  // Batch image work on a memory-constrained instance: disable sharp's
  // decoded-pixel cache and its internal thread pool fan-out.
  sharp.cache(false);
  sharp.concurrency(1);
  let img = sharp(buffer);
  let meta = await img.metadata();
  if (!meta.width || !meta.height) return [buffer];
  if (meta.width > 1600) {
    buffer = await sharp(buffer).resize({ width: 1600 }).jpeg({ quality: 85 }).toBuffer();
    meta = await sharp(buffer).metadata();
  }
  if (meta.height <= 1800) return [buffer];
  const BAND = 1400, OVERLAP = 150, tiles = [];
  for (let top = 0; top < meta.height; top += BAND - OVERLAP) {
    const h = Math.min(BAND, meta.height - top);
    if (h < 300) break; // sliver; previous band's overlap already covers it
    tiles.push(await sharp(buffer).extract({ left: 0, top, width: meta.width, height: h }).jpeg({ quality: 85 }).toBuffer());
    if (top + h >= meta.height) break;
  }
  return tiles;
}

router.post("/api/extract-store", async (req, res) => {
  const { storeName } = req.body;
  if (!validateStoreName(storeName)) return res.status(400).json({ error: "Valid storeName is required (letters, numbers, spaces, hyphens, max 50 chars)" });

  const storeId = canonicalizeStoreId(storeName);

  const existing = await getCachedDeals(`ad-extract:${storeId}`);
  let cacheAgeMs = Infinity;
  try {
    const { data: cacheRow } = await supabase.from("deal_cache").select("fetched_at").eq("cache_key", `ad-extract:${storeId}`).single();
    if (cacheRow?.fetched_at) cacheAgeMs = Date.now() - new Date(cacheRow.fetched_at).getTime();
  } catch (e) { /* missing row reads as Infinity, which forces extraction below only via the existing null check */ }
  if (existing && existing.length >= 10) {
    const validTo = existing[0]?.adValidTo;
    const adExpired = validTo && new Date(validTo) < new Date();
    const dueForRefresh = cacheAgeMs > AD_EXTRACT_REFRESH_AFTER;
    if (!adExpired && !dueForRefresh) {
      return res.json({ status: "ready", deals: existing.length, storeId });
    }
    console.log(`On-demand: ${storeName} — re-extracting (${adExpired ? `ad expired ${validTo}` : `cache ${Math.round(cacheAgeMs / 86400000)}d old`})`);
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

  let slotAcquired = false;
  try {
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) { extractingStores.delete(storeId); return; }
    await acquireExtractSlot(storeName);
    slotAcquired = true;

    const pageRes = await fetch(adUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate"
      }
    });
    const html = await pageRes.text();

    // Parse the ad validity window from the page headline. igroceryads and
    // iweeklyads print "June 10 - June 16, 2026"; some pages use "through
    // June 16". ladysavings and weeklyad.us.com pages often lack dates, so
    // both fields stay null there (unknown is treated as not-expired).
    let adValidFrom = null, adValidTo = null;
    try {
      const MONTHS = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
      const plain = html.replace(/<[^>]+>/g, " ").replace(/&#8211;|&#x2013;|&ndash;|&#8212;|&#x2014;|&mdash;/gi, "-").replace(/&nbsp;|&#160;/gi, " ");
      const rangeM = plain.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*[–—-]\s*(?:(January|February|March|April|May|June|July|August|September|October|November|December)\s+)?(\d{1,2})(?:,?\s*(\d{4}))?/i);
      const now = new Date();
      if (rangeM) {
        const y = rangeM[5] ? parseInt(rangeM[5]) : now.getFullYear();
        const m1 = MONTHS[rangeM[1].toLowerCase()];
        const m2 = rangeM[3] ? MONTHS[rangeM[3].toLowerCase()] : m1;
        const from = new Date(Date.UTC(y, m1, parseInt(rangeM[2])));
        let to = new Date(Date.UTC(m2 < m1 ? y + 1 : y, m2, parseInt(rangeM[4]), 23, 59, 59));
        adValidFrom = from.toISOString(); adValidTo = to.toISOString();
      } else {
        const throughM = plain.match(/through\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
        if (throughM) {
          adValidTo = new Date(Date.UTC(now.getUTCFullYear(), MONTHS[throughM[1].toLowerCase()], parseInt(throughM[2]), 23, 59, 59)).toISOString();
        }
      }
      if (adValidTo && new Date(adValidTo) < now) {
        console.warn(`On-demand: ${storeName} — source ad is EXPIRED (valid to ${adValidTo}). Extracting anyway; Friday re-pass will retry.`);
      }
    } catch (e) { console.error("Ad validity parse error:", e.message); }

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
      const suspectSmall = html.length < 50000 && !looksLikeChallenge;
      console.log(`[ladysavings fetch] ${storeName} page 1: status=${pageRes.status} bytes=${html.length}${looksLikeChallenge ? ' CHALLENGE' : ''}${suspectSmall ? ' SUSPECT-SMALL' : ''}`);
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
          const pSuspectSmall = pHtml.length < 50000 && !pLooksLikeChallenge;
          console.log(`[ladysavings fetch] ${storeName} page ${p}: status=${pRes.status} bytes=${pHtml.length}${pLooksLikeChallenge ? ' CHALLENGE' : ''}${pSuspectSmall ? ' SUSPECT-SMALL' : ''}`);
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

    if (images.length === 0) {
      // 0 discovered images means the source page fetch failed or was blocked
      // (observed: ladysavings serving a 12KB stub with HTTP 200 to Render's IP
      // on 2026-07-08). This is a fetch failure, not an empty ad — leave any
      // existing cache untouched so users keep last week's real data.
      console.warn(`On-demand: ${storeName} — SOURCE FETCH FAILURE: 0 ad images discovered (page bytes=${html.length}). Cache left untouched. Body starts: ${String(html).substring(0, 200).replace(/\s+/g, " ")}`);
      return;
    }

    const allDeals = [];
    const maxPages = Math.min(images.length, 20);
    const MAX_VISION_CALLS = 24;
    let visionCalls = 0;
    // Per-chain OCR observability. apiOkCount tallies Anthropic 2xx; apiNon2xxCount
    // tallies HTTP errors (429/529/5xx); parseFailCount is a sub-tally of tiles
    // where the API returned 2xx but JSON parse + recovery both failed. Without
    // these we cannot distinguish "Anthropic rate-limited us" from "image was bad"
    // — both look identical in the cache state. Counters are tile-granular.
    let apiOkCount = 0, apiNon2xxCount = 0, parseFailCount = 0;
    const perPageOutcome = [];
    for (let i = 0; i < maxPages; i++) {
      try {
        const imgBuffer = await fetchBestImage(images[i], { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" });
        if (!imgBuffer) continue;
        const tiles = await tileImage(imgBuffer);
        if (visionCalls + tiles.length > MAX_VISION_CALLS) break;
        console.log(`${storeName} page ${i+1}: ${tiles.length} tiles`);

        for (let t = 0; t < tiles.length; t++) {
          const base64 = tiles[t].toString("base64");
          if (base64.length < 1000) continue;

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
                  { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
                  { type: "text", text: `Extract grocery deals from this ${storeName} weekly ad image. Return ONLY a valid JSON array. No markdown, no commentary. Include every item that shows a price.

Output shape per item:
{"name":"","brand":"","salePrice":null,"unit":"","regularPrice":null,"dealType":"sale/bogo/percent_off","requiresCoupon":false,"category":"meat/produce/dairy/bakery/frozen/pantry/snacks/beverages/deli/seafood/household/other","size":"","notes":""}

salePrice: the per-unit price the shopper pays. Always a number; never a phrase.
- "$3.99" -> 3.99
- "5 for $10" or "5/$10" -> 2.00. Put "5 for $10" in notes.
- "2/$5" -> 2.50. Put "2 for $5" in notes.
- B1G1 on a $4 item -> 2.00. Set dealType to "bogo".
- B1G1 50%-off on a $4 item -> 3.00. Set dealType to "bogo".
- B1G1 with "Save up to $X" and no listed price: X is the single-item price, so per-unit is X/2. Example: "Buy 1 Get 1 FREE, Save up to 7.09" -> 3.55.
- Never output 0 for salePrice. If no per-unit price can be determined, omit the row entirely.
- "Final Price" beats "Sale Price": when an item shows both (digital-coupon ads), salePrice is the FINAL price after the coupon, and set requiresCoupon to true.
- "N for $X" means salePrice is X divided by N. "4 for $8" -> 2.00. "2/$10" -> 5.00. "5/$5" -> 1.00.
- "When You Buy N", "Must Buy N", "Limit N" are purchase conditions, not prices. Put them in notes; never use N or the bundle total as the per-unit salePrice.
- requiresCoupon: set true when the price needs a digital coupon, store app, loyalty card, or membership (wording like "Digital Coupon", "with card", "for U", "mPerks", "Member Price"). Otherwise false.
- Large featured price circles and bubbles are deals, often the best on the page. Always include them.
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
          visionCalls++;

          if (!aiRes.ok) {
            apiNon2xxCount++;
            const errBody = await aiRes.text().catch(() => "");
            console.error(`Vision API non-2xx for ${storeName} page ${i+1} tile ${t+1}: HTTP ${aiRes.status} — ${errBody.substring(0, 200)}`);
            perPageOutcome.push({ page: i+1, tile: t+1, status: aiRes.status, kind: "api_non2xx" });
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          apiOkCount++;

          const aiData = await aiRes.json();
          const text = aiData.content?.map(c => c.text || "").join("") || "";
          let cleaned = text.replace(/```json|```/g, "").trim();
          let parsedOk = false;
          let tileDeals = 0;
          try {
            const deals = JSON.parse(cleaned);
            deals.forEach(d => { d.adImage = images[i]; d.adPage = i + 1; });
            allDeals.push(...deals);
            parsedOk = true;
            tileDeals = deals.length;
          } catch (e) {
            console.error(`OCR page ${i+1} tile ${t+1} JSON parse error:`, e.message);
            const lastBrace = cleaned.lastIndexOf("}");
            if (lastBrace > 0) {
              try {
                const recovered = JSON.parse(cleaned.substring(0, lastBrace + 1) + "]");
                recovered.forEach(d => { d.adImage = images[i]; d.adPage = i + 1; });
                allDeals.push(...recovered);
                parsedOk = true;
                tileDeals = recovered.length;
              } catch (e2) { console.error(`OCR page ${i+1} tile ${t+1} recovery parse error:`, e2.message); }
            }
          }
          if (parsedOk) {
            perPageOutcome.push({ page: i+1, tile: t+1, ok: true, deals: tileDeals });
          } else {
            parseFailCount++;
            perPageOutcome.push({ page: i+1, tile: t+1, kind: "parse_fail" });
          }
          await new Promise(r => setTimeout(r, 500));
        }
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
{"name":"","brand":"","salePrice":"","unit":"","regularPrice":"","dealType":"sale/bogo/percent_off","requiresCoupon":false,"category":"meat/produce/dairy/bakery/frozen/pantry/snacks/beverages/deli/seafood/household/other","size":"","notes":""}

Rules:
- Only include items that have a clear price
- For "2/$5" deals, set salePrice to "2.50" and notes to "2 for $5"
- For per-lb prices like "$3.99 lb", set unit to "/lb"
- B1G1 with "Save up to $X" and no listed price: X is the single-item price, so per-unit is X/2. Example: "Buy 1 Get 1 FREE, Save up to 7.09" -> 3.55.
- Never output 0 for salePrice. If no per-unit price can be determined, omit the row entirely.
- "Final Price" beats "Sale Price": when an item shows both (digital-coupon ads), salePrice is the FINAL price after the coupon, and set requiresCoupon to true.
- "N for $X" means salePrice is X divided by N. "4 for $8" -> 2.00. "2/$10" -> 5.00. "5/$5" -> 1.00.
- "When You Buy N", "Must Buy N", "Limit N" are purchase conditions, not prices. Put them in notes; never use N or the bundle total as the per-unit salePrice.
- requiresCoupon: set true when the price needs a digital coupon, store app, loyalty card, or membership (wording like "Digital Coupon", "with card", "for U", "mPerks", "Member Price"). Otherwise false.
- Large featured price circles and bubbles are deals, often the best on the page. Always include them.
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
    unique = unique.filter(d => d.salePrice != null && d.salePrice !== "" && parseFloat(d.salePrice) > 0);
    if (unique.length < beforeNullFilter) {
      console.log(`On-demand: ${storeName} — dropped ${beforeNullFilter - unique.length} rows with null or zero salePrice`);
    }

    unique = unique.map((d, i) => ({
      ...d,
      id: `${storeId}-${Date.now()}-${i}`,
      storeName,
      source: "ad-extract",
      image: getCategoryImage(d.category),
      adSourceUrl: adUrl,
      adValidFrom, adValidTo,
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
    if (slotAcquired) releaseExtractSlot();
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

// ══ HOMEPAGE PREVIEW ═════════════════════════════════════════════════════════
// Six real, current fresh deals for the pre-zip landing grid, from Kroger.
// Pinned to a Dayton store (Kroger pricing is divisional, so this represents
// the Ohio/heartland wedge — "this week at Kroger"). Kroger deals carry real
// product image URLs and regular prices. Curated to fresh categories only
// (protein, produce, dairy) — packaged goods have multipack/case regular-price
// errors that read as fake. Cache-miss → empty array; the homepage hides the grid.
const PREVIEW_KROGER_LOCATION = "01400705"; // Kroger, 1555 Wayne Ave, Dayton OH

// Shared fresh-deal curation: takes a raw Kroger deal array, returns up to
// `limit` balanced fresh deals (image + real prices + plausible discount),
// each annotated with _sale/_reg/_pct. Used by both the preview grid endpoint
// and the weekly bundle generator.
function curateFreshDeals(raw, limit) {
  if (!raw || !raw.length) return [];
  const clean = raw
    .map(d => {
      const s = parseFloat(String(d.salePrice || "").replace(/[^0-9.]/g, ""));
      const r = parseFloat(String(d.regularPrice || "").replace(/[^0-9.]/g, ""));
      const pct = Number(d.pctOff) > 0
        ? Number(d.pctOff)
        : (Number.isFinite(s) && Number.isFinite(r) && r > 0 && s > 0 && s < r
            ? Math.round(((r - s) / r) * 100) : 0);
      return { ...d, _sale: s, _reg: r, _pct: pct };
    })
    .filter(d =>
      d.image && String(d.image).startsWith("http") &&
      d.name && d.name.trim() &&
      Number.isFinite(d._sale) && d._sale > 0 &&
      Number.isFinite(d._reg) && d._reg > d._sale &&
      d._pct > 0 && d._pct <= 60 &&
      d._reg <= d._sale * 2.5
    );

  const isPackaged = (n) => /noodle|cup noodle|ramen|frozen|pizza|canned|boxed|snack|chip|cracker|cereal|soda|candy|cookie|sauce jar/i.test(n);
  const freshBucket = (d) => {
    const c = (d.category || "").toLowerCase();
    const n = (d.name || "").toLowerCase();
    if (isPackaged(n)) return "skip";
    if (/beef|steak/.test(c) || /\b(beef|steak|sirloin|ground beef|brisket)\b/.test(n)) return "beef";
    if (/pork|chicken|turkey|poultry/.test(c) || /\b(pork|chicken|turkey|sausage|bacon|ham|chop|tenderloin)\b/.test(n)) return "poultry_pork";
    if (/seafood|fish/.test(c) || /\b(shrimp|salmon|cod|tilapia|scallop|crab|fish fillet|flounder)\b/.test(n)) return "seafood";
    if (/fruit|produce/.test(c) || /\b(grape|peach|nectarine|mango|berry|berries|apple|melon|plum|strawberr)\b/.test(n)) return "fruit";
    if (/vegetable/.test(c) || /\b(corn|broccoli|squash|zucchini|pepper|tomato|potato|onion|carrot|greens|lettuce)\b/.test(n)) return "vegetable";
    if (/dairy|egg/.test(c) || /\b(milk|cheese|yogurt|egg|butter)\b/.test(n)) return "dairy";
    return "skip";
  };

  const byBucket = {};
  for (const d of clean) {
    const b = freshBucket(d);
    if (b === "skip") continue;
    (byBucket[b] = byBucket[b] || []).push(d);
  }
  for (const b in byBucket) byBucket[b].sort((a, z) => z._pct - a._pct);

  const slotPlan = ["beef", "poultry_pork", "seafood", "fruit", "vegetable", "dairy"];
  const picked = [];
  const usedNames = new Set();
  const takeFrom = (bucket) => {
    for (const d of (byBucket[bucket] || [])) {
      const key = (d.name || "").toLowerCase().slice(0, 30);
      if (!usedNames.has(key)) { usedNames.add(key); return d; }
    }
    return null;
  };
  for (const slot of slotPlan) {
    const d = takeFrom(slot);
    if (d) picked.push(d);
  }
  if (picked.length < limit) {
    const rest = [];
    for (const b in byBucket) for (const d of byBucket[b]) rest.push(d);
    rest.sort((a, z) => z._pct - a._pct);
    for (const d of rest) {
      if (picked.length >= limit) break;
      const key = (d.name || "").toLowerCase().slice(0, 30);
      if (!usedNames.has(key)) { usedNames.add(key); picked.push(d); }
    }
  }
  return picked.slice(0, limit);
}

// Looser curation for the SSR chain pages. Unlike the homepage preview (which
// needs product photos), these pages render text+price cards, so images and
// regular prices are optional. OCR'd chains (ALDI and most others) have neither.
// Requirements: a real name, a plausible sale price, and food (not household).
function curateChainDeals(raw, limit) {
  if (!raw || !raw.length) return [];
  const NON_FOOD = /paper towel|toilet|detergent|bleach|napkin|foil|trash bag|cleaner|shampoo|soap|diaper|batteries|charcoal|propane|flower|greeting card/i;
  const JUNK = /price drop|low price|extra savings|see store|weekly ad|assorted|varies/i;
  const clean = raw
    .map(d => {
      const s = parseFloat(String(d.salePrice || "").replace(/[^0-9.]/g, ""));
      const r = parseFloat(String(d.regularPrice || "").replace(/[^0-9.]/g, ""));
      const hasReg = Number.isFinite(r) && r > s && r > 0;
      const pct = Number(d.pctOff) > 0
        ? Number(d.pctOff)
        : (hasReg ? Math.round(((r - s) / r) * 100) : 0);
      return { ...d, _sale: s, _reg: hasReg ? r : null, _pct: (pct > 0 && pct <= 70) ? pct : 0 };
    })
    .filter(d =>
      d.name && d.name.trim().length > 2 &&
      Number.isFinite(d._sale) && d._sale > 0 && d._sale < 40 &&
      !NON_FOOD.test(d.name) && !JUNK.test(d.name)
    );

  // Rank by COOKABILITY, not discount depth. Sorting purely by pctOff floats
  // deep-discount junk food to the top (Walmart's best discounts are Frito-Lay,
  // Ritz, Goldfish), leaving the recipe generator with chips and no protein.
  // Proteins anchor dinners; produce supports them; snacks are dead weight.
  const cookScore = (d) => {
    const c = (d.category || "").toLowerCase();
    const n = (d.name || "").toLowerCase();
    let s = (d._pct || 0) * 0.5; // discount still matters, but only as a tiebreaker
    if (/beef|pork|chicken|turkey|meat|poultry|seafood|fish/.test(c) ||
        /\b(beef|pork|chicken|turkey|sausage|bacon|steak|shrimp|salmon|chop|brisket|ribeye|wing|ground)\b/.test(n)) s += 60;
    else if (/vegetable|produce|fruit/.test(c)) s += 30;
    else if (/dairy|egg|cheese|milk|butter|yogurt/.test(c) || /\b(egg|cheese|milk|butter|yogurt)\b/.test(n)) s += 25;
    else if (/pasta|rice|grain|bean|pantry|bread|potato/.test(c) || /\b(pasta|rice|beans|tortilla|potato)\b/.test(n)) s += 20;
    if (/snack|candy|cookie|chip|cracker|soda|beverage|dessert/.test(c)) s -= 50;
    if (/chips?|crackers?|cookie|candy|soda|little debbie|frito|ritz|goldfish|doritos|oreo/i.test(n)) s -= 50;
    return s;
  };

  const ranked = clean.slice().sort((a, z) => cookScore(z) - cookScore(a));
  const out = [];
  const seen = new Set();
  let snackCount = 0;
  for (const d of ranked) {
    const k = (d.name || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
    if (!k || seen.has(k)) continue;
    // Hard cap: at most 2 snack-ish items in the pool, so they can't crowd out food.
    const isSnack = cookScore(d) < 0;
    if (isSnack && snackCount >= 2) continue;
    if (isSnack) snackCount++;
    seen.add(k);
    out.push(d);
    if (out.length >= limit) break;
  }
  return out;
}

router.get("/api/deals/preview", async (req, res) => {
  try {
    // Prefer the weekly bundle's cards (kept in sync with the recipe). Fall back
    // to live curation if the bundle hasn't been generated yet.
    const bundle = await getCachedDeals("preview:bundle");
    if (bundle && Array.isArray(bundle.cards) && bundle.cards.length) {
      return res.json({ deals: bundle.cards, count: bundle.cards.length });
    }
    const raw = await getCachedDeals(`kroger:${PREVIEW_KROGER_LOCATION}`);
    const picked = curateFreshDeals(raw, 6);
    if (!picked.length) return res.json({ deals: [], count: 0 });
    const out = picked.map(d => ({
      name: d.name, salePrice: d._sale, regularPrice: d._reg,
      pctOff: d._pct, storeName: "Kroger", image: d.image, category: d.category || "", inRecipe: false,
    }));
    res.json({ deals: out, count: out.length });
  } catch (err) {
    console.error("Preview deals error:", err.message);
    res.json({ deals: [], count: 0 });
  }
});

// Serve the cached preview recipe (generated weekly alongside the cards).
router.get("/api/deals/preview-recipe", async (req, res) => {
  try {
    const bundle = await getCachedDeals("preview:bundle");
    if (bundle && bundle.recipe && bundle.recipe.title) {
      return res.json({ recipe: bundle.recipe, generatedAt: bundle.generatedAt || null });
    }
    res.json({ recipe: null });
  } catch (err) {
    console.error("Preview recipe error:", err.message);
    res.json({ recipe: null });
  }
});

// ══ SSR CHAIN PAGES ══════════════════════════════════════════════════════════
// One cached bundle per chain, powering the server-rendered /deals/:chain pages.
// Each bundle = that chain's curated deals + 3 recipes built from them.
// cacheKeys is an ordered fallback list — first non-empty cache wins. ALDI's
// bespoke scraper was retired (May 2026); its deals now come from the OCR
// pipeline under ad-extract:aldi, so aldi:national is empty in production.
const SSR_CHAINS = {
  kroger: { label: "Kroger", cacheKeys: () => [`kroger:${PREVIEW_KROGER_LOCATION}`] },
  aldi:   { label: "ALDI",   cacheKeys: () => ["aldi:national", "ad-extract:aldi"] },
  walmart:{ label: "Walmart",cacheKeys: () => ["walmart:national"] },
};

// Fetch a Pexels photo for a recipe title. Returns null on any failure.
async function fetchRecipePhoto(title) {
  try {
    const key = process.env.PEXELS_API_KEY;
    if (!key || !title) return null;
    const q = title.replace(/[^\w\s]/g, "").trim();
    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q + " food")}&per_page=1&orientation=landscape`, { headers: { Authorization: key } });
    if (!r.ok) return null;
    const d = await r.json();
    const p = d.photos && d.photos[0];
    return (p && (p.src.medium || p.src.small)) || null;
  } catch (e) { return null; }
}

// Build one chain's SSR bundle: curate deals, generate 3 recipes, attach photos.
async function buildChainBundle(slug) {
  const cfg = SSR_CHAINS[slug];
  if (!cfg) return null;
  // Walk the fallback list — first cache with data wins.
  let raw = null;
  for (const key of cfg.cacheKeys()) {
    const c = await getCachedDeals(key);
    if (c && c.length) { raw = c; console.log(`SSR ${slug}: using cache ${key} (${c.length} deals)`); break; }
  }
  if (!raw || !raw.length) { console.log(`SSR ${slug}: no data in any cache`); return null; }

  // Deals shown on the page: up to 15 curated fresh items.
  const deals = curateChainDeals(raw, 15);
  if (!deals.length) return null;

  // Recipe pool: the same curated set (generation picks from it).
  const base = process.env.PUBLIC_BASE_URL || "https://dishcount.co";
  let recipes = [];
  try {
    const rr = await fetch(`${base}/api/recipes/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": process.env.INTERNAL_API_TOKEN },
      body: JSON.stringify({
        ingredients: deals.map(d => ({
          name: d.name, category: d.category, salePrice: d.salePrice,
          regularPrice: d.regularPrice, savings: "", storeName: cfg.label,
          isPerLb: !!d.isPerLb, priceUnit: d.priceUnit || "",
        })),
        style: "Dinner", mealType: "Dinner", diets: [],
        mealRequest: `Create three DIFFERENT, realistic weeknight dinners from these ${cfg.label} sale items. CRITICAL RULES: (1) Each recipe must be a coherent dish a real family would actually eat. (2) Only combine sale items that genuinely belong together in one dish. (3) Do NOT force unrelated items into a recipe just because they are on sale — for example, never put fruit like grapes into a meat skillet or a surf-and-turf. (4) It is fine for a recipe to use only 2 or 3 of the sale items plus common pantry staples. (5) Each dinner should center on one protein. Fresh produce that does not fit a dinner should simply be left out.`,
      }),
    });
    const rj = await rr.json();
    recipes = (rj.recipes || []).slice(0, 3);
  } catch (e) { console.error(`SSR ${slug}: recipe gen failed:`, e.message); }

  if (!recipes.length) return null;

  const outRecipes = [];
  for (const r of recipes) {
    const photo = await fetchRecipePhoto(r.title);
    outRecipes.push({
      title: r.title,
      time: r.time || (r.readyInMinutes ? `${r.readyInMinutes} min` : ""),
      servings: r.servings || 4,
      estimatedCost: r.estimatedCost || 0,
      totalSavings: r.totalSavings || 0,
      costPerServing: r.servings ? Math.round((r.estimatedCost / r.servings) * 100) / 100 : 0,
      image: photo,
      usedSaleItems: (r.usedSaleItems || []).map(i => i.name).filter(Boolean),
      ingredients: (r.allIngredients || r.ingredients || []).map(i => i.name || i).slice(0, 14),
      instructions: (r.instructions || []).slice(0, 10),
    });
  }

  return {
    chain: slug,
    label: cfg.label,
    deals: deals.map(d => ({
      name: d.name, salePrice: d._sale, regularPrice: d._reg,
      pctOff: d._pct, image: d.image || null, category: d.category || "",
      isPerLb: !!d.isPerLb,
    })),
    recipes: outRecipes,
    generatedAt: new Date().toISOString(),
  };
}

// Weekly: refresh the pinned Kroger store's deals, generate one recipe from the
// fresh pool, map its used sale-items back to cards, backfill to 6, cache the
// {recipe, cards} bundle. Called by the Wednesday cron (x-internal-token gated).
router.post("/api/cron/refresh-preview", async (req, res) => {
  const token = req.headers["x-internal-token"];
  if (!token || token !== process.env.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    // 1. Refresh the pinned Kroger store's deal cache (fetch + store).
    let raw = await getCachedDeals(`kroger:${PREVIEW_KROGER_LOCATION}`);
    if (!raw || !raw.length) {
      try {
        raw = await fetchKrogerDeals(PREVIEW_KROGER_LOCATION, "Kroger");
        await setCachedDeals(`kroger:${PREVIEW_KROGER_LOCATION}`, raw);
      } catch (e) { console.error("Preview: Kroger refresh failed:", e.message); }
    }
    // 2. Curate a generous fresh pool (up to 12) to give the recipe good options.
    const pool = curateFreshDeals(raw, 12);
    if (!pool.length) return res.json({ ok: false, reason: "no fresh deals" });

    // 3. Generate one dinner recipe from the pool via the internal recipe path.
    const base = process.env.PUBLIC_BASE_URL || "https://dishcount.co";
    let recipe = null;
    try {
      const rr = await fetch(`${base}/api/recipes/ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-token": process.env.INTERNAL_API_TOKEN },
        body: JSON.stringify({
          ingredients: pool.map(d => ({
            name: d.name, category: d.category, salePrice: d.salePrice,
            regularPrice: d.regularPrice, savings: "", storeName: "Kroger",
            isPerLb: !!d.isPerLb, priceUnit: d.priceUnit || "",
          })),
          style: "Dinner", mealType: "Dinner", diets: [],
          mealRequest: "A simple, appealing dinner that uses several of these sale items together.",
        }),
      });
      const rj = await rr.json();
      recipe = (rj.recipes && rj.recipes[0]) || null;
    } catch (e) { console.error("Preview: recipe gen failed:", e.message); }

    if (!recipe) return res.json({ ok: false, reason: "recipe generation failed" });

    // 4. Map the recipe's used sale items back to full cards (image + pctOff)
    //    from the pool, matching by name.
    const poolByName = new Map(pool.map(d => [(d.name || "").toLowerCase(), d]));
    const usedNames = new Set();
    const cards = [];
    for (const it of (recipe.usedSaleItems || [])) {
      const match = poolByName.get((it.name || "").toLowerCase());
      if (match && !usedNames.has(match.name.toLowerCase())) {
        usedNames.add(match.name.toLowerCase());
        cards.push({
          name: match.name, salePrice: match._sale, regularPrice: match._reg,
          pctOff: match._pct, storeName: "Kroger", image: match.image,
          category: match.category || "", inRecipe: true,
        });
      }
    }
    // 5. Backfill to 6 with next-best fresh deals not already used.
    for (const d of pool) {
      if (cards.length >= 6) break;
      if (usedNames.has((d.name || "").toLowerCase())) continue;
      usedNames.add((d.name || "").toLowerCase());
      cards.push({
        name: d.name, salePrice: d._sale, regularPrice: d._reg,
        pctOff: d._pct, storeName: "Kroger", image: d.image,
        category: d.category || "", inRecipe: false,
      });
    }

    // Fetch a Pexels food photo for the recipe (same source as /api/recipe-image).
    let recipeImage = recipe.image || null;
    try {
      const pexelsKey = process.env.PEXELS_API_KEY;
      if (pexelsKey && recipe.title) {
        const q = recipe.title.replace(/[^\w\s]/g, "").trim();
        const pRes = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q + " food")}&per_page=1&orientation=landscape`, {
          headers: { Authorization: pexelsKey },
        });
        if (pRes.ok) {
          const pData = await pRes.json();
          const photo = pData.photos?.[0];
          recipeImage = photo?.src?.medium || photo?.src?.small || recipeImage;
        }
      }
    } catch (e) { console.error("Preview: Pexels image fetch failed:", e.message); }

    const bundle = {
      recipe: {
        title: recipe.title,
        time: recipe.time || (recipe.readyInMinutes ? `${recipe.readyInMinutes} min` : ""),
        servings: recipe.servings || 4,
        estimatedCost: recipe.estimatedCost || 0,
        totalSavings: recipe.totalSavings || 0,
        costPerServing: recipe.servings ? Math.round((recipe.estimatedCost / recipe.servings) * 100) / 100 : 0,
        usedCount: cards.filter(c => c.inRecipe).length,
        image: recipeImage,
        ingredients: (recipe.allIngredients || recipe.ingredients || []).map(i => i.name || i).slice(0, 12),
        instructions: (recipe.instructions || []).slice(0, 8),
      },
      cards: cards.slice(0, 6),
      generatedAt: new Date().toISOString(),
    };
    await setCachedDeals("preview:bundle", bundle);
    console.log(`Preview bundle refreshed: "${bundle.recipe.title}", ${bundle.cards.length} cards, ${bundle.recipe.usedCount} in recipe`);
    res.json({ ok: true, title: bundle.recipe.title, cards: bundle.cards.length, usedInRecipe: bundle.recipe.usedCount });
  } catch (err) {
    console.error("refresh-preview error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Weekly: rebuild the SSR bundle for each chain page. Independent of the
// homepage preview bundle — a failure here can't break the homepage.
router.post("/api/cron/refresh-ssr", async (req, res) => {
  const token = req.headers["x-internal-token"];
  if (!token || token !== process.env.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // One chain per request. Generating all 3 in a single request (each = a Haiku
  // recipe call + 3 Pexels fetches) exceeded the ~100s gateway timeout: the
  // connection was cut mid-run and the last chain never regenerated. The cron
  // calls this once per chain instead.
  const requested = String(req.query.chain || "").toLowerCase();
  const slugs = requested
    ? (SSR_CHAINS[requested] ? [requested] : null)
    : Object.keys(SSR_CHAINS);
  if (!slugs) return res.status(400).json({ ok: false, error: `Unknown chain "${requested}". Valid: ${Object.keys(SSR_CHAINS).join(", ")}` });
  if (!requested) {
    console.warn("refresh-ssr called with no ?chain= param — running all chains may exceed the gateway timeout. Prefer one chain per request.");
  }

  const results = {};
  for (const slug of slugs) {
    try {
      const bundle = await buildChainBundle(slug);
      if (bundle) {
        await setCachedDeals(`ssr:bundle:${slug}`, bundle);
        results[slug] = { ok: true, deals: bundle.deals.length, recipes: bundle.recipes.length, titles: bundle.recipes.map(r => r.title) };
        console.log(`SSR bundle ${slug}: ${bundle.deals.length} deals, ${bundle.recipes.length} recipes`);
      } else {
        results[slug] = { ok: false, reason: "no bundle (empty cache or generation failed)" };
      }
    } catch (e) {
      results[slug] = { ok: false, error: e.message };
      console.error(`SSR bundle ${slug} failed:`, e.message);
    }
  }
  res.json({ ok: true, results });
});

// Read a chain's SSR bundle (used by the page renderer in Session 2; also
// handy for verification).
router.get("/api/deals/chain/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!SSR_CHAINS[slug]) return res.status(404).json({ error: "Unknown chain" });
    const bundle = await getCachedDeals(`ssr:bundle:${slug}`);
    if (!bundle) return res.json({ bundle: null });
    res.json({ bundle });
  } catch (err) {
    console.error("chain bundle error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
