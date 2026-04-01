import { Router } from "express";
import fetch from "node-fetch";
import {
  getUser, getAppToken, refreshKrogerToken, validateZip, detectPerLb,
  krogerTokens, getCachedDeals, setCachedDeals,
  KROGER_API_BASE, DEAL_CATEGORIES,
} from "../lib/utils.js";

const router = Router();

// ── Shared Kroger deal fetching logic ─────────────────────────────────────────

export async function fetchKrogerDeals(locationId, banner) {
  const token = await getAppToken();
  const allProducts = [];
  const batchSize = 15;
  for (let i = 0; i < DEAL_CATEGORIES.length; i += batchSize) {
    const batch = DEAL_CATEGORIES.slice(i, i + batchSize);
    await Promise.all(batch.map(async (category) => {
      try {
        const r = await fetch(
          `${KROGER_API_BASE}/products?filter.locationId=${locationId}&filter.term=${encodeURIComponent(category)}&filter.limit=20`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
        );
        if (!r.ok) return;
        const data = await r.json();
        const products = (data.data || []).filter(p => p.items?.[0]?.price?.promo > 0).map(p => {
          const item = p.items[0];
          const size = item.size || "";
          const sizeLower = size.toLowerCase();
          const regular = item.price.regular || 0;
          const sale = item.price.promo || 0;
          const nameLower = (p.description || "").toLowerCase();
          const isPerLb = detectPerLb(sizeLower, nameLower, sale);
          const isPerCount = sizeLower.includes("ct") && !sizeLower.includes("oz");
          const pctOff = Math.round(((regular - sale) / regular) * 100);
          return {
            id: p.productId, upc: item.upc || "", name: p.description, brand: p.brand || "", category,
            regularPrice: regular.toFixed(2), salePrice: sale.toFixed(2),
            isPerLb, priceUnit: isPerLb ? "/lb" : isPerCount ? "/ea" : "",
            savings: (regular - sale).toFixed(2), pctOff, size,
            image: p.images?.find(i => i.perspective === "front")?.sizes?.find(s => s.size === "medium")?.url || p.images?.find(i => i.perspective === "front")?.sizes?.find(s => s.size === "thumbnail")?.url || null,
            ...(banner ? { storeName: banner, source: "kroger" } : {}),
          };
        });
        allProducts.push(...products);
      } catch (e) { console.error(`Kroger category "${category}" fetch error:`, e.message); }
    }));
  }
  const seen = new Set();
  return allProducts
    .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
    .sort((a, b) => b.pctOff - a.pctOff)
    .slice(0, 500);
}

// ══ STORES API (Kroger) ═══════════════════════════════════════════════════════

