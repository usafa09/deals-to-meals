import { Router } from "express";
import fetch from "node-fetch";
import {
  supabase, validateZip, validateStoreName, isKrogerFamilyBrand,
  getAdRegions, summarizeRegions, geocodeZip,
  getCachedDeals, setCachedDeals, getCachedStores, setCachedStores,
  getCategoryImage, findIgroceryadsUrl, canonicalizeStoreId, extractingStores, TABLE_SOURCED,
  storesWithDealsCache, logSearch, logApiUsage, logError, GOOGLE_MAPS_KEY, DEAL_CACHE_TTL, AD_EXTRACT_CACHE_TTL, AD_EXTRACT_REFRESH_AFTER,
} from "../lib/utils.js";
import { fetchKrogerDeals } from "./kroger.js";
import { notifyStoreRequest } from "../lib/email.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// The SSR pages inject the same header/footer as the rest of the site so they
// don't read as orphaned pages from a different product.
const __ssrDir = dirname(fileURLToPath(import.meta.url));
const SITE_HEADER = (() => {
  try { return readFileSync(join(__ssrDir, "..", "public", "header.html"), "utf8"); }
  catch (e) { console.error("SSR: header.html unreadable:", e.message); return ""; }
})();
const SITE_FOOTER = `
  <footer class="landing-footer">
    <p>Dishcount &middot; Meals from Deals &middot; Built in Dayton, Ohio</p>
    <p><a href="/deals">Featured Deals</a> &middot; <a href="/features.html">Features</a> &middot; <a href="/blog/">Blog</a> &middot; <a href="/about.html">About</a> &middot; <a href="/about.html#faq">FAQ</a> &middot; <a href="/contact.html">Contact</a> &middot; <a href="/terms.html">Terms</a> &middot; <a href="/privacy.html">Privacy</a></p>
    <p class="social-links" style="margin-top:12px;display:flex;gap:16px;justify-content:center;align-items:center">
      <a href="https://www.facebook.com/dishcountapp/" aria-label="Dishcount on Facebook" target="_blank" rel="noopener" style="display:inline-flex;color:inherit;opacity:0.75;transition:opacity 0.15s" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.75">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
        </svg>
      </a>
    </p>
    <p>&copy; 2026 Dishcount. All rights reserved.</p>
    <p style="margin-top:12px;font-size:12px;color:#8fb89a;line-height:1.5;max-width:720px;margin-left:auto;margin-right:auto">Dishcount participates in affiliate programs. We may earn a commission from qualifying purchases at no additional cost to you. <a href="/disclosures.html" style="color:#c8d6cb;text-decoration:underline;text-underline-offset:2px">Learn more</a>.</p>
  </footer>`;

const router = Router();

// Single ceiling for any discount percentage this app is willing to assert.
// Above it, the figure is almost always a source error — a per-each price
// compared against a per-pound one, or an OCR'd "reg" belonging to a neighbouring
// item — not a real deal. Every path that computes or displays pctOff reads this:
// the regional backfill, the SSR chain pages (curateChainDeals), and the homepage
// preview (curateFreshDeals). It was previously 90 in the backfill and 60 in the
// two curate functions, so the same row rendered "75% off" in the deal browser
// and no discount at all on /deals/{chain}.
//
// The remedy is uniform too: when the computed percentage exceeds the ceiling we
// assert NO discount rather than clamping to 60. Clamping would just relocate the
// disagreement — the browser would claim 60% off on a row the chain page shows
// with no badge. A number we do not trust should not be published at all.
const MAX_PLAUSIBLE_PCT_OFF = 60;

