import { Router } from "express";
import fetch from "node-fetch";
import {
  supabase, requireAdmin, validateZip,
  getAppToken, getWalmartHeaders, getCategoryImage,
  getCachedDeals, setCachedDeals,
  KROGER_API_BASE, SPOONACULAR_BASE, DEAL_CACHE_TTL,
} from "../lib/utils.js";

const router = Router();

// ══ DEBUG ══════════════════════════════════════════════════════════════════════

router.get("/api/debug-kroger-prices", requireAdmin, async (req, res) => {
  try {
    const locationId = req.query.locationId;
    const term = req.query.term || "chicken";
    if (!locationId) return res.status(400).json({ error: "locationId required" });
    const token = await getAppToken();
    const r = await fetch(
      `${KROGER_API_BASE}/products?filter.locationId=${locationId}&filter.term=${encodeURIComponent(term)}&filter.limit=5`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
    );
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();
    const products = (data.data || []).slice(0, 5).map(p => ({
      name: p.description,
      brand: p.brand,
      size: p.items?.[0]?.size || "",
      priceObject: p.items?.[0]?.price || {},
      allItemFields: Object.keys(p.items?.[0] || {}),
    }));
    res.json({ products });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/debug-walmart", requireAdmin, async (req, res) => {
  try {
    const headers = getWalmartHeaders();
    const zip = req.query.zip || "10001";
    const r = await fetch(`https://developer.api.walmart.com/api-proxy/service/affil/product/v2/stores?zip=${zip}`, { headers });
    const text = await r.text();
    res.json({ status: r.status, raw: text.slice(0, 1000) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/debug-recipes", requireAdmin, async (req, res) => {
  try {
    const apiKey = process.env.SPOONACULAR_API_KEY;
    const query = req.query.q || "chicken";
    const type = req.query.type || "main course";
    const url = `${SPOONACULAR_BASE}/recipes/complexSearch?apiKey=${apiKey}&query=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}&number=5&addRecipeInformation=true&fillIngredients=true&instructionsRequired=true`;
    const r = await fetch(url);
    const data = await r.json();
    res.json({ status: r.status, totalResults: data.totalResults, returned: data.results?.length || 0, firstTitle: data.results?.[0]?.title || "none", error: data.message || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ DEAL CACHE ADMIN ═════════════════════════════════════════════════════════

router.get("/api/admin/cache-status", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("deal_cache")
      .select("cache_key, fetched_at")
      .order("fetched_at", { ascending: false });
    if (error) throw new Error(error.message);
    const regions = (data || []).map(d => {
      const age = Date.now() - new Date(d.fetched_at).getTime();
      const ageHrs = Math.round(age / 3600000 * 10) / 10;
      return {
        key: d.cache_key,
        fetched: d.fetched_at,
        ageHours: ageHrs,
        fresh: age < DEAL_CACHE_TTL,
      };
    });
    res.json({ regions, totalCached: regions.length, freshCount: regions.filter(r => r.fresh).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/admin/cache-cleanup", requireAdmin, async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - DEAL_CACHE_TTL).toISOString();
    const { data, error } = await supabase
      .from("deal_cache")
      .delete()
      .lt("fetched_at", cutoff)
      .select("cache_key");
    if (error) throw new Error(error.message);
    res.json({ deleted: data?.length || 0, message: `Removed entries older than 24 hours` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/admin/ad-regions-stats", requireAdmin, async (req, res) => {
  try {
    let allData = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("ad_regions")
        .select("store, banner, division, zip3")
        .range(from, from + pageSize - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      allData.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    const byStore = {};
    const uniqueZips = new Set();
    for (const row of allData) {
      if (!byStore[row.store]) byStore[row.store] = { banners: new Set(), divisions: new Set(), zips: new Set() };
      byStore[row.store].banners.add(row.banner);
      byStore[row.store].divisions.add(row.division);
      byStore[row.store].zips.add(row.zip3);
      uniqueZips.add(row.zip3);
    }

    const stores = Object.entries(byStore).map(([store, info]) => ({
      store,
      banners: [...info.banners],
      divisionCount: info.divisions.size,
      zipCount: info.zips.size,
    })).sort((a, b) => b.zipCount - a.zipCount);

    res.json({
      totalRows: allData.length,
      uniqueStores: stores.length,
      uniqueZip3s: uniqueZips.size,
      stores,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/admin/cache-coverage", requireAdmin, async (req, res) => {
  const { store } = req.query;
  try {
    let regionData = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      let q = supabase.from("ad_regions").select("zip3, store, banner").order("zip3").range(from, from + pageSize - 1);
      if (store) q = q.eq("store", store);
      const { data, error: regErr } = await q;
      if (regErr) throw new Error(regErr.message);
      if (!data || data.length === 0) break;
      regionData.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    const { data: cacheData, error: cacheErr } = await supabase
      .from("deal_cache")
      .select("cache_key, fetched_at");
    if (cacheErr) throw new Error(cacheErr.message);

    const cacheKeys = new Set((cacheData || []).map(d => d.cache_key));
    const freshCutoff = Date.now() - DEAL_CACHE_TTL;
    const freshKeys = new Set((cacheData || []).filter(d => new Date(d.fetched_at).getTime() > freshCutoff).map(d => d.cache_key));

    const zip3Set = new Set();
    let cached = 0, stale = 0, missing = 0;
    for (const row of (regionData || [])) {
      if (zip3Set.has(row.zip3 + row.store)) continue;
      zip3Set.add(row.zip3 + row.store);
      let expectedKey;
      if (row.store === "aldi") expectedKey = "aldi:national";
      else if (row.store === "kroger") expectedKey = `kroger:${row.zip3}`;
      else expectedKey = `ad-extract:${row.store}:${row.zip3}`;
      if (freshKeys.has(expectedKey)) cached++;
      else if (cacheKeys.has(expectedKey)) stale++;
      else missing++;
    }

    res.json({
      totalRegionZips: zip3Set.size,
      cached,
      stale,
      missing,
      coveragePct: zip3Set.size > 0 ? Math.round((cached / zip3Set.size) * 100) : 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ AD IMAGE → DEALS EXTRACTION (Claude Vision) ═════════════════════════════

router.post("/api/extract-ad", requireAdmin, async (req, res) => {
  try {
    const { image, storeName } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });

    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: "Anthropic API key not configured" });

    console.log(`Extracting deals from ad image for store: ${storeName || "unknown"}...`);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            { type: "text", text: `You are extracting grocery deals from a weekly ad image for ${storeName || "a grocery store"}.

For EVERY sale item visible in this image, return a JSON array.

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
  "notes": "any special conditions like must buy 2, limit 4, etc or empty string"
}

IMPORTANT:
- Return ONLY a valid JSON array, no other text, no markdown backticks
- Include every single deal item visible
- For BOGO items, set dealType to "bogo" and salePrice to the price of one item
- If you see "2 for $5" type deals, set salePrice to "2.50" and notes to "2 for $5"
- Extract prices exactly as shown
- If the item is priced per pound, set unit to "/lb"` }
          ]
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.map(c => c.text || "").join("") || "";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const deals = JSON.parse(cleaned);

    const enriched = deals.map((d, i) => ({
      ...d,
      id: `ad-${Date.now()}-${i}`,
      storeName: storeName || "Unknown",
      source: "ad-extract",
      image: getCategoryImage(d.category),
    }));

    console.log(`Extracted ${enriched.length} deals from ad image`);
    res.json({ deals: enriched, count: enriched.length });
  } catch (err) {
    console.error("Ad extraction error:", err);
    res.status(500).json({ error: "Failed to extract deals from image", detail: err.message });
  }
});

router.post("/api/admin/import-deals", requireAdmin, async (req, res) => {
  try {
    const { deals, storeName, zip3 } = req.body;
    if (!deals || !storeName || !zip3) return res.status(400).json({ error: "Missing deals, storeName, or zip3" });

    const cacheKey = `ad-extract:${storeName.toLowerCase().replace(/\s+/g, "-")}:${zip3}`;
    await setCachedDeals(cacheKey, deals);
    console.log(`Imported ${deals.length} deals for ${storeName} (${zip3})`);
    res.json({ success: true, cacheKey, count: deals.length });
  } catch (err) {
    console.error("Import error:", err);
    res.status(500).json({ error: "Failed to import deals" });
  }
});

export default router;
