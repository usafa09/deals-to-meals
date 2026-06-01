import { Router } from "express";
import fetch from "node-fetch";
import { validateZip, getWalmartHeaders, WALMART_API_BASE } from "../lib/utils.js";

const MAX_PLAUSIBLE_PCT_OFF = 70; // grocery rollbacks above this are almost always bad source data (wrong-unit / case-pack msrp). Tunable.

// Trustworthy "before" price for a Walmart item, or null if we can't trust it.
// Prefer regularPrice; use msrp only as a fallback. The pctOff ceiling below
// still guards against msrp returning a garbage value.
function resolveRegularPrice(p) {
  const r = Number(p.regularPrice) || Number(p.msrp) || 0;
  return r > 0 ? r : null;
}

const router = Router();

export async function fetchWalmartDeals() {
  if (!process.env.WALMART_CONSUMER_ID || !process.env.WALMART_PRIVATE_KEY) {
    console.log("Walmart: credentials not configured, skipping");
    return [];
  }
  let headers;
  try { headers = getWalmartHeaders(); } catch(e) { console.error("Walmart auth error:", e.message); return []; }
  const allProducts = [];
  const searchTerms = ["chicken","beef","pasta","vegetables","fruit","dairy","snacks","breakfast","seafood","pork"];
  await Promise.all(searchTerms.map(async (term) => {
    try {
      const r = await fetch(
        `${WALMART_API_BASE}/search?query=${encodeURIComponent(term)}&categoryId=976759&specialOffer=rollback&numItems=25&responseGroup=full`,
        { headers }
      );
      if (!r.ok) return;
      const data = await r.json();
      const items = (data.items || [])
        .filter(p => {
          const sale = Number(p.salePrice);
          const regular = resolveRegularPrice(p);
          if (!sale || !regular || sale >= regular || regular > 50) return false;
          const pctOff = Math.round(((regular - sale) / regular) * 100);
          return pctOff <= MAX_PLAUSIBLE_PCT_OFF; // drop impossible discounts (the fake-price bug)
        })
        .map(p => {
          const regular = resolveRegularPrice(p);
          const sale = Number(p.salePrice);
          const savings = (regular - sale).toFixed(2);
          const pctOff = Math.round(((regular - sale) / regular) * 100);
          return {
            id: String(p.itemId), upc: p.upc || "", name: p.name, brand: p.brandName || "",
            category: term, regularPrice: regular.toFixed(2), salePrice: sale.toFixed(2),
            savings, pctOff, size: p.size || "",
            image: p.thumbnailImage || p.mediumImage || null,
            productUrl: p.productUrl || null, source: "walmart", storeName: "Walmart",
          };
        });
      allProducts.push(...items);
    } catch (e) { console.error(`Walmart search "${term}" error:`, e.message); }
  }));
  const seen = new Set();
  const out = allProducts
    .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
    .sort((a, b) => b.pctOff - a.pctOff)
    .slice(0, 500);
  const maxPct = out.reduce((m, d) => Math.max(m, d.pctOff), 0);
  console.log(`Walmart: ${out.length} deals, max ${maxPct}% off (ceiling ${MAX_PLAUSIBLE_PCT_OFF})`);
  return out;
}

router.get("/api/walmart/stores", async (req, res) => {
  const { zip } = req.query;
  if (!validateZip(zip)) return res.status(400).json({ error: "Valid 5-digit zip is required" });
  if (!process.env.WALMART_CONSUMER_ID || !process.env.WALMART_PRIVATE_KEY) return res.json({ stores: [] });
  try {
    const headers = getWalmartHeaders();
    const r = await fetch(`https://developer.api.walmart.com/api-proxy/service/affil/product/v2/stores?zip=${zip}`, { headers });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const list = Array.isArray(data) ? data : (data.stores || []);
    const stores = list.slice(0, 8).map(s => ({
      id: String(s.no || s.storeId || s.id),
      name: s.name || "Walmart",
      address: `${s.streetAddress || s.street || ""}, ${s.city}, ${s.stateProvCode || s.state || ""}`,
      hours: s.sundayOpen ? "Open Sundays" : "",
      source: "walmart",
    }));
    res.json({ stores });
  } catch (err) {
    console.error("Walmart stores error:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

router.get("/api/walmart/deals", async (req, res) => {
  try {
    const deals = await fetchWalmartDeals();
    res.json({ deals });
  } catch (err) {
    console.error("Walmart deals error:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

export default router;