// A percent-off badge is never shown on a B1G1 row. The percentage is computed
// as 1 - sale/regular, but on a bogo row salePrice is a DERIVED per-unit figure
// (the OCR prompt instructs Vision to halve B1G1 pricing) while regularPrice is
// the single-unit price -- so the badge compares a two-item average against a
// one-item price and overstates the discount. Publix Sugarbee Apples read
// "56% off" ($3.50 vs $7.99) when a true buy-one-get-one-free is 50% at most.
//
// Capping at 50 was considered and rejected: it would print a confident number
// over a derivation we cannot verify. 17 of 71 cached bogo rows carrying both
// prices do not reconcile as sale x 2 = regular (Sugarbee: 3.495 x 2 = 6.99,
// not 7.99; Hass Avocados carry sale == regular == $5), so the real discount is
// unknown, not merely mis-scaled. "Buy 1 Get 1 Free" now renders under the
// price and states the offer exactly, which is the honest version of the claim.
const isBogoRow = (d) => String(d?.dealType ?? "").trim().toLowerCase() === "bogo";

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
          || isKrogerFamilyBrand(s.name) || s.name === "ALDI",
        canExtract: !!findIgroceryadsUrl(s.name) || isKrogerFamilyBrand(s.name) || s.name === "ALDI",
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

    // The ?refresh= cron-authority parameter existed only to force a refetch of
    // walmart:national past its cached row. Walmart was retired as a source in
    // Aug 2026 and no remaining source in this handler is fetched live here —
    // Kroger and ALDI both read from caches written elsewhere — so the parameter
    // has nothing left to force. It is still parsed and warned about so a stale
    // caller (the weekly workflow, a bookmarked URL) gets a log line rather than
    // silence, but it no longer changes behaviour.
    const refreshParam = String(req.query.refresh || "").toLowerCase();
    if (refreshParam) console.warn(`  refresh=${refreshParam} ignored: no live-fetched source remains in this handler`);

    console.log(`\n═══ Regional deals for ${zip} (${zip3}) — ${summary.length} chains ═══`);

    const results = { kroger: null, aldi: null, sources: [] };
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
    // wherever both prices exist, and drop anything above MAX_PLAUSIBLE_PCT_OFF
    // on the floor — the same ceiling, with the same remedy, that the SSR chain
    // pages and the homepage preview apply. This used to cap at 90, which is why
    // a 75%-off OCR row showed "75% off" here and no discount on /deals/{chain}.
    allDeals = allDeals.map(d => {
      if (isBogoRow(d)) return { ...d, pctOff: 0 };
      if (Number(d.pctOff) > 0) return d;
      const s = parseFloat(String(d.salePrice || "").replace(/[^0-9.]/g, ""));
      const r = parseFloat(String(d.regularPrice || "").replace(/[^0-9.]/g, ""));
      if (Number.isFinite(s) && Number.isFinite(r) && r > 0 && s > 0 && s < r) {
        const pct = Math.round(((r - s) / r) * 100);
        if (pct > MAX_PLAUSIBLE_PCT_OFF) return d; // implausible — assert no discount
        return { ...d, pctOff: pct };
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
      cacheKeys.push("aldi:national");
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

  // INVARIANT: every buffer returned from this function is JPEG.
  //
  // The Vision request hardcodes media_type "image/jpeg". The resize and tile
  // paths below both end in .jpeg(), but the two pass-through returns used to
  // hand back the source buffer untouched — so a source serving WebP pages that
  // needed neither resize nor tiling produced a WebP payload labelled as JPEG,
  // and Anthropic rejected every page with HTTP 400 ("the image appears to be a
  // image/webp image"). That is exactly what happened to Meijer (1400x1521:
  // under the 1600 width bound and under the 1800 height bound, so it hit
  // neither conversion), which silently degraded to the text fallback and lost
  // ~200 deals/week. ALDI (1400x3100) and Lidl (1400x2375) always tile, so they
  // always transcoded and never showed the defect.
  //
  // Normalizing here is one change; type-detecting at the call site would be N.
  const toJpeg = async (buf, format) => {
    if (format === "jpeg" || format === "jpg") return buf;
    try {
      return await sharp(buf).jpeg({ quality: 85 }).toBuffer();
    } catch (e) {
      // An un-transcodable buffer is an unusable image; let it through so the
      // per-tile error handling reports it rather than killing the whole page.
      console.error(`tileImage: JPEG transcode failed (format=${format}): ${e.message}`);
      return buf;
    }
  };

  let img = sharp(buffer);
  let meta = await img.metadata();
  if (!meta.width || !meta.height) return [await toJpeg(buffer, meta.format)];
  if (meta.width > 1600) {
    buffer = await sharp(buffer).resize({ width: 1600 }).jpeg({ quality: 85 }).toBuffer();
    meta = await sharp(buffer).metadata();
  }
  if (meta.height <= 1800) return [await toJpeg(buffer, meta.format)];
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

  // A table-sourced chain is read from its weeklyad.us.com products table
  // instead of the OCR path, so its ad URL is that subdomain rather than the
  // aggregator page findIgroceryadsUrl would return.
  const tableSlug = TABLE_SOURCED[String(storeName).trim().toLowerCase()] || null;
  const adUrl = tableSlug ? `https://${tableSlug}.weeklyad.us.com/` : findIgroceryadsUrl(storeName);
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

    // Table-sourced chains parse rows straight out of the served markup. The
    // rows are shaped exactly like the OCR path's, so everything downstream --
    // the A1 classifier, dealRejectReason, the rejectTally, the ad-reject: row
    // and the cache write -- is the same code on the same data.
    const tableRows = tableSlug ? parseWeeklyAdTable(html) : null;
    if (tableRows) {
      const v = parseTableValidity(html);
      if (v.adValidFrom) { adValidFrom = v.adValidFrom; adValidTo = v.adValidTo; }
      console.log(`On-demand: ${storeName} — weeklyad table: ${tableRows.length} rows parsed, no Vision calls`);
    }

    const isLadySavings = adUrl.includes("ladysavings.com");
    const isWeeklyAdUS = adUrl.includes("weeklyad.us.com");
    let images = [];

    if (isWeeklyAdUS) {
      // weeklyad.us.com network: sister subdomains ({chain}.weeklyad.us.com)
      // each serve their ad pages under /images/{chain}/view/. Used for ALDI and
      // Lidl because igroceryads and ladysavings mirror only those chains' Finds
      // pages (non-food merchandise), while this aggregator carries the actual
      // in-store food pages.
      //
      // The served markup lists every page image, so it is read directly. An
      // earlier implementation guessed at URLs instead, requesting /view/1.webp,
      // /view/2.webp and so on until one 404'd. That obtained nothing the markup
      // does not already disclose, and it was strictly worse than reading it:
      // filenames are not uniform across the network -- Meijer serves
      // "Weekly-Deals_compressed_page-0001.webp" and 403s on the very first
      // guess -- and the probe's 20-iteration ceiling silently truncated longer
      // flyers, so a chain whose ad ran past 20 pages had the remainder dropped
      // with nothing logged.
      //
      // Page counts vary by chain and week. A scan on 2026-08-25 returned 2 pages
      // for ALDI, 38 for Lidl and 31 for Meijer; those are a sample of one run,
      // not fixed expectations.
      const slug = new URL(adUrl).hostname.split(".")[0];
      const viewRegex = new RegExp(`https?://${slug}\\.weeklyad\\.us\\.com/images/${slug}/view/[^"'\\s)]+\\.webp`, "gi");
      const pageNum = (u) => {
        const m = u.split("/").pop().match(/(\d+)\D*\.webp$/i);
        return m ? parseInt(m[1], 10) : 0;
      };
      images = [...new Set(html.match(viewRegex) || [])].sort((a, b) => pageNum(a) - pageNum(b));
      console.log(`On-demand: ${storeName} — weeklyad.us.com slug "${slug}", markup scan found ${images.length} pages`);
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
      // Only the URLs the post itself lists. A previous fallback probed sibling
      // filenames (1-1-scaled.jpg, 1-2-scaled.jpg …) whenever three or fewer
      // images were found, but /wp-content/uploads/YYYY/MM/ is a shared monthly
      // directory holding every chain's ad images, so the probe walked into
      // other posts and OCR'd other chains' circulars as if they were this
      // chain's pages. No filename convention separates one post's uploads from
      // another's in that directory, so no filename-shaped guess can be sound.
      const UPLOAD_PATTERN = "(?:(?:https?:)?//(?:www\\.)?(?:igroceryads|iweeklyads)\\.com)?/wp-content/uploads/\\d{4}/\\d{2}/[^\"'\\s),]+?\\.(?:webp|jpg|jpeg|png)";
      const uploadScan = new RegExp(UPLOAD_PATTERN, "gi");
      const uploadTest = new RegExp("^" + UPLOAD_PATTERN + "$", "i");

      // Lazy-loading themes leave src as a placeholder and put the real URL in
      // data-src or srcset, so every image-bearing attribute is collected before
      // the whole document is scanned for gallery and attachment markup that may
      // not use an img tag at all.
      const candidates = [];
      const attrRe = /(?:data-lazy-srcset|data-lazy-src|data-srcset|data-src|srcset|src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
      let am;
      while ((am = attrRe.exec(html))) {
        const val = am[1] !== undefined ? am[1] : am[2];
        // srcset is a comma-separated list of "url descriptor" pairs.
        for (const part of String(val).split(",")) {
          const u = part.trim().split(/\s+/)[0];
          if (u) candidates.push(u);
        }
      }
      candidates.push(...(html.match(uploadScan) || []));

      const absolutize = (u) => {
        const s = String(u).trim();
        if (s.startsWith("//")) return "https:" + s;
        if (s.startsWith("/")) { try { return new URL(s, adUrl).href; } catch { return s; } }
        return s;
      };

      images = [...new Set(
        candidates
          .map(absolutize)
          .filter(u => uploadTest.test(u))
          // WordPress resize variants of a page image, not extra pages.
          .filter(u => !/-\d{2,4}x\d{2,4}\.(?:webp|jpg|jpeg|png)$/i.test(u))
      )].sort((a, b) => {
        const extractNum = (url) => {
          const fname = url.split("/").pop();
          const m = fname.match(/page_(\d+)/) || fname.match(/img(\d+)/) || fname.match(/-(\d+)-scaled/) || fname.match(/-(\d+)\./);
          return parseInt(m?.[1] || "0");
        };
        return extractNum(a) - extractNum(b);
      });
    }

    // Every discovered URL is logged, not just the count, so an undercount from
    // a source changing its markup shows up in the logs instead of quietly
    // producing a short ad.
    console.log(`On-demand extraction for ${storeName}: ${images.length} pages found`);
    images.forEach((u, i) => console.log(`  [ad-image] ${storeName} ${i + 1}/${images.length} ${u}`));

    if (!tableRows?.length && images.length === 0) {
      // 0 discovered images means the source page fetch failed or was blocked
      // (observed: ladysavings serving a 12KB stub with HTTP 200 to Render's IP
      // on 2026-07-08). This is a fetch failure, not an empty ad — leave any
      // existing cache untouched so users keep last week's real data.
      console.warn(`On-demand: ${storeName} — SOURCE FETCH FAILURE: 0 ad images discovered (page bytes=${html.length}). Cache left untouched. Body starts: ${String(html).substring(0, 200).replace(/\s+/g, " ")}`);
      // The ad-reject: row tracks every invocation, so it is written here too.
      // rejected:0 on this path does NOT mean a clean extraction — nothing was
      // validated because nothing was fetched. outcome distinguishes the two:
      // without it, a run that never reached the deals and a run that found no
      // junk are indistinguishable rows, and the fetch failure reads as health.
      // Deliberately separate from the ad-extract: row, which is left untouched
      // above so users keep last week's real deals.
      await setCachedDeals(`ad-reject:${storeId}`, {
        storeName, storeId,
        adSourceUrl: adUrl,
        rejectedAt: new Date().toISOString(),
        outcome: "source-fetch-failure",
        note: `Source fetch failed: 0 ad images discovered from ${adUrl} (page bytes=${html.length}). No deals were extracted or validated; the ad-extract cache was left untouched.`,
        pageBytes: html.length,
        imagesFound: 0,
        total: 0,
        rejected: 0,
        byReason: {},
        truncated: false,
        rows: [],
      });
      return;
    }

    const allDeals = tableRows ? [...tableRows] : [];
    // Budget math, measured 2026-08-19: pages tile into 1-3 images each, so the
    // call count is what matters, not the page count.
    //   Meijer 31 pages x 1 tile = 31 calls  (fits)
    //   ALDI    4 pages x 3 tiles = 12 calls  (fits)
    //   Lidl   36 pages x 2 tiles = 72 calls  (fits at 80; was truncated at 48)
    // The original 20/24 pair fit none of them and silently cut Meijer at 20
    // pages. Haiku vision runs ~$0.003/page, so a worst-case 80-call chain is
    // ~$0.24/chain/week — still pennies against losing half an ad. maxPages
    // stays 40, so the page count remains the outer bound.
    // 0 pages for a table-sourced chain: the loop below never runs and no
    // Vision call is billed.
    const maxPages = tableRows ? 0 : Math.min(images.length, 40);
    const MAX_VISION_CALLS = 80;
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
- B1G1 where the only figure shown is a savings amount (however it is worded — "Save 7.09", "Save up to 7.09"): on a buy-one-get-one that figure IS one item's price, so salePrice is half of it -> 3.55. This rule sets salePrice ONLY. It is the single exception to "hedged savings wording is unusable", and it does not extend to regularPrice: for BOGO, regularPrice comes from a listed single-item price or is null.
- Never output 0 for salePrice. If no per-unit price can be determined, omit the row entirely.
- "Final Price" beats "Sale Price": when an item shows both (digital-coupon ads), salePrice is the FINAL price after the coupon, and set requiresCoupon to true.
- "N for $X" means salePrice is X divided by N. "4 for $8" -> 2.00. "2/$10" -> 5.00. "5/$5" -> 1.00.
- "When You Buy N", "Must Buy N", "Limit N" are purchase conditions, not prices. Put them in notes; never use N or the bundle total as the per-unit salePrice.
- requiresCoupon: set true when the price needs a digital coupon, store app, loyalty card, or membership (wording like "Digital Coupon", "with card", "for U", "mPerks", "Member Price"). Otherwise false.
- Large featured price circles and bubbles are deals, often the best on the page. Always include them.
- If you cannot determine a per-unit price, omit the row.

regularPrice: the non-sale per-unit price. Derive it ONLY from an explicit reference price or an EXACT stated savings amount:
- "Was $5.99", "Reg. $5.99", "Regularly $5.99" -> 5.99
- "SAVE $2" or "$2 off" (exact amount) -> salePrice + 2
- "SAVE $1.50 PER LB" on a $0.79/lb item -> 2.29
- For BOGO, regularPrice is the listed single-item price.
- "SAVE UP TO $X" and "SAVE UP TO 80¢" are ceilings advertised across a group of items, NOT this item's savings. Set regularPrice to null. Do NOT add the amount to salePrice. Do NOT treat it as an upper bound.
- Any hedged savings wording ("up to", "as much as", "save big") -> regularPrice is null.
- If the ad shows no reference price and no exact savings amount, set regularPrice to null. Do NOT guess. Do NOT copy salePrice.

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
      // Loud, greppable alarm. This path replaces the vision rows wholesale with
      // a scrape of the first 8000 chars of page HTML — a real degradation that
      // previously looked like a successful extraction from the outside (Meijer
      // sat here for weeks reporting "ready" with a fraction of its deals). The
      // counts distinguish the causes: all non-2xx means the API rejected the
      // payloads, all ok with few deals means the ad pages genuinely had little.
      console.warn(`TEXT_FALLBACK ${storeName}: only ${unique.length} deals from ${images.length} images (vision: ${apiOkCount} ok, ${apiNon2xxCount} non-2xx, ${parseFailCount} parse-fail) — falling back to HTML text scrape, vision rows will be DISCARDED`);
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
- B1G1 where the only figure shown is a savings amount (however it is worded — "Save 7.09", "Save up to 7.09"): on a buy-one-get-one that figure IS one item's price, so salePrice is half of it -> 3.55. This rule sets salePrice ONLY. It is the single exception to "hedged savings wording is unusable", and it does not extend to regularPrice: for BOGO, regularPrice comes from a listed single-item price or is null.
- Never output 0 for salePrice. If no per-unit price can be determined, omit the row entirely.
- "Final Price" beats "Sale Price": when an item shows both (digital-coupon ads), salePrice is the FINAL price after the coupon, and set requiresCoupon to true.
- "N for $X" means salePrice is X divided by N. "4 for $8" -> 2.00. "2/$10" -> 5.00. "5/$5" -> 1.00.
- "When You Buy N", "Must Buy N", "Limit N" are purchase conditions, not prices. Put them in notes; never use N or the bundle total as the per-unit salePrice.
- requiresCoupon: set true when the price needs a digital coupon, store app, loyalty card, or membership (wording like "Digital Coupon", "with card", "for U", "mPerks", "Member Price"). Otherwise false.
- Large featured price circles and bubbles are deals, often the best on the page. Always include them.

regularPrice: the non-sale per-unit price. Derive it ONLY from an explicit reference price or an EXACT stated savings amount:
- "Was $5.99", "Reg. $5.99", "Regularly $5.99" -> 5.99
- "SAVE $2" or "$2 off" (exact amount) -> salePrice + 2
- "SAVE $1.50 PER LB" on a $0.79/lb item -> 2.29
- For BOGO, regularPrice is the listed single-item price.
- "SAVE UP TO $X" and "SAVE UP TO 80¢" are ceilings advertised across a group of items, NOT this item's savings. Set regularPrice to null. Do NOT add the amount to salePrice. Do NOT treat it as an upper bound.
- Any hedged savings wording ("up to", "as much as", "save big") -> regularPrice is null.
- If the ad shows no reference price and no exact savings amount, set regularPrice to null. Do NOT guess. Do NOT copy salePrice.

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

    // Reject-at-the-boundary validation (dealRejectReason). Supersedes the older
    // null-salePrice-only filter: the Vision prompt instructs "if you cannot
    // determine a per-unit price, omit the row" and "name the product", but the
    // model returns unpriced rows, placeholder names, and bare category words
    // anyway. Those were previously written to deal_cache and filtered on every
    // read, which left them in deal_history permanently. Rejected rows are
    // logged individually so a bad OCR week is diagnosable from the run log.
    // Each rejection is emitted as one self-contained JSON object per line, so a
    // log export answers "what did we throw away and why" directly:
    //   grep '"evt":"DEAL_REJECT"' render.log | jq -r '[.store,.reason,.name,.salePrice]|@tsv'
    const rejectTally = {};
    const rejects = [];
    const keepTally = {};
    const keeps = [];
    // Held across the filter below: the OCR_QUALITY signal measures the raw
    // extraction, so it needs the rows as the model returned them, not the
    // survivors. `unique = unique.filter(...)` rebinds to a new array, so this
    // reference keeps pointing at the pre-rejection set.
    const preValidationRows = unique;
    const beforeValidate = unique.length;
    unique = unique.filter(d => {
      const reason = dealRejectReason(d);
      if (!reason) {
        const note = dealKeepNote(d);
        if (note) {
          keepTally[note] = (keepTally[note] || 0) + 1;
          keeps.push({
            evt: "DEAL_KEEP_NOTE", store: storeName, storeId, note,
            name: d?.name ?? null, salePrice: d?.salePrice ?? null,
            category: d?.category ?? null,
          });
        }
        return true;
      }
      rejectTally[reason] = (rejectTally[reason] || 0) + 1;
      const row = {
        evt: "DEAL_REJECT",
        store: storeName,
        storeId,
        reason,
        name: d?.name ?? null,
        salePrice: d?.salePrice ?? null,
        regularPrice: d?.regularPrice ?? null,
        unit: d?.unit ?? null,
        category: d?.category ?? null,
        promoText: d?.promoText ?? null,
        adPage: d?.adPage ?? null,
        adImage: d?.adImage ?? null,
      };
      rejects.push(row);
      console.log(JSON.stringify(row));
      return false;
    });
    if (rejects.length > 0) {
      console.warn(JSON.stringify({
        evt: "DEAL_REJECT_SUMMARY", store: storeName, storeId,
        rejected: rejects.length, of: beforeValidate, byReason: rejectTally,
      }));
    }

    // Logs are the wrong home for the only record of what OCR produced and we
    // refused to store: Render's retention is short, and by the time a chain
    // looks thin the run that thinned it has aged out. Park the batch in
    // deal_cache under an ad-reject: key — same table, no migration, sits
    // beside the ad-extract: row it corresponds to, and is reachable from SQL:
    //   select cache_key, fetched_at,
    //          jsonb_array_elements(data->'rows') ->> 'reason' as reason
    //   from deal_cache where cache_key like 'ad-reject:%';
    // No serving path reads this key, and setCachedDeals only marks a chain as
    // having deals for ad-extract: keys, so it cannot affect store listings.
    //
    // Written on EVERY invocation, clean runs and source-fetch failures alike
    // (see the images.length === 0 early return above). Writing only when
    // something was rejected would leave a stale batch sitting under a key whose
    // fetched_at nobody updated, so a chain that stopped rejecting would still
    // read as "these rows were rejected" — worse than no record. Here
    // rejected:0 with outcome:"validated" is the affirmative "last run was
    // clean"; on the failure path rejected:0 means nothing was ever validated.
    const MAX_STORED_REJECTS = 300;
    await setCachedDeals(`ad-reject:${storeId}`, {
      storeName, storeId,
      adSourceUrl: adUrl,
      rejectedAt: new Date().toISOString(),
      outcome: "validated",
      total: beforeValidate,
      rejected: rejects.length,
      byReason: rejectTally,
      truncated: rejects.length > MAX_STORED_REJECTS,
      rows: rejects.slice(0, MAX_STORED_REJECTS),
      // Rows we KEPT but flagged. Same key so the audit is one read, and the
      // byNote tally is what tells us whether the combo-tile carve-out is
      // earning its place or should be dropped.
      kept: { byNote: keepTally, rows: keeps.slice(0, MAX_STORED_REJECTS) },
    });

    // Inverted-price sanitation. OCR sometimes maps an adjacent item's compare-at
    // price onto this row, yielding regularPrice < salePrice. The sale price is
    // the reliably-anchored value — it's the large figure the ad layout is built
    // around — while the "reg" is small print that drifts between items. A wrong
    // regular price overstates savings and erodes trust, so drop the suspect
    // field rather than the row: the sale price is still worth showing.
    let priceInvertCount = 0;
    unique = unique.map(d => {
      const s = parseFloat(String(d.salePrice ?? "").replace(/[^0-9.]/g, ""));
      const r = parseFloat(String(d.regularPrice ?? "").replace(/[^0-9.]/g, ""));
      if (Number.isFinite(s) && Number.isFinite(r) && s > r) {
        priceInvertCount++;
        return { ...d, regularPrice: null };
      }
      return d;
    });
    if (priceInvertCount > 0) {
      console.warn(`PRICE_INVERT ${storeName}: ${priceInvertCount} of ${unique.length} rows had salePrice > regularPrice; regularPrice nulled, rows kept`);
    }

    // Extraction quality signal. A healthy OCR run carries per-unit info on most
    // rows. A high empty-unit rate means either the model is reading the pages
    // poorly or the rows did not come from the ad images at all — the text
    // fallback strips the layout entirely, and Meijer's fallback week ran 56 of
    // 58 rows unit-less while reporting "ready". Warn only; the threshold gets
    // tightened once there are a few weeks of signal behind it.
    //
    // Measured against the PRE-rejection rows on purpose. Anchoring it to the
    // survivors let the validation gate suppress the warning: 24 garbage rows
    // minus 6 rejections arrives at 18 and skips the >= 20 floor entirely, so
    // the worse the extraction, the quieter the signal — backwards for a health
    // check. Rejected rows are part of what the model produced, so they belong
    // in both the numerator and the denominator. The kept count is reported too,
    // since a large gap between the two is itself the interesting number.
    const emptyUnitCount = preValidationRows.filter(d => !String(d.unit ?? "").trim()).length;
    const emptyUnitPct = beforeValidate ? Math.round((emptyUnitCount / beforeValidate) * 100) : 0;
    if (beforeValidate >= 20 && emptyUnitPct > 50) {
      console.warn(`OCR_QUALITY ${storeName}: ${emptyUnitCount} of ${beforeValidate} extracted rows (${emptyUnitPct}%) have no unit; ${unique.length} kept after validation`);
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

// ── Deal row validation ─────────────────────────────────────────────────────
// These patterns began life inside curateChainDeals, filtering junk on every
// render. Filtering only on read meant the junk still landed in deal_cache:
// deal_history froze it into the permanent record, and any consumer that does
// not go through a curate* function saw it raw. The rules now also run once at
// the cache boundary in extract-store, so a row that can never be shown is
// never stored. curateChainDeals keeps applying them because Kroger rows reach
// it without passing through the extraction path.
// Word boundaries on foil/soap/flower are load-bearing now. As bare substrings
// they matched Cauliflower, Sunflower Oil, and Sunflower Seeds — real food that
// read-side filtering merely hid from chain pages. At write time the same match
// would delete those rows from deal_cache and from the deal_history record, so
// the ambiguous tokens are anchored before the pattern is used to reject.
const NON_FOOD_NAME = /paper towel|toilet|detergent|bleach|napkin|\bfoil\b|trash bag|cleaner|shampoo|\bsoaps?\b|diaper|batteries|charcoal|propane|\bflowers?\b|greeting card/i;
const JUNK_NAME = /price drop|low price|extra savings|see store|weekly ad/i;
// "assorted" and "varies" used to sit in JUNK_NAME as bare substrings, which
// rejected "Kellogg's Cereal, Assorted Flavors" — a real product at a real
// price. Both words are ordinary inside a product name and only junk when they
// ARE the name, so they match whole-name only: the row is ad boilerplate that
// reached the name field with no product in it.
const BOILERPLATE_ONLY_NAME = /^(?:assorted|varies|variety)(?:\s+(?:varieties|variety|flavors?|types?|sizes?|brands?|by\s+store|per\s+store))?\.?$/i;
// "Product 3", "Item 12", "Deal 4" — what the model emits when a tile carries a
// legible price but no legible product name.
const PLACEHOLDER_NAME = /^(?:product|item|deal|offer|sale item|unknown)\s*#?\s*\d*$/i;
// A bare category word is the category field leaking into the name. Anchored on
// both ends on purpose: "Meat" is not a product, "Meat Lovers Pizza" is.
const CATEGORY_ONLY_NAME = /^(?:meat|produce|dairy|bakery|frozen|pantry|snacks?|beverages?|deli|seafood|household|grocery|food|other|misc|assorted)$/i;


// ── weeklyad.us.com structured-table source ────────────────────────────────
// Some chains serve a server-rendered <table class="wa-products-table"> with
// Product / Brand / Price / Unit / Category columns. Where measurement shows it
// beats OCR (see TABLE_SOURCED), it is read directly: no flyer images, no Vision
// calls, and no decimal-drop class of error, since the numbers are text.

const TABLE_ROW_RE = /<tr class="wa-prod-row"[^>]*>([\s\S]*?)<\/tr>/g;
const TABLE_CELL_RE = /<td[^>]*>([\s\S]*?)<\/td>/g;
const stripCell = (s) => s
  .replace(/<[^>]*>/g, "")
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/\s+/g, " ").trim();

// A price cell that expresses a discount rather than a payable amount: "Buy 1
// Get 1 FREE", "5.00 Off", "$5 OFF", "20% off". These carry no absolute price
// and we refuse to invent one, so the row is rejected and the condition is kept
// for the reject log.
const NON_ABSOLUTE_PRICE = /\bfree\b|\bbogo\b|buy\s*\d*\s*get|\d\s*%\s*off|\boff\b/i;

// Prices contingent on quantity: "2 for $5", "3/$5", "2$5 for Member Price",
// "Mix & Match ... WHEN YOU BUY 6 OR MORE". The figure is a group total or a
// bulk rate, not what one item costs, and we do not divide to find out.
// Matched loosely on "for" because the source concatenates without spaces
// ("2$6forMember Price"); a price cell has no other reason to contain the word.
const MULTI_BUY = /for|\d\s*\/\s*\$?\d|when you buy|mix\s*&?\s*match/i;

// Unit tokens, read only where they actually appear. The source concatenates
// marketing text onto the price ("899Member Price"), so a naive "word after the
// number" rule produced units of "Member" and "Mix" on 50 Safeway rows.
function tableUnit(text) {
  if (/(?:^|[^a-z])(?:lbs?|pounds?)\b/i.test(text)) return "lb";
  return "";   // "ea"/"each" is the absence of a unit, like dealUnitInfo treats it
}

// Returns { salePrice, unit, promoText }. salePrice is null when the cell
// carries no payable amount.
//
// The source encodes prices four different ways and getting this wrong ships
// absurd numbers: "59¢" once parsed as $59.00, and Safeway writes its prices
// with no decimal at all, so "899Member Price" parsed as $899.00 on 59 of its
// 181 rows. Each form is matched explicitly rather than by grabbing the first
// number in the string.
function parseTablePrice(raw) {
  const text = stripCell(String(raw ?? ""));
  const none = { salePrice: null, unit: "", promoText: "" };
  if (!text) return none;
  if (NON_ABSOLUTE_PRICE.test(text)) return { salePrice: null, unit: "", promoText: text };
  if (MULTI_BUY.test(text)) return { salePrice: null, unit: "", promoText: text };

  const unit = tableUnit(text);
  const ok = (v) => (Number.isFinite(v) && v > 0 ? { salePrice: v.toFixed(2), unit, promoText: "" } : none);

  // 1. Cents: "59¢", "99¢ ea".
  const cents = text.match(/(\d{1,3})\s*¢/);
  if (cents) return ok(parseInt(cents[1], 10) / 100);

  // 2. Explicit decimal, with or without a currency symbol: "$8.99", "2.99 lb",
  //    "10.99lb.", "sale 2.99 lb.".
  const dec = text.match(/\$?\s*(\d+\.\d{1,2})(?!\d)/);
  if (dec) return ok(parseFloat(dec[1]));

  // 3. Whole dollars, explicitly marked: "$5 Member Price".
  const dollars = text.match(/\$\s*(\d+)(?!\d)/);
  if (dollars) return ok(parseInt(dollars[1], 10));

  // 4. No decimal and no currency symbol: the trailing two digits are cents.
  //    "899Member Price" -> 8.99, "2069Mix & Match" -> 20.69, "1299lb" -> 12.99.
  //    Bounded to 3-4 digits: every 1-2 digit bare cell in the corpus is a
  //    percent-off, already rejected above, and 5+ digits is not a grocery price.
  const bare = text.match(/^(\d{3,4})(?!\d)/);
  if (bare) return ok(parseInt(bare[1], 10) / 100);

  return { salePrice: null, unit: "", promoText: text };
}


const MONTHS_LONG = ["january","february","march","april","may","june","july","august","september","october","november","december"];
// "Valid 26 August - 1 September" / "Valid 23 August – 29 August 2026". The year
// is usually absent; it is taken from the capture date and rolled back a year if
// that would place the start in the future (a late-December ad running into
// January). Anything that does not parse cleanly yields nulls rather than a guess.
function parseTableValidity(html, now = new Date()) {
  const m = html.match(/valid\s+(\d{1,2})\s+([A-Za-z]+)\s*[–—-]\s*(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?/i);
  if (!m) return { adValidFrom: null, adValidTo: null };
  const mo1 = MONTHS_LONG.indexOf(String(m[2]).toLowerCase());
  const mo2 = MONTHS_LONG.indexOf(String(m[4]).toLowerCase());
  if (mo1 < 0 || mo2 < 0) return { adValidFrom: null, adValidTo: null };
  let year = m[5] ? parseInt(m[5], 10) : now.getUTCFullYear();
  let from = new Date(Date.UTC(year, mo1, parseInt(m[1], 10)));
  let to = new Date(Date.UTC(mo2 < mo1 ? year + 1 : year, mo2, parseInt(m[3], 10), 23, 59, 59));
  if (!m[5] && from.getTime() - now.getTime() > 180 * 864e5) {
    from = new Date(Date.UTC(year - 1, mo1, parseInt(m[1], 10)));
    to = new Date(Date.UTC(mo2 < mo1 ? year : year - 1, mo2, parseInt(m[3], 10), 23, 59, 59));
  }
  return { adValidFrom: from.toISOString(), adValidTo: to.toISOString() };
}

// Rows in the shape the OCR path emits, so both feed the same validation gate.
function parseWeeklyAdTable(html) {
  const out = [];
  for (const match of html.matchAll(TABLE_ROW_RE)) {
    const cells = [...match[1].matchAll(TABLE_CELL_RE)].map(c => stripCell(c[1]));
    const name = cells[0] || "";
    if (!name) continue;
    const { salePrice, unit, promoText } = parseTablePrice(cells[2]);
    out.push({
      name,
      brand: cells[1] || "",
      salePrice,
      unit: unit || cells[3] || "",
      regularPrice: null,
      category: cells[4] || "",
      promoText: promoText || "",
    });
  }
  return out;
}


// ---------------------------------------------------------------------------
// Non-food category exclusion (write time).
//
// The extraction taxonomy cannot carry this filter. The Vision prompt offers
// meat/produce/dairy/bakery/frozen/pantry/snacks/beverages/deli/seafood/
// household/other and has no bucket for alcohol, merchandise, gift cards, pet,
// HBA, or floral -- so scotch lands in "beverages", a gift card and an electric
// wheelchair both land in "other", and an air fryer lands in "household". The
// two catch-alls are not safely rejectable either: "other" also holds Boneless
// Wings, Coffee Mate Creamer and Gerber entrees. So these match on NAME, and
// d.category is deliberately not consulted.
const MERCH_NAME = /\b(?:air fryer(?! ready)|toaster oven|microwave oven|refrigerator|air conditioner|dehumidifier|humidifier|vacuum cleaner|television|headphones?|earbuds?|laptop|gazebo|patio set|lawn mower|charcoal grill|gas grill|grill combo|furniture|mattress|recliner|stroller|wheelchair|bicycle|bike helmet|toys?|hot wheels|lego|trading cards?|action figure|backpacks?|school supplies|crayons?|t-?shirts?|sneakers|bedding|comforter|towel set|serveware|utensil set|storage (?:container|basket)|food container set|mason jars?|decorative|wreath|vase|picture frame|light bulb)\b/i;
const GIFTCARD_NAME = /\bgift ?card|prepaid card|stored[- ]value\b/i;
const FLORAL_NAME = /\b(?:bouquet|floral arrangement|rose bunch|\broses\b|tulips?|orchid|carnation|potted plant|houseplant|succulent|mulch|potting soil|seed packet)\b/i;
// Pet requires explicit pet context. A bare \bdog\b / \bcat\b rejected Ball Park
// Beef Hot Dogs, Corn Dogs, and Hot Dog Buns off the live corpus.
const PET_NAME = /\b(?:dog|cat|puppy|kitten|pet)\s+(?:food|treats?|chow|biscuits?|litter|toy|bed|bowl|collar|leash|supplies)\b|\bcat litter\b|\b(?:milk[- ]bone|greenies|pedigree|purina|friskies|meow mix|iams|blue buffalo|rawhide|pig ears?)\b/i;
// "vitamins?" is negative-lookahead'd off Vitamin Water, which is a beverage.
// Similac / PediaSure / Gerber / Enfamil are consumable nutrition and are
// deliberately absent from this pattern -- they must survive to reach recipes.
const HBA_NAME = /\b(?:shampoo|conditioner|body wash|deodorant|antiperspirant|toothpaste|toothbrush|mouthwash|floss(?:ers?)?|razors?|shave|lotion|moisturizer|micellar|toner|cleanser|sunscreen|tampons?|maxi pads|diapers?|pull[- ]ups|vitamins?(?! water)|multivitamin|ibuprofen|acetaminophen|aspirin|antacid|claritin|allegra|zyrtec|advil|tylenol|cold medicine|bandages?|band[- ]aid|first aid|cortisone|icy hot|aspercreme|nasacort|selsun|unisom|one a day|flintstones|aquaphor|cetaphil|colgate|crest|ogx|got2b|thayers|kotex|playtex)\b/i;
const CLEAN_NAME = /\b(?:paper towels?|bath tissue|toilet paper|toilet bowl|napkins?|paper plates?|plastic (?:cutlery|wrap)|trash bags?|garbage bags?|detergent|fabric softener|dryer sheets?|bleach|disinfect(?:ing|ant)|lysol|clorox|dish soap|sponges?|scrubber|charmin|bounty|quilted northern|cottonelle|\btide\b|downy|oxiclean|swiffer|air freshener|febreze|candles?)\b/i;

// Alcohol and tobacco. Regulated advertising, so this group is handled by
// segment (below) rather than by a whole-name match: it must never release an
// actual bottle, can, or pack.
const ALCOHOL_NAME = /\b(?:scotch|whisk(?:e)?y|bourbon|tequila|vodka|\brum\b|brandy|cognac|liqueur|schnapps|lager|\bipa\b|hard seltzer|hard cider|malt beverage|wine(?!\s+vinegar)|champagne(?!\s+grapes)|prosecco|chardonnay|cabernet|merlot|pinot|sauvignon|don julio|jack daniel|captain morgan|smirnoff|bud ?light|budweiser|michelob|heineken|modelo|\bcorona\b|stella artois|guinness|coors|miller lite|busch|pabst|yuengling|blue moon|angry orchard|mike's hard|white claw|twisted tea|happy dad|truly)\b|\bbeer\b|\bales?\b|\bcigarettes?\b|tobacco|\bvape\b|nicotine|\bcigars?\b/i;

// An edible noun beside the match means the brand is being used as a flavour,
// not sold as itself: Jack Daniel's Sausage Links, bourbon-glazed salmon.
const EDIBLE_VETO = /\b(?:sausages?|brats?|bratwurst|links?|salmon|cod|tilapia|shrimp|chicken|beef|pork|turkey|steak|ribs?|bacon|jerky|buns?|sauces?|marinade|mustard|dip|cheese|wings|popcorn|cake|pie|ice cream|coffee|creamer|chocolate|entr[eé]e|ready)\b/i;
const CULINARY_USE = /\b(?:glazed?|battered|braised|infused|marinated|smoked|seasoned|flavou?red|barbecue|bbq|style)\b/i;
const FOODY_SEGMENT = /\b(?:chicken|beef|pork|cheese|milk|bread|cereal|pasta|rice|apple|banana|salad|soup|sauce|juice|coffee|snack|cookie|pizza|sandwich|wings|yogurt|egg|butter|fruit|vegetable)\b/i;
// Ad tiles list several products in one name: "White Castle, Twisted Tea, Bare
// Republic or Snapple Beverages". Splitting lets one brand be judged without
// condemning the other three.
const SEGMENT_SPLIT = /\s*(?:,|\bor\b|\band\b|&|\/)\s*/i;

// Returns {reject: reason} | {keep: note} | {}.
function classifyNonFood(name) {
  const segments = String(name).split(SEGMENT_SPLIT).map(s => s.trim()).filter(Boolean);

  // Alcohol first, and exempt from the combo-tile keep below. The veto releases
  // a bourbon glaze but never a bottle: it is applied per segment, so "Bell's
  // Beer or Fresh from Meijer Brats" still rejects on its first segment even
  // though "Brats" appears later in the name.
  const alcoholSegments = segments.filter(s => ALCOHOL_NAME.test(s));
  if (alcoholSegments.length) {
    const standalone = alcoholSegments.filter(s => !EDIBLE_VETO.test(s) && !CULINARY_USE.test(s));
    if (standalone.length) {
      return { reject: segments.length >= 2 ? "alcohol in combo tile" : "alcohol" };
    }
  }

  const groups = [
    ["gift card", GIFTCARD_NAME],
    ["pet", PET_NAME],
    ["health and beauty", HBA_NAME],
    ["cleaning and paper goods", CLEAN_NAME],
    ["general merchandise", MERCH_NAME],
    ["floral and plants", FLORAL_NAME],
  ];
  for (const [reason, re] of groups) {
    if (!re.test(name)) continue;
    if ((reason === "general merchandise" || reason === "floral and plants") && EDIBLE_VETO.test(name)) continue;
    // Multi-product tile carrying real food alongside the match: keep the row
    // and log why, rather than losing the food. Alcohol never reaches here.
    if (segments.length >= 3 && segments.some(s => FOODY_SEGMENT.test(s))) {
      return { keep: `combo tile kept (${reason})` };
    }
    return { reject: reason };
  }
  return {};
}

// Note attached to a row that was KEPT but is worth measuring. Null for the
// ordinary case.
function dealKeepNote(d) {
  const name = String(d?.name ?? "").trim();
  if (!name) return null;
  return classifyNonFood(name).keep || null;
}

// Returns null when the row is storable, otherwise a short reason string.
// Deliberately does NOT enforce curateChainDeals' salePrice < 40 ceiling: that
// is a display-ranking judgement, and a $45 meat bundle is a real deal worth
// keeping in cache even when it never surfaces on a chain page.
function dealRejectReason(d) {
  const name = String(d?.name ?? "").trim();
  if (!name) return "empty name";
  if (name.length <= 2) return "name too short";
  if (PLACEHOLDER_NAME.test(name)) return "placeholder name";
  if (CATEGORY_ONLY_NAME.test(name)) return "bare category as name";
  const nonFood = classifyNonFood(name);
  if (nonFood.reject) return nonFood.reject;
  // NON_FOOD_NAME stays as a backstop: it still carries charcoal, propane,
  // greeting card and diaper, and curateChainDeals shares it for Kroger rows,
  // which never pass through this write path.
  if (NON_FOOD_NAME.test(name)) return "non-food";
  if (JUNK_NAME.test(name)) return "junk phrase";
  if (BOILERPLATE_ONLY_NAME.test(name)) return "ad boilerplate as name";
  const raw = d?.salePrice;
  // A table row whose price cell states a discount rather than a payable amount
  // ("Buy 1 Get 1 FREE", "$5 Off"). It is rejected like any unpriced row, but
  // under its own reason so the volume stays measurable, and promoText rides
  // into the ad-reject: row. The shared gate is NOT relaxed: nothing with a null
  // salePrice is stored, on this path or the OCR one.
  if ((raw == null || String(raw).trim() === "") && d?.promoText) return "promo without absolute price";
  if (raw == null || String(raw).trim() === "") return "empty salePrice";
  const sale = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(sale) || sale <= 0) return "zero or unparseable salePrice";
  return null;
}

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
      const pct = isBogoRow(d) ? 0 : Number(d.pctOff) > 0
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
      d._pct > 0 && d._pct <= MAX_PLAUSIBLE_PCT_OFF &&
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
// Shared deal classifier. Used by BOTH the SSR chain bundles and the homepage
// preview bundle so their recipe pools can't drift apart. Order matters: protein
// and vegetable are checked BEFORE fruit, so "Bacon Applewood Smoked" and "Grape
// Tomatoes" don't get misclassified as fruit.
function dealBucket(d) {
  const c = (d.category || "").toLowerCase();
  const n = (d.name || "").toLowerCase();
  if (/snack|candy|cookie|chip|cracker|soda|beverage|dessert/.test(c) ||
      /chips?|crackers?|cookie|candy|soda|little debbie|frito|ritz|goldfish|doritos|oreo/.test(n)) return "snack";
  if (/beef|pork|chicken|turkey|meat|poultry|seafood|fish|lamb|bison/.test(c) ||
      /\b(beef|pork|chicken|turkey|sausage|bacon|steak|shrimp|salmon|chop|brisket|ribeye|wing|ground|scallop|tilapia|cod)\b/.test(n)) return "protein";
  if (/vegetable|produce/.test(c) ||
      /\b(corn|broccoli|squash|zucchini|pepper|tomato|potato|onion|carrot|lettuce|cucumber|greens|spinach|cabbage|celery|mushroom|asparagus|green bean)\b/.test(n)) return "vegetable";
  if (/fruit/.test(c) ||
      /\b(grape|apple|melon|watermelon|berry|berries|blueberr|strawberr|peach|plum|nectarine|mango|pineapple|mandarin|orange|banana|pear|cherry|cherries)\b/.test(n)) return "fruit";
  if (/dairy|egg|cheese|milk|butter|yogurt/.test(c) ||
      /\b(egg|cheese|milk|butter|yogurt|cream)\b/.test(n)) return "dairy";
  if (/pasta|rice|grain|bean|pantry|bread|condiment|sauce|canned/.test(c) ||
      /\b(pasta|rice|beans|tortilla|bread|broth|stock)\b/.test(n)) return "pantry";
  return "other";
}

function curateChainDeals(raw, limit) {
  if (!raw || !raw.length) return [];
  // Patterns now live at module scope (NON_FOOD_NAME / JUNK_NAME) so extract-store
  // rejects on the same rules at write time. Kroger rows never pass through
  // that path, so this read-side pass stays.
  const clean = raw
    .map(d => {
      const s = parseFloat(String(d.salePrice || "").replace(/[^0-9.]/g, ""));
      const r = parseFloat(String(d.regularPrice || "").replace(/[^0-9.]/g, ""));
      // Plausibility guard, matching the homepage preview (curateFreshDeals). A
      // regular price more than 2.5x the sale price is almost always a per-each
      // vs per-pound error in the source feed ("Black Plums, Each: $0.76, was
      // $2.50" = 70% off). The SALE price is still real and worth showing — we
      // just refuse to make the suspect discount claim, so we zero the percent
      // AND drop the struck-through regular price.
      const plausible = Number.isFinite(r) && r > s && r > 0 && r <= s * 2.5;
      const rawPct = isBogoRow(d) ? 0 : Number(d.pctOff) > 0
        ? Number(d.pctOff)
        : (plausible ? Math.round(((r - s) / r) * 100) : 0);
      const pct = (rawPct > 0 && rawPct <= MAX_PLAUSIBLE_PCT_OFF && plausible) ? rawPct : 0;
      return { ...d, _sale: s, _reg: plausible ? r : null, _pct: pct };
    })
    .filter(d =>
      d.name && d.name.trim().length > 2 &&
      !PLACEHOLDER_NAME.test(d.name.trim()) && !CATEGORY_ONLY_NAME.test(d.name.trim()) &&
      !BOILERPLATE_ONLY_NAME.test(d.name.trim()) &&
      Number.isFinite(d._sale) && d._sale > 0 && d._sale < 40 &&
      !NON_FOOD_NAME.test(d.name) && !JUNK_NAME.test(d.name)
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

  // Reserve slots per category. A pure cookScore sort floods the pool with
  // protein on meat-heavy chains (Walmart came back 15/15 meat), which makes
  // the page read like a butcher counter and leaves the recipe generator with
  // no sale produce to cook with. Protein still anchors the dinners; produce,
  // dairy, and pantry get guaranteed representation.
  // Slot budget (sums to `limit` at the default 15): protein anchors, produce
  // supports, dairy/pantry round it out. Snacks get nothing unless we'd
  // otherwise come up short.
  const budget = {
    protein:   Math.max(1, Math.round(limit * 0.40)),  // 6 of 15 — anchors the dinners
    vegetable: Math.max(1, Math.round(limit * 0.27)),  // 4 of 15 — real dinner ingredients
    dairy:     Math.max(1, Math.round(limit * 0.13)),  // 2 of 15
    pantry:    Math.max(1, Math.round(limit * 0.07)),  // 1 of 15
    fruit:     Math.max(1, Math.round(limit * 0.13)),  // 2 of 15 — shown, not cooked
  };

  const byBucket = {};
  for (const d of clean) {
    const b = dealBucket(d);
    (byBucket[b] = byBucket[b] || []).push(d);
  }
  for (const b in byBucket) byBucket[b].sort((a, z) => cookScore(z) - cookScore(a));

  const out = [];
  const seen = new Set();
  const take = (d) => {
    const k = (d.name || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    // Tag the bucket so downstream consumers (the recipe pool) can filter on the
    // SAME classification instead of re-running a raw regex — dealBucket checks
    // protein/vegetable before fruit, so "Bacon Applewood" and "Grape Tomatoes"
    // classify correctly.
    out.push({ ...d, _bucket: dealBucket(d) });
    return true;
  };

  // 1) Fill each category up to its slot budget.
  for (const b of ["protein", "vegetable", "dairy", "pantry", "fruit"]) {
    let taken = 0;
    for (const d of (byBucket[b] || [])) {
      if (taken >= budget[b] || out.length >= limit) break;
      if (take(d)) taken++;
    }
  }
  // 2) Backfill any unused slots from real food (never snacks), best-scoring first.
  if (out.length < limit) {
    const rest = [];
    for (const b of ["protein", "vegetable", "dairy", "pantry", "fruit", "other"]) {
      for (const d of (byBucket[b] || [])) rest.push(d);
    }
    rest.sort((a, z) => cookScore(z) - cookScore(a));
    for (const d of rest) {
      if (out.length >= limit) break;
      take(d);
    }
  }
  // 3) Last resort only: if a chain is so thin we still can't fill the grid,
  //    allow up to 2 snack items rather than render an empty-looking page.
  if (out.length < limit) {
    let snackCount = 0;
    for (const d of (byBucket["snack"] || [])) {
      if (out.length >= limit || snackCount >= 2) break;
      if (take(d)) snackCount++;
    }
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
// weeklyAdSourced marks a chain whose rows are OCR'd from the pages of the
// printed weekly ad. ALDI's are. Kroger's are not: they come from the Products
// API filtered to items carrying a current promotional price, which overlaps
// the ad but is not the same set and is never verified against it. The page
// copy branches on this so Kroger is not described as an ad it may not match.
export const SSR_CHAINS = {
  kroger: { label: "Kroger", weeklyAdSourced: false, cacheKeys: () => [`kroger:${PREVIEW_KROGER_LOCATION}`] },
  aldi:   { label: "ALDI",   weeklyAdSourced: true,  cacheKeys: () => ["aldi:national", "ad-extract:aldi"] },
};

// TWIN OF dealUnitInfo() IN public/app.js — keep the two in sync.
// Not shared because public/app.js is a plain browser script served statically,
// not an ESM module this file can import; extracting it to lib/ would mean
// shipping a module to the client just for one function.
//
// The Kroger path emits a display-ready `priceUnit` ("/lb", "/ea", ""), while
// ad-extract/OCR rows carry the raw flyer field `unit` ("lb", "per lb", "each",
// "12 pk"). A non-empty priceUnit is returned untouched so Kroger stays exactly
// as it was — notably "/ea", which must NOT collapse the way a raw "each" does.
function dealUnitInfo(d) {
  const pre = d && d.priceUnit != null ? String(d.priceUnit) : "";
  if (pre !== "") return { unit: pre, isPerLb: !!(d && d.isPerLb) || pre === "/lb" };

  const raw = d && d.unit != null ? String(d.unit).trim() : "";
  if (!raw) return { unit: "", isPerLb: !!(d && d.isPerLb) };
  // "each"/"ea" is the absence of a unit, not a suffix worth printing.
  if (/^(?:each|ea)\.?$/i.test(raw)) return { unit: "", isPerLb: !!(d && d.isPerLb) };
  // lb shapes: "lb", "lbs", "per lb", "/lb", "pound", "per pound", trailing dot ok.
  if (/^(?:\/|per\s+)?(?:lb|lbs|pound|pounds)\.?$/i.test(raw)) return { unit: "/lb", isPerLb: true };
  // Anything else prints as-is behind a slash: "pint" -> "/pint".
  return { unit: "/" + raw, isPerLb: !!(d && d.isPerLb) };
}

// The condition attached to a price, or "" when the price stands alone.
//
// TWIN OF promoConditionText() IN public/app.js — keep the two in sync, for the
// same reason dealUnitInfo is twinned: app.js is a plain browser script, not a
// module this file can import from.
//
// promoText is the store's own wording and wins when present. Otherwise the
// OCR dealType decides. Only bogo and free are labelled: the price on those is
// contingent on taking more than one, so showing it bare misstates what one
// item costs. percent_off is deliberately NOT labelled -- its price is simply
// the marked-down price of a single item, and the % badge already says so.
function promoConditionText(d) {
  const promo = String(d?.promoText ?? "").trim();
  if (promo) return promo;
  const type = String(d?.dealType ?? "").trim().toLowerCase();
  if (type === "bogo") return "Buy 1 Get 1 Free";
  if (type === "free") return "Free item offer";
  return "";
}

// Display unit for a row that came out of a cached SSR bundle. Bundles cached
// before priceUnit was carried through hold only isPerLb, so fall back to that
// rather than dropping the "/lb" Kroger rows already show.
function bundleUnitText(d) {
  return dealUnitInfo(d).unit || (d && d.isPerLb ? "/lb" : "");
}

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

  // Deals shown on the page: up to 15 curated items (includes fruit — real deals
  // people want to see on a weekly-ad page).
  const deals = curateChainDeals(raw, 15);
  if (!deals.length) return null;

  // Recipe pool: the SAVORY subset. Fruit is excluded — when a chain's produce
  // allocation is all fruit (Kroger and ALDI both were), handing it to the
  // generator produces "Pulled Pork Sandwiches with Bacon & Grapes". Fruit is
  // for the page, not the dinner.
  // Filter on the bucket assigned during curation, NOT a raw name regex. A raw
  // regex matched "apple" inside "Bacon Applewood Smoked" and "grape" inside
  // "Grape Tomatoes", silently dropping a protein and a vegetable from the pool.
  const recipePool = deals.filter(d => d._bucket !== "fruit");
  const genPool = recipePool.length >= 4 ? recipePool : deals; // safety: never send an empty pool

  // Recipe pool: the same curated set (generation picks from it).
  const base = process.env.PUBLIC_BASE_URL || "https://dishcount.co";
  let recipes = [];
  try {
    const rr = await fetch(`${base}/api/recipes/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": process.env.INTERNAL_API_TOKEN },
      body: JSON.stringify({
        ingredients: genPool.map(d => ({
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
    deals: deals.map(d => {
      // Resolve the unit HERE, at the point the bundle is built, because this
      // map is what drops the raw `unit` field — the renderers downstream only
      // ever see what this object carries.
      const u = dealUnitInfo(d);
      return {
        name: d.name, salePrice: d._sale, regularPrice: d._reg,
        pctOff: d._pct, image: d.image || null, category: d.category || "",
        isPerLb: u.isPerLb, priceUnit: u.unit,
        // Carried so a conditional price can be labelled at render. dealType has
        // been collected on every row for months and displayed nowhere, which is
        // how 110 live B1G1 rows came to show a halved per-unit price with no
        // sign it needs two. adValid* ride along for the same reason: the data
        // exists and this map is where it was being thrown away.
        promoText: d.promoText || "", dealType: d.dealType || "",
        adValidFrom: d.adValidFrom || null, adValidTo: d.adValidTo || null,
      };
    }),
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
    // Savory subset for the recipe generator. Fruit stays in the displayed cards
    // (real deals worth showing) but must not go into a savory dinner — without
    // this the generator produced "Sausage & Scallop Pasta with Grapes".
    const savory = pool.filter(d => dealBucket(d) !== "fruit");
    const genPool = savory.length >= 4 ? savory : pool;
    if (!pool.length) return res.json({ ok: false, reason: "no fresh deals" });

    // 3. Generate one dinner recipe from the pool via the internal recipe path.
    const base = process.env.PUBLIC_BASE_URL || "https://dishcount.co";
    let recipe = null;
    try {
      const rr = await fetch(`${base}/api/recipes/ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-token": process.env.INTERNAL_API_TOKEN },
        body: JSON.stringify({
          ingredients: genPool.map(d => ({
            name: d.name, category: d.category, salePrice: d.salePrice,
            regularPrice: d.regularPrice, savings: "", storeName: "Kroger",
            isPerLb: !!d.isPerLb, priceUnit: d.priceUnit || "",
          })),
          style: "Dinner", mealType: "Dinner", diets: [],
          mealRequest: "Create ONE realistic weeknight dinner from these sale items. CRITICAL RULES: (1) It must be a coherent dish a real family would actually eat. (2) Only combine sale items that genuinely belong together in one dish. (3) Do NOT force unrelated items into the recipe just because they are on sale. (4) It is fine to use only 2 or 3 of the sale items plus common pantry staples. (5) Center the dinner on one protein.",
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

        // Featured-recipe writer (Model B): give each generated recipe a permanent page.
        // Insert-only (ignoreDuplicates) so hand-seeded/curated rows are never overwritten.
        const _saleWeek = new Date(bundle.generatedAt || Date.now()).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
        const _slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
        for (const _r of bundle.recipes) {
          const _rslug = _slugify(_r.title);
          if (!_rslug) continue;
          try {
            await supabase.from("weekly_featured_recipes").upsert(
              { slug: `${slug}-${_rslug}`, chain: slug, recipe: { ..._r, saleWeek: _saleWeek } },
              { onConflict: "slug", ignoreDuplicates: true }
            );
          } catch (_e) { console.error(`featured-recipe upsert failed for ${slug}-${_rslug}:`, _e.message); }
        }
        results[slug].featured = bundle.recipes.map(r => `${slug}-${_slugify(r.title)}`);
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

// ══ SSR CHAIN PAGE ═══════════════════════════════════════════════════════════
// Server-rendered weekly-deals page per chain. Crawlable HTML built from the
// cached bundle — the deals and recipes are in the source, not fetched by JS,
// which is the entire point (the SPA is invisible to search).
const _esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Builds the chain-link portion of the "More weekly ads" SEO cross-link nav,
// derived from SSR_CHAINS so future chains appear automatically. excludeSlug:
// the chain to omit (a chain page shouldn't link to itself; the hub passes null
// so all chains appear). Each call site wraps this in its own nav element and
// appends its own literal blog-link tail.
function chainCrossLinks(excludeSlug) {
  return Object.keys(SSR_CHAINS)
    .filter(s => s !== excludeSlug)
    .map(s => `<a href="/deals/${s}">${_esc(SSR_CHAINS[s].label)} weekly ad &amp; dinner ideas</a>`)
    .join(" &middot; ");
}

// One honest paragraph per chain, in Bill's voice. Only chains he actually shops.
const CHAIN_NOTES = {
  kroger: "Kroger's ad runs Wednesday to Tuesday, and the meat counter is where the real money is. Their weekly digital coupons stack on top of the sale price, so it's worth clipping them in the app before you go. Prices here are from the Dayton division. Kroger prices vary by region, so what you see is representative, not a promise for your store.",
  aldi: "ALDI's ad turns over Wednesday and the produce deals are usually the best of it. Prices are the same nationally, so what you see here is what you'll pay. The catch is that ALDI's weekly specials are limited stock. If something good is in the ad, go early in the week.",
};

// Only these hosts serve REAL product photos. ALDI's OCR pipeline attaches
// Unsplash stock images, which are not the actual product — showing them as
// product photos would be misleading, so those cards render text-only.
const PRODUCT_IMAGE_HOSTS = /^https:\/\/www\.kroger\.com\/product\/images\//i;
const isProductPhoto = (url) => !!url && PRODUCT_IMAGE_HOSTS.test(String(url));

function renderChainPage(bundle) {
  const label = bundle.label;
  const slug = bundle.chain;
  const when = new Date(bundle.generatedAt || Date.now());
  const dateStr = when.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });

  const dealCards = bundle.deals.map(d => {
    const reg = d.regularPrice && d.regularPrice > d.salePrice
      ? `<span class="cd-reg">$${Number(d.regularPrice).toFixed(2)}</span>` : "";
    const pct = (d.pctOff && !isBogoRow(d)) ? `<span class="cd-pct">${d.pctOff}% off</span>` : "";
    const unitText = bundleUnitText(d);
    // Rendered under the price, not beside it: the condition qualifies the
    // number and must not be readable apart from it.
    const condText = promoConditionText(d);
    const cond = condText ? `<div class="cd-cond">${_esc(condText)}</div>` : "";
    // Escaped now that the text can be arbitrary OCR ("12 pk"), not a literal "/lb".
    const unit = unitText ? ` <span class="cd-unit">${_esc(unitText)}</span>` : "";
    const img = isProductPhoto(d.image)
      ? `<img class="cd-img" src="${_esc(d.image)}" alt="${_esc(d.name)}" loading="lazy" onerror="this.style.display='none'" />`
      : "";
    return `<div class="cd-card${img ? " cd-card-img" : ""}">
      ${pct}
      ${img}
      <div class="cd-name">${_esc(d.name)}</div>
      <div class="cd-price">$${Number(d.salePrice).toFixed(2)}${unit} ${reg}</div>
      ${cond}
    </div>`;
  }).join("\n");

  const _recipeMeta = (r) => [r.time, r.servings ? `serves ${r.servings}` : "", r.costPerServing ? `$${Number(r.costPerServing).toFixed(2)}/serving` : ""].filter(Boolean).join(" &middot; ");
  const _recipeUses = (r) => (r.usedSaleItems || []).slice(0, 4).map(n => _esc(n.split(",")[0])).join(", ");

  // Hero recipe: the lead. Deals are a commodity — every coupon site has them.
  // The dinner built from them is the only thing here nobody else has, so it
  // goes first. IMPORTANT: it carries .cr-card and is FIRST in document order,
  // so the modal script's index (0) still maps to bundle.recipes[0].
  const hero = bundle.recipes[0];
  const heroCard = hero ? `<article class="cr-card cr-hero" data-recipe-index="0">
      ${hero.image ? `<img class="crh-img" src="${_esc(hero.image)}" alt="${_esc(hero.title)}" />` : ""}
      <div class="crh-body">
        <div class="crh-eyebrow">Tonight's dinner from this week's ad</div>
        <h2 class="crh-title">${_esc(hero.title)}</h2>
        <div class="crh-meta">${_recipeMeta(hero)}</div>
        ${_recipeUses(hero) ? `<div class="crh-uses">Built from ${_recipeUses(hero)}, all on sale this week.</div>` : ""}
        <div class="crh-go">See the full recipe &rarr;</div>
      </div>
    </article>` : "";

  // The remaining dinners, below the deals. Indexes continue from 1 so the
  // modal script's document-order indexing stays correct.
  const recipeCards = bundle.recipes.slice(1).map((r, idx) => {
    const i = idx + 1;
    const img = r.image ? `<img class="cr-img" src="${_esc(r.image)}" alt="${_esc(r.title)}" loading="lazy" />` : "";
    return `<article class="cr-card" data-recipe-index="${i}">
      ${img}
      <div class="cr-body">
        <h3 class="cr-title">${_esc(r.title)}</h3>
        <div class="cr-meta">${_recipeMeta(r)}</div>
        ${_recipeUses(r) ? `<div class="cr-uses">Uses ${_recipeUses(r)} from this week's ad.</div>` : ""}
      </div>
    </article>`;
  }).join("\n");

  // schema.org Recipe for each dinner — eligible for Google recipe rich results.
  const recipeSchema = bundle.recipes.map(r => ({
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: r.title,
    ...(r.image ? { image: [r.image] } : {}),
    author: { "@type": "Organization", name: "Dishcount" },
    description: `A dinner built from this week's ${label} sale items.`,
    recipeCategory: "Dinner",
    ...(r.servings ? { recipeYield: `${r.servings} servings` } : {}),
    recipeIngredient: (r.ingredients || []),
    recipeInstructions: (r.instructions || []).map(s => ({ "@type": "HowToStep", text: s })),
  }));
  const schemaBlocks = recipeSchema
    .map(s => `<script type="application/ld+json">${JSON.stringify(s)}</script>`)
    .join("\n  ");

  const note = CHAIN_NOTES[slug] || "";
  const fromAd = SSR_CHAINS[slug]?.weeklyAdSourced !== false;
  const title = fromAd
    ? `${label} Weekly Ad: Featured Deals & Dinner Ideas for ${dateStr} | Dishcount`
    : `${label} Deals: Current Promotions & Dinner Ideas for ${dateStr} | Dishcount`;
  const desc = fromAd
    ? `This week's ${label} deals plus ${bundle.recipes.length} dinners you can build from them, with real prices and cost per serving. Updated weekly. Free, no signup.`
    : `${label}'s current promotional prices plus ${bundle.recipes.length} dinners you can build from them, with real prices and cost per serving. Updated weekly. Free, no signup.`;
  const eyebrowText = fromAd ? "Weekly Ads" : `${label} Deals`;
  const introLine = fromAd
    ? `Updated ${_esc(dateStr)}. Here are this week's best ${_esc(label)} deals and ${bundle.recipes.length} dinners you can build from them.`
    : `Updated ${_esc(dateStr)}. Here's what's on promotion at ${_esc(label)} right now, and ${bundle.recipes.length} dinners you can build from them.`;
  const featuredHeading = fromAd
    ? `Featured ${_esc(label)} deals this week`
    : `${_esc(label)} items on promotion now`;
  const moreDinnersHeading = fromAd ? "More dinners from this week's ad" : "More dinners from these deals";
  const footSourceLine = fromAd
    ? `Prices are from the current ${_esc(label)} ad and may vary by store.`
    : `Prices are current promotional prices at ${_esc(label)} and may vary by store.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${_esc(title)}</title>
  <meta name="description" content="${_esc(desc)}">
  <link rel="canonical" href="https://dishcount.co/deals/${_esc(slug)}">
  <meta property="og:title" content="${_esc(title)}">
  <meta property="og:description" content="${_esc(desc)}">
  <meta property="og:type" content="article">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.min.css">
  ${schemaBlocks}
  <style>
    /* The site header (.landing-nav) is position:fixed at ~66-70px tall. Without
       this padding the top of the page renders underneath it. */
    body { font-family: 'DM Sans', sans-serif; background: var(--cream, #fffdf7); color: var(--text, #2d2a24); margin: 0; padding-top: 70px; line-height: 1.6; }
    /* This block is a DIV, not a HEADER, on purpose. styles.min.css has five global
       'header' rules including a display:none AND a mobile display:flex!important,
       which hid this block entirely and then laid it out sideways on phones. A div
       is immune to all of them. Keep display:block as belt-and-braces. */
    .cp-hero { display: block; background: var(--dark, #1a2e1f); color: #e8f0ea; padding: 32px 20px 28px; }
    .cp-wrap { max-width: 860px; margin: 0 auto; padding: 0 20px; }
    .cp-eyebrow { font-size: 12px; letter-spacing: 0.6px; color: #8fb89a; text-transform: uppercase; }
    .cp-hero h1 { font-family: 'Outfit', sans-serif; font-size: 28px; font-weight: 700; color: #fff; margin: 8px 0 6px; line-height: 1.2; }
    .cp-hero p { color: #c8d6cb; font-size: 15px; margin: 0; }
    .cp-section { padding: 28px 0 0; }
    .cp-section h2 { font-family: 'Outfit', sans-serif; font-size: 20px; font-weight: 700; color: var(--green-dark, #1a2e1f); margin: 0 0 12px; }
    .cd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; }
    .cd-card { position: relative; background: #fff; border: 1px solid #EDE6D4; border-radius: 12px; padding: 12px 12px 10px; }
    .cd-pct { position: absolute; top: 8px; right: 8px; background: var(--orange, #d97706); color: #fff; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 6px; }
    .cd-cond { font-size: 12px; font-weight: 700; color: var(--orange, #d97706); margin-top: 2px; }
    .cd-img { width: 100%; height: 120px; max-height: 120px; object-fit: contain; background: #fff; display: block; padding: 6px 0 8px; box-sizing: border-box; }
    .cd-name { font-size: 13px; font-weight: 600; line-height: 1.3; padding-right: 44px; min-height: 34px; }
    .cd-price { margin-top: 6px; font-size: 17px; font-weight: 800; color: var(--green-dark, #1a2e1f); }
    .cd-reg { font-size: 12px; font-weight: 400; color: #999; text-decoration: line-through; margin-left: 4px; }
    .cd-unit { font-size: 12px; font-weight: 600; color: #666; }
    .cr-card { display: flex; gap: 14px; background: #fff; border: 1px solid #EDE6D4; border-radius: 14px; overflow: hidden; margin-bottom: 10px; }
    .cr-img { width: 120px; height: 110px; object-fit: cover; flex-shrink: 0; }
    .cr-body { padding: 12px 14px; }
    .cr-title { font-family: 'Outfit', sans-serif; font-size: 17px; font-weight: 700; color: var(--green-dark, #1a2e1f); margin: 0 0 4px; line-height: 1.25; }
    .cr-meta { font-size: 13px; font-weight: 600; color: var(--text, #2d2a24); }
    .cr-uses { font-size: 12px; color: var(--muted, #6b6b6b); margin-top: 6px; }
    .cp-note { font-size: 15px; color: #4a463d; }
    .cp-cta { background: #FAF6EE; border-radius: 14px; padding: 22px; text-align: center; margin: 28px 0; }
    .cp-cta h2 { margin-bottom: 6px; }
    .cp-cta p { font-size: 14px; color: #4a463d; margin: 0 0 14px; }
    .cp-cta a { display: inline-block; background: var(--orange, #d97706); color: #fff; text-decoration: none; padding: 13px 26px; border-radius: 999px; font-weight: 700; }
    .cp-foot { text-align: center; font-size: 12px; color: var(--muted, #6b6b6b); padding: 20px; }
    .cp-foot a { color: var(--muted, #6b6b6b); }
    @media (max-width: 520px) { .cr-card { flex-direction: column; } .cr-img { width: 100%; height: 150px; } }
    .cr-hero { display: block; background: #fff; border: 2px solid var(--orange, #d97706); border-radius: 16px; overflow: hidden; margin: 26px 0 4px; cursor: pointer; }
    .crh-img { width: 100%; height: 200px; object-fit: cover; display: block; }
    .crh-body { padding: 18px 20px 20px; }
    .crh-eyebrow { font-size: 11px; letter-spacing: 0.8px; text-transform: uppercase; font-weight: 700; color: var(--orange, #d97706); }
    .crh-title { font-family: 'Outfit', sans-serif; font-size: 24px; font-weight: 700; color: var(--green-dark, #2d6a4f); margin: 6px 0 6px; line-height: 1.2; }
    .crh-meta { font-size: 14px; font-weight: 600; color: var(--text, #2d2a24); }
    .crh-uses { font-size: 13px; color: var(--muted, #6b6b6b); margin-top: 8px; }
    .crh-go { font-size: 14px; font-weight: 700; color: var(--orange, #d97706); margin-top: 12px; }
    @media (min-width: 720px) { .cr-hero { display: flex; } .crh-img { width: 300px; height: auto; min-height: 200px; flex-shrink: 0; } }
    .cr-hint { font-size: 13px; color: var(--muted, #6b6b6b); margin: 4px 0 0; }
    .cr-modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 900; align-items: center; justify-content: center; padding: 20px; }
    .cr-modal-overlay.show { display: flex; }
    .cr-modal { background: #fffdf7; border-radius: 18px; max-width: 460px; width: 100%; max-height: 90vh; overflow-y: auto; }
    .crm-img { width: 100%; height: 170px; object-fit: cover; border-radius: 18px 18px 0 0; display: block; }
    .crm-body { padding: 18px 20px 22px; }
    .crm-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .crm-title { font-family: 'Outfit', sans-serif; font-size: 20px; font-weight: 700; color: var(--green-dark, #1a2e1f); margin: 0; }
    .crm-close { background: none; border: none; font-size: 26px; line-height: 1; cursor: pointer; color: #999; }
    .crm-stats { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 4px; }
    .crm-pill { background: #F5EFE0; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; }
    .crm-pill-green { background: #E3F0E6; color: var(--green-dark, #1a2e1f); }
    .crm-h { font-family: 'Outfit', sans-serif; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted, #6b6b6b); margin: 16px 0 6px; }
    .crm-list { margin: 0; padding-left: 20px; font-size: 14px; }
    .crm-list li { margin-bottom: 6px; }
    .crm-save { width: 100%; margin-top: 18px; background: var(--orange, #d97706); color: #fff; border: none; border-radius: 999px; padding: 14px; font-size: 15px; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  ${SITE_HEADER}
  <div class="cp-hero">
    <div class="cp-wrap">
      <div class="cp-eyebrow">Dishcount &middot; ${_esc(eyebrowText)}</div>
      <h1>${_esc(label)}'s featured deals this week</h1>
      <p>${introLine} Enter your zip for the full list at your store.</p>
    </div>
  </div>

  <main class="cp-wrap">
    ${heroCard}

    <section class="cp-section">
      <h2>${featuredHeading}</h2>
      <div class="cd-grid">
${dealCards}
      </div>
    </section>

    <section class="cp-section">
      <h2>${_esc(moreDinnersHeading)}</h2>
      <div id="cr-list">
${recipeCards}
      </div>
      <p class="cr-hint">Tap a dinner for the full recipe.</p>
    </section>

    ${note ? `<section class="cp-section">
      <h2>How ${_esc(label)} deals work</h2>
      <p class="cp-note">${_esc(note)}</p>
    </section>` : ""}

    <div class="cp-cta">
      <h2>Want deals from your own stores?</h2>
      <p>Enter your zip and Dishcount pulls the weekly ads from every grocery store near you, then builds dinners around what's on sale. Free, no signup.</p>
      <a href="/">Find deals near me &rarr;</a>
    </div>
    <nav class="more-ads" aria-label="More weekly ads" style="max-width:760px;margin:24px auto 0;padding:0 20px;font-size:14px;line-height:1.9;">
      <h2 style="font-size:18px;margin:0 0 6px;">More weekly ads</h2>
      <p>${chainCrossLinks(slug)} &middot; <a href="/deals">All weekly deals</a> &middot; <a href="/blog/meal-plan-around-deals.html">How to plan meals around deals</a> &middot; <a href="/blog/dishcount-vs-flipp.html">Dishcount vs Flipp</a> &middot; <a href="/blog/kroger-weekly-ad-meal-plan.html">Kroger meal plan guide</a></p>
    </nav>
  </main>

  <div class="cp-foot">
    Updated ${_esc(dateStr)}. ${footSourceLine}
  </div>
  ${SITE_FOOTER}

  <div class="cr-modal-overlay" id="crOverlay"><div class="cr-modal" id="crModal"></div></div>
  <script type="application/json" id="cr-data">${JSON.stringify(bundle.recipes).replace(/</g, "\\u003c")}</script>
  <script>
  (function () {
    var recipes = [];
    try { recipes = JSON.parse(document.getElementById("cr-data").textContent); } catch (e) { return; }
    var overlay = document.getElementById("crOverlay");
    var modal = document.getElementById("crModal");
    function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
    function close(){ overlay.classList.remove("show"); }
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });

    function save(r) {
      // Reuses the homepage preview-save path: stash, then the signed-in handler
      // in app.js POSTs it to /api/recipes/saved after account creation.
      try {
        localStorage.setItem("dishcount_pending_preview_recipe", JSON.stringify({
          _ts: Date.now(), title: r.title, time: r.time || "", servings: r.servings || 4,
          image: r.image || "", ingredients: r.ingredients || [], steps: r.instructions || [],
        }));
      } catch (e) {}
      window.location.href = "/profile.html";
    }

    function open(i) {
      var r = recipes[i];
      if (!r) return;
      var stats = [];
      if (r.time) stats.push('<span class="crm-pill">' + esc(r.time) + '</span>');
      if (r.servings) stats.push('<span class="crm-pill">' + r.servings + ' servings</span>');
      if (r.costPerServing) stats.push('<span class="crm-pill crm-pill-green">$' + Number(r.costPerServing).toFixed(2) + '/serving</span>');
      var ings = (r.ingredients || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("");
      var steps = (r.instructions || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("");
      modal.innerHTML =
        (r.image ? '<img class="crm-img" src="' + esc(r.image) + '" alt="" />' : '') +
        '<div class="crm-body">' +
          '<div class="crm-head"><h3 class="crm-title">' + esc(r.title) + '</h3>' +
          '<button class="crm-close" id="crmClose" aria-label="Close">&times;</button></div>' +
          '<div class="crm-stats">' + stats.join("") + '</div>' +
          '<h4 class="crm-h">Ingredients</h4><ul class="crm-list">' + ings + '</ul>' +
          '<h4 class="crm-h">Instructions</h4><ol class="crm-list">' + steps + '</ol>' +
          '<button class="crm-save" id="crmSave">Save this recipe</button>' +
        '</div>';
      overlay.classList.add("show");
      document.getElementById("crmClose").addEventListener("click", close);
      document.getElementById("crmSave").addEventListener("click", function () { save(r); });
    }

    var cards = document.querySelectorAll(".cr-card");
    for (var i = 0; i < cards.length; i++) {
      (function (idx, el) {
        el.style.cursor = "pointer";
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");
        el.addEventListener("click", function () { open(idx); });
        el.addEventListener("keydown", function (e) { if (e.key === "Enter") open(idx); });
      })(i, cards[i]);
    }
  })();
  </script>
</body>
</html>`;
}

// Hub page. Gives Google an internal link path to each chain page (that's how
// it discovers and weights them) and gives the nav somewhere sensible to point.
router.get("/deals", async (req, res, next) => {
  try {
    const cards = [];
    for (const slug of Object.keys(SSR_CHAINS)) {
      const b = await getCachedDeals(`ssr:bundle:${slug}`);
      if (!b || !b.deals || !b.deals.length) continue;
      const first = b.recipes && b.recipes[0];
      // Best discount on the page, for the hook. Deals with no regular price
      // (OCR chains) report pctOff 0, so this is a floor, not a guess.
      const topPct = Math.max(0, ...b.deals.map(d => Number(d.pctOff) || 0));
      // Three preview deals: highest discount first so the hook is honest.
      const preview = b.deals
        .slice()
        .sort((a, z) => (Number(z.pctOff) || 0) - (Number(a.pctOff) || 0))
        .slice(0, 3);
      const thumbs = preview.map(d => {
        const img = isProductPhoto(d.image)
          ? `<img class="hb-thumb-img" src="${_esc(d.image)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
          : `<div class="hb-thumb-noimg"></div>`;
        const unitText = bundleUnitText(d);
        const unit = unitText ? `<span class="hb-unit">${_esc(unitText)}</span>` : "";
        // Only badge a REAL discount. Items whose regular price failed the H6
        // plausibility guard carry pctOff 0 and correctly show no badge.
        const pct = (Number(d.pctOff) > 0 && !isBogoRow(d))
          ? `<span class="hb-thumb-pct">${Number(d.pctOff)}% off</span>` : "";
        return `<div class="hb-thumb">
          ${pct}
          ${img}
          <div class="hb-thumb-price">$${Number(d.salePrice).toFixed(2)}${unit}</div>
          <div class="hb-thumb-name">${_esc(d.name)}</div>
        </div>`;
      }).join("");

      cards.push(`<a class="hb-card" href="/deals/${_esc(slug)}">
        <div class="hb-head">
          <div class="hb-name">${_esc(b.label)}</div>
          ${topPct > 0 ? `<div class="hb-pct">up to ${topPct}% off</div>` : ""}
        </div>
        <div class="hb-meta">${b.deals.length} featured deals this week</div>

        <div class="hb-thumbs">${thumbs}</div>

        ${first ? `<div class="hb-rec">
          ${first.image ? `<img class="hb-rec-img" src="${_esc(first.image)}" alt="" loading="lazy" />` : ""}
          <div class="hb-rec-body">
            <div class="hb-rec-label">Tonight's dinner</div>
            <div class="hb-rec-title">${_esc(first.title)}</div>
            ${first.costPerServing ? `<div class="hb-rec-meta">$${Number(first.costPerServing).toFixed(2)}/serving</div>` : ""}
          </div>
        </div>` : ""}

        <div class="hb-go">See all ${_esc(b.label)} deals &rarr;</div>
      </a>`);
    }
    if (!cards.length) { res.set("Retry-After", "3600"); return res.status(503).send("<!DOCTYPE html><html><body><p>Deals are refreshing. Check back shortly.</p></body></html>"); }

    const title = "Grocery Weekly Ads and Dinner Ideas | Dishcount";
    const desc = "This week's grocery deals from Kroger, ALDI, and 80+ regional chains, plus dinners you can build from them. Real prices, updated weekly. Free, no signup.";
    res.set("Cache-Control", "public, max-age=1800");
    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${_esc(title)}</title>
  <meta name="description" content="${_esc(desc)}">
  <link rel="canonical" href="https://dishcount.co/deals">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.min.css">
  <style>
    /* The site header (.landing-nav) is position:fixed at ~66-70px tall. Without
       this padding the top of the page renders underneath it. */
    body { font-family: 'DM Sans', sans-serif; background: var(--cream, #fffdf7); color: var(--text, #2d2a24); margin: 0; padding-top: 70px; line-height: 1.6; }
    /* display:block REQUIRED — see the note on .cp-hero. */
    .hb-hero { display: block; background: var(--dark, #1a2e1f); color: #e8f0ea; padding: 32px 20px; text-align: center; }
    .hb-hero h1 { font-family: 'Outfit', sans-serif; font-size: 26px; font-weight: 700; color: #fff; margin: 0 0 8px; }
    .hb-hero p { color: #c8d6cb; font-size: 15px; margin: 0; }
    .hb-wrap { max-width: 760px; margin: 0 auto; padding: 28px 20px 40px; }
    .hb-card { display: block; background: #fff; border: 1px solid #EDE6D4; border-radius: 16px; padding: 18px 20px 16px; margin-bottom: 14px; text-decoration: none; color: inherit; transition: box-shadow 0.15s, transform 0.15s; }
    .hb-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.08); transform: translateY(-1px); }
    .hb-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .hb-pct { background: var(--orange, #d97706); color: #fff; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
    .hb-thumbs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 14px 0 4px; }
    .hb-thumb { position: relative; border: 1px solid #F0EAD9; border-radius: 10px; padding: 8px; text-align: center; }
    .hb-thumb-pct { position: absolute; top: 5px; left: 5px; background: var(--orange, #d97706); color: #fff; font-size: 10px; font-weight: 700; padding: 2px 5px; border-radius: 6px; line-height: 1.3; z-index: 1; }
    .hb-thumb-img { width: 100%; height: 66px; max-height: 66px; object-fit: contain; display: block; margin-bottom: 4px; }
    .hb-thumb-noimg { height: 8px; }
    .hb-thumb-price { font-size: 15px; font-weight: 800; color: var(--green-dark, #2d6a4f); }
    .hb-unit { font-size: 11px; font-weight: 600; color: #777; }
    .hb-thumb-name { font-size: 11px; color: var(--muted, #6b6b6b); line-height: 1.25; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 27px; }
    .hb-rec { display: flex; gap: 10px; align-items: center; background: #FAF6EE; border-radius: 12px; padding: 10px; margin-top: 12px; }
    .hb-rec-img { width: 64px; height: 56px; object-fit: cover; border-radius: 8px; flex-shrink: 0; }
    .hb-rec-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700; color: var(--orange, #d97706); }
    .hb-rec-title { font-size: 14px; font-weight: 700; color: var(--green-dark, #2d6a4f); line-height: 1.25; margin-top: 1px; }
    .hb-rec-meta { font-size: 12px; color: var(--muted, #6b6b6b); margin-top: 2px; }
    .hb-name { font-family: 'Outfit', sans-serif; font-size: 20px; font-weight: 700; color: var(--green-dark, #1a2e1f); }
    .hb-meta { font-size: 14px; color: var(--muted, #6b6b6b); margin-top: 2px; }
    .hb-go { font-size: 14px; font-weight: 700; color: var(--orange, #d97706); margin-top: 10px; }
    .hb-cta { text-align: center; margin-top: 26px; font-size: 14px; color: var(--muted, #6b6b6b); }
    .hb-cta a { color: var(--orange, #d97706); font-weight: 700; }
  </style>
</head>
<body>
  ${SITE_HEADER}
  <div class="hb-hero">
    <h1>This week's featured deals</h1>
    <p>Real deals from the stores below, and the dinners you can build from them.</p>
  </div>
  <main class="hb-wrap">
    ${cards.join("\n")}
    <div class="hb-cta">Shop somewhere else? <a href="/">Enter your zip</a> and Dishcount pulls the ads from every store near you.</div>
    <nav class="more-ads" aria-label="More weekly ads" style="max-width:760px;margin:24px auto 0;padding:0 20px;font-size:14px;line-height:1.9;">
      <h2 style="font-size:18px;margin:0 0 6px;">More weekly ads</h2>
      <p>${chainCrossLinks(null)} &middot; <a href="/blog/meal-plan-around-deals.html">How to plan meals around deals</a> &middot; <a href="/blog/dishcount-vs-flipp.html">Dishcount vs Flipp</a> &middot; <a href="/blog/kroger-weekly-ad-meal-plan.html">Kroger meal plan guide</a></p>
    </nav>
  </main>
  ${SITE_FOOTER}
</body>
</html>`);
  } catch (err) { console.error("deals hub failed:", err.message); next(err); }
});

router.get("/deals/:slug", async (req, res, next) => {
  const slug = String(req.params.slug || "").toLowerCase();
  if (!SSR_CHAINS[slug]) return next(); // unknown chain → fall through to 404
  try {
    const bundle = await getCachedDeals(`ssr:bundle:${slug}`);
    if (!bundle || !bundle.deals || !bundle.deals.length) {
      // Temporarily unavailable, not gone. 503 keeps the URL indexed; a 404 would
      // deindex a page whose whole purpose is search.
      res.set("Retry-After", "3600");
      return res.status(503).send("<!DOCTYPE html><html><head><meta charset='utf-8'><title>Deals refreshing</title></head><body style=\"font-family:sans-serif;padding:40px;text-align:center\"><p>This week's deals are being refreshed. Check back shortly.</p><p><a href=\"/\">Find deals near you &rarr;</a></p></body></html>");
    }
    res.set("Cache-Control", "public, max-age=1800");
    res.type("html").send(renderChainPage(bundle));
  } catch (err) {
    console.error(`SSR page ${slug} failed:`, err.message);
    next(err);
  }
});

// ── Featured recipe pages ──────────────────────────────────────────────
// Permanent, crawlable single-recipe pages with Recipe JSON-LD (Rich Pins).
// Backed by the weekly_featured_recipes table so the URL stays live after
// the weekly deal bundle rotates. Modeled on renderChainPage.
function renderRecipePage(recipe, chain) {
  const label = (SSR_CHAINS[chain] && SSR_CHAINS[chain].label) || "your store";
  const slug = recipe.slug;
  const meta = [recipe.time, recipe.servings ? `serves ${recipe.servings}` : "", recipe.costPerServing ? `$${Number(recipe.costPerServing).toFixed(2)}/serving` : ""].filter(Boolean).join(" &middot; ");
  const uses = (recipe.usedSaleItems || []).map(n => _esc(String(n).split(",")[0]));
  const saleWeek = recipe.saleWeek ? _esc(recipe.saleWeek) : "";
  const ingredients = (recipe.ingredients || []).map(i => `<li>${_esc(i)}</li>`).join("\n");
  const steps = (recipe.instructions || []).map(s => `<li>${_esc(s)}</li>`).join("\n");
  const schema = {
    "@context": "https://schema.org", "@type": "Recipe", name: recipe.title,
    ...(recipe.image ? { image: [recipe.image] } : {}),
    author: { "@type": "Organization", name: "Dishcount" },
    description: `A dinner built from this week's ${label} sale items.`,
    recipeCategory: "Dinner",
    ...(recipe.servings ? { recipeYield: `${recipe.servings} servings` } : {}),
    ...(recipe.time ? { totalTime: recipe.time } : {}),
    recipeIngredient: (recipe.ingredients || []),
    recipeInstructions: (recipe.instructions || []).map(s => ({ "@type": "HowToStep", text: s })),
  };
  const title = `${recipe.title} | Dishcount`;
  const desc = `${recipe.title}. A dinner built from this week's ${label} deals, with the sale items it uses. Free, no signup.`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${_esc(title)}</title>
  <meta name="description" content="${_esc(desc)}">
  <link rel="canonical" href="https://dishcount.co/recipe/${_esc(slug)}">
  <meta property="og:title" content="${_esc(title)}">
  <meta property="og:description" content="${_esc(desc)}">
  <meta property="og:type" content="article">
  ${recipe.image ? `<meta property="og:image" content="${_esc(recipe.image)}">` : ""}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.min.css">
  <script type="application/ld+json">${JSON.stringify(schema).replace(/</g, "\\u003c")}</script>
  <style>
    body { font-family: 'DM Sans', sans-serif; background: var(--cream, #fffdf7); color: var(--text, #2d2a24); margin: 0; padding-top: 70px; line-height: 1.6; }
    .rp-hero { display: block; background: var(--dark, #1a2e1f); color: #e8f0ea; padding: 32px 20px 28px; }
    .rp-wrap { max-width: 720px; margin: 0 auto; padding: 0 20px; }
    .rp-eyebrow { font-size: 12px; letter-spacing: 0.6px; color: #8fb89a; text-transform: uppercase; }
    .rp-hero h1 { font-family: 'Outfit', sans-serif; font-size: 30px; font-weight: 700; color: #fff; margin: 8px 0 6px; line-height: 1.2; }
    .rp-meta { color: #c8d6cb; font-size: 14px; margin: 4px 0 0; }
    .rp-img { width: 100%; max-height: 420px; object-fit: cover; border-radius: 14px; margin: 20px 0 4px; }
    .rp-section { padding: 24px 0 0; }
    .rp-section h2 { font-family: 'Outfit', sans-serif; font-size: 20px; font-weight: 700; color: var(--green-dark, #1a2e1f); margin: 0 0 12px; }
    .rp-uses { background: #f3f7f4; border: 1px solid #dce8df; border-radius: 12px; padding: 14px 16px; font-size: 15px; }
    .rp-list { padding-left: 20px; } .rp-list li { margin: 6px 0; }
    .rp-cta { display: block; text-align: center; background: var(--orange, #d97706); color: #fff; font-weight: 700; text-decoration: none; padding: 16px 20px; border-radius: 14px; margin: 28px 0 40px; font-size: 17px; }
    .rp-foot { max-width: 720px; margin: 0 auto 40px; padding: 0 20px; font-size: 13px; color: #6b7a6f; }
  </style>
</head>
<body>
  ${SITE_HEADER}
  <div class="rp-hero"><div class="rp-wrap">
    <div class="rp-eyebrow">${_esc(label)} dinner from this week's ad</div>
    <h1>${_esc(recipe.title)}</h1>
    ${meta ? `<p class="rp-meta">${meta}</p>` : ""}
  </div></div>
  <div class="rp-wrap">
    ${recipe.image ? `<img class="rp-img" src="${_esc(recipe.image)}" alt="${_esc(recipe.title)}">` : ""}
    ${uses.length ? `<div class="rp-section"><div class="rp-uses">Built from ${_esc(uses.join(", "))}, on sale at ${_esc(label)}${saleWeek ? ` the week of ${saleWeek}` : " this week"}.</div></div>` : ""}
    <div class="rp-section"><h2>Ingredients</h2><ul class="rp-list">${ingredients}</ul></div>
    <div class="rp-section"><h2>Steps</h2><ol class="rp-list">${steps}</ol></div>
    <a class="rp-cta" href="/deals/${_esc(chain)}">See this week's full ${_esc(label)} ad and build your plan &rarr;</a>
  </div>
  <div class="rp-foot">${saleWeek ? `Prices are from the week of ${saleWeek}. ` : ""}Sale items and prices change weekly. This recipe is built around what is typically on sale. Check this week's ad for current prices. Dishcount is free, no signup.</div>
</body>
</html>`;
}

// Permanent single-recipe page, backed by weekly_featured_recipes.
router.get("/recipe/:slug", async (req, res, next) => {
  const slug = String(req.params.slug || "").toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return next();
  try {
    const { data, error } = await supabase
      .from("weekly_featured_recipes")
      .select("chain, recipe")
      .eq("slug", slug)
      .single();
    if (error || !data) {
      res.set("Cache-Control", "public, max-age=300");
      return res.status(404).type("html").send("<!DOCTYPE html><html><head><meta charset='utf-8'><title>Recipe not found</title></head><body style=\"font-family:sans-serif;padding:40px;text-align:center\"><p>Recipe not found. <a href=\"/deals\">See this week's deals &rarr;</a></p></body></html>");
    }
    const recipe = { ...data.recipe, slug };
    res.set("Cache-Control", "public, max-age=3600");
    res.type("html").send(renderRecipePage(recipe, data.chain));
  } catch (err) {
    console.error(`recipe page ${slug} failed:`, err.message);
    next(err);
  }
});

// ── Recipes index ──────────────────────────────────────────────────────
// Lists every featured recipe from weekly_featured_recipes, each linking to
// its /recipe/:slug page. Gives the "Recipes" nav item a real destination.
function renderRecipesIndex(rows) {
  const cards = (rows || []).map(r => {
    const rec = r.recipe || {};
    const label = (SSR_CHAINS[r.chain] && SSR_CHAINS[r.chain].label) || "";
    const meta = [rec.time, rec.servings ? `serves ${rec.servings}` : "", rec.costPerServing ? `$${Number(rec.costPerServing).toFixed(2)}/serving` : ""].filter(Boolean).join(" &middot; ");
    return `<a class="ri-card" href="/recipe/${_esc(r.slug)}">
      ${rec.image ? `<img class="ri-img" src="${_esc(rec.image)}" alt="${_esc(rec.title || r.slug)}" loading="lazy">` : `<div class="ri-img ri-img-ph">&#127869;</div>`}
      <div class="ri-body">
        ${label ? `<div class="ri-eyebrow">${_esc(label)}</div>` : ""}
        <div class="ri-title">${_esc(rec.title || r.slug)}</div>
        ${meta ? `<div class="ri-meta">${meta}</div>` : ""}
      </div>
    </a>`;
  }).join("\n");
  const title = "Recipes Built From This Week's Grocery Deals | Dishcount";
  const desc = "Dinner recipes built from real grocery store sale items. Each one starts with what's on sale and shows the deals it uses. Free, no signup.";
  const body = (rows && rows.length)
    ? `<div class="ri-grid">${cards}</div>`
    : `<p class="ri-empty">New recipes are on the way. In the meantime, <a href="/deals">see this week's deals</a> and build your own.</p>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${_esc(title)}</title>
  <meta name="description" content="${_esc(desc)}">
  <link rel="canonical" href="https://dishcount.co/recipes">
  <meta property="og:title" content="${_esc(title)}">
  <meta property="og:description" content="${_esc(desc)}">
  <meta property="og:type" content="website">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.min.css">
  <style>
    body { font-family: 'DM Sans', sans-serif; background: var(--cream, #fffdf7); color: var(--text, #2d2a24); margin: 0; padding-top: 70px; line-height: 1.6; }
    .ri-hero { display: block; background: var(--dark, #1a2e1f); color: #e8f0ea; padding: 32px 20px 28px; }
    .ri-wrap { max-width: 900px; margin: 0 auto; padding: 0 20px; }
    .ri-hero-eyebrow { font-size: 12px; letter-spacing: 0.6px; color: #8fb89a; text-transform: uppercase; }
    .ri-hero h1 { font-family: 'Outfit', sans-serif; font-size: 28px; font-weight: 700; color: #fff; margin: 8px 0 6px; line-height: 1.2; }
    .ri-hero p { color: #c8d6cb; font-size: 15px; margin: 0; }
    .ri-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; padding: 28px 0 48px; }
    .ri-card { display: block; background: #fff; border: 1px solid #EDE6D4; border-radius: 14px; overflow: hidden; text-decoration: none; color: inherit; transition: box-shadow .15s ease; }
    .ri-card:hover { box-shadow: 0 6px 18px rgba(0,0,0,0.08); }
    .ri-img { width: 100%; height: 150px; object-fit: cover; display: block; }
    .ri-img-ph { display: flex; align-items: center; justify-content: center; font-size: 44px; background: #f3f7f4; }
    .ri-body { padding: 14px 16px 16px; }
    .ri-eyebrow { font-size: 11px; letter-spacing: 0.5px; color: #6b7a6f; text-transform: uppercase; margin-bottom: 4px; }
    .ri-title { font-family: 'Outfit', sans-serif; font-size: 17px; font-weight: 700; color: var(--green-dark, #1a2e1f); }
    .ri-meta { color: #6b7a6f; font-size: 13px; margin-top: 4px; }
    .ri-empty { max-width: 900px; margin: 40px auto; padding: 0 20px; font-size: 16px; color: #555; }
  </style>
</head>
<body>
  ${SITE_HEADER}
  <div class="ri-hero"><div class="ri-wrap">
    <div class="ri-hero-eyebrow">Dishcount</div>
    <h1>Recipes from this week's deals</h1>
    <p>Every recipe starts with what's on sale, then builds a dinner around it.</p>
  </div></div>
  <div class="ri-wrap">
    ${body}
  </div>
</body>
</html>`;
}

// Recipes index — gives the Recipes nav item a destination.
router.get("/recipes", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("weekly_featured_recipes")
      .select("slug, chain, recipe")
      .order("created_at", { ascending: false })
      .limit(30);
    res.set("Cache-Control", "public, max-age=1800");
    res.type("html").send(renderRecipesIndex(error ? [] : (data || [])));
  } catch (err) {
    console.error("recipes index failed:", err.message);
    next(err);
  }
});

export default router;