router.get("/api/stores", async (req, res) => {
  const { zip, radius } = req.query;
  if (!validateZip(zip)) return res.status(400).json({ error: "Valid 5-digit zip is required" });
  const miles = Math.min(Math.max(parseInt(radius) || 10, 1), 50);
  try {
    const token = await getAppToken();
    const r = await fetch(
      `${KROGER_API_BASE}/locations?filter.zipCode.near=${zip}&filter.radiusInMiles=${miles}&filter.limit=10`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
    );
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const stores = (data.data || []).map(loc => ({
      id: loc.locationId, name: loc.chain || loc.name || "Kroger",
      address: `${loc.address?.addressLine1}, ${loc.address?.city}, ${loc.address?.state}`,
      hours: loc.hours?.open24 ? "Open 24 hrs" : "",
    }));
    res.json({ stores });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ KROGER PRODUCT SEARCH ════════════════════════════════════════════════════

router.get("/api/kroger/search", async (req, res) => {
  const { query, locationId } = req.query;
  if (!query || !locationId) return res.status(400).json({ error: "query and locationId required" });

  async function searchKroger(term) {
    const token = await getAppToken();
    const url = `${KROGER_API_BASE}/products?filter.term=${encodeURIComponent(term)}&filter.locationId=${locationId}&filter.limit=5`;
    console.log(`Kroger search: "${term}" at ${locationId}`);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) { console.error(`Kroger search error: ${r.status} for "${term}"`); return []; }
    const data = await r.json();
    return (data.data || []).map(p => ({
      upc: p.items?.[0]?.upc || "",
      name: p.description || "",
      brand: p.brand || "",
      price: p.items?.[0]?.price?.regular || 0,
      image: p.images?.find(i => i.perspective === "front")?.sizes?.find(s => s.size === "thumbnail")?.url || null,
    })).filter(p => p.upc);
  }

  function pickBest(products) {
    if (!products.length) return null;
    return products.find(p => /kroger|simple truth/i.test(p.brand)) || products[0];
  }

  try {
    // 1. Try full query
    let products = await searchKroger(query);
    if (products.length) {
      const best = pickBest(products);
      console.log(`Kroger found (full): "${best.name}" UPC:${best.upc}`);
      return res.json({ product: best, results: products.length, searchUsed: query });
    }

    // 2. Try first 4 words (keeps brand + product)
    const words = query.split(/\s+/);
    if (words.length > 4) {
      const shortQuery = words.slice(0, 4).join(" ");
      products = await searchKroger(shortQuery);
      if (products.length) {
        const best = pickBest(products);
        console.log(`Kroger found (short): "${best.name}" UPC:${best.upc}`);
        return res.json({ product: best, results: products.length, searchUsed: shortQuery });
      }
    }

    // 3. Try core product word (last 1-2 significant words, or first noun)
    const skipWords = new Set(["fresh","natural","premium","organic","original","classic","homestyle","traditional","regular","extra","large","small","whole","ground","boneless","skinless"]);
    const coreWords = words.filter(w => w.length > 2 && !skipWords.has(w.toLowerCase()));
    if (coreWords.length > 2) {
      // Try last 2 meaningful words (often the actual product)
      const coreQuery = coreWords.slice(-2).join(" ");
      products = await searchKroger(coreQuery);
      if (products.length) {
        const best = pickBest(products);
        console.log(`Kroger found (core): "${best.name}" UPC:${best.upc}`);
        return res.json({ product: best, results: products.length, searchUsed: coreQuery });
      }
    }

    console.log(`Kroger not found: "${query}"`);
    res.json({ product: null, results: 0, searchUsed: query });
  } catch (err) {
    console.error("Kroger search error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══ DEALS API (Kroger) ════════════════════════════════════════════════════════

router.get("/api/deals", async (req, res) => {
  const { locationId } = req.query;
  if (!locationId) return res.status(400).json({ error: "locationId is required" });
  try {
    const cacheKey = `kroger:${locationId}`;
    const dbCached = await getCachedDeals(cacheKey);
    if (dbCached) {
      console.log(`Kroger Supabase cache HIT for location ${locationId} (${dbCached.length} deals)`);
      return res.json({ deals: dbCached, cached: true });
    }
    console.log(`Kroger cache MISS for location ${locationId} — fetching live...`);
    const unique = await fetchKrogerDeals(locationId);
    await setCachedDeals(cacheKey, unique);
    console.log(`Kroger: saved ${unique.length} deals for location ${locationId}`);
    res.json({ deals: unique });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ COUPONS API ═══════════════════════════════════════════════════════════════

router.get("/api/coupons", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const krogerData = krogerTokens.get(user.id);
  if (!krogerData) return res.status(401).json({ error: "Kroger not connected" });
  try {
    if (Date.now() >= krogerData.expiresAt) {
      const refreshed = await refreshKrogerToken(krogerData.refreshToken);
      krogerData.accessToken = refreshed.access_token;
      krogerData.expiresAt = Date.now() + refreshed.expires_in * 1000;
      krogerTokens.set(user.id, krogerData);
    }
    const [couponRes, boostRes] = await Promise.all([
      fetch(`${KROGER_API_BASE}/loyalty/profiles/coupons`, {
        headers: { Authorization: `Bearer ${krogerData.accessToken}`, Accept: "application/json" },
      }),
      fetch(`${KROGER_API_BASE}/loyalty/profiles/coupons?filter.offerType=BoostWeeklyDigitalDeal`, {
        headers: { Authorization: `Bearer ${krogerData.accessToken}`, Accept: "application/json" },
      }).catch(() => null),
    ]);
    if (!couponRes.ok) throw new Error(await couponRes.text());
    const couponData = await couponRes.json();
    const coupons = (couponData.data || []).map(c => ({
      id: c.offerId, description: c.description, brand: c.brandName || "",
      savings: c.customerSavings || 0, expiryDate: c.expirationDate || "",
      clipped: c.offerState === "Clipped", category: c.categories?.[0] || "", type: "digital_coupon",
    }));
    let boostDeals = [];
    if (boostRes?.ok) {
      const boostData = await boostRes.json();
      boostDeals = (boostData.data || []).map(c => ({
        id: c.offerId, description: c.description, brand: c.brandName || "",
        savings: c.customerSavings || 0, expiryDate: c.expirationDate || "",
        clipped: c.offerState === "Clipped", category: c.categories?.[0] || "", type: "boost_deal",
      }));
    }
    res.json({ coupons, boostDeals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ CART API ══════════════════════════════════════════════════════════════════

router.post("/api/cart", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const krogerData = krogerTokens.get(user.id);
  if (!krogerData) return res.status(401).json({ error: "Kroger not connected" });
  try {
    if (Date.now() >= krogerData.expiresAt) {
      const refreshed = await refreshKrogerToken(krogerData.refreshToken);
      krogerData.accessToken = refreshed.access_token;
      krogerData.expiresAt = Date.now() + refreshed.expires_in * 1000;
      krogerTokens.set(user.id, krogerData);
    }
    const { items } = req.body;
    const r = await fetch(`${KROGER_API_BASE}/cart/add`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${krogerData.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ items: items.map(i => ({ upc: i.upc, quantity: i.quantity || 1, modality: "PICKUP" })) }),
    });
    if (!r.ok) throw new Error(await r.text());
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
