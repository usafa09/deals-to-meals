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

const SEARCH_TERMS = ["chicken","beef","pasta","vegetables","fruit","dairy","snacks","breakfast","seafood","pork"];

// Cache-write thresholds. Each search term is an independent HTTP call and the
// Walmart affiliate API fails them individually and silently — a term that 429s
// or throws contributes zero rows and the total just comes back smaller. On
// 2026-08-19 eight of ten terms failed on one call, wrote 19 deals to
// walmart:national, and that partial served the whole regional pool for 15
// hours (the 24h TTL outlived the Wednesday cron that would have replaced it).
// A result below EITHER bar is served to the caller but never cached.
export const WALMART_MIN_TERMS = 7;   // of 10
export const WALMART_MIN_DEALS = 60;  // healthy runs return 100-130

// Full fetch with per-term telemetry. Callers that need to judge whether the
// result is complete enough to persist should use this; fetchWalmartDeals()
// below is the plain-array wrapper for callers that just want the deals.
export async function fetchWalmartDealsWithStats() {
  const empty = { deals: [], termsSucceeded: 0, termsTotal: SEARCH_TERMS.length, failedTerms: [] };
  if (!process.env.WALMART_CONSUMER_ID || !process.env.WALMART_PRIVATE_KEY) {
    console.log("Walmart: credentials not configured, skipping");
    return { ...empty, failedTerms: SEARCH_TERMS.map(t => `${t} (no credentials)`) };
  }
  let headers;
  try { headers = getWalmartHeaders(); } catch(e) {
    console.error("Walmart auth error:", e.message);
    return { ...empty, failedTerms: SEARCH_TERMS.map(t => `${t} (auth: ${e.message})`) };
  }
  const allProducts = [];
  const searchTerms = SEARCH_TERMS;
  // A term "succeeds" when the API answered and we parsed it — including when
  // its rows were all filtered out by the price sanity checks below. Zero
  // qualifying rollbacks is a real answer; a non-2xx or a throw is not.
  const termStats = await Promise.all(searchTerms.map(async (term) => {
    try {
      const r = await fetch(
        `${WALMART_API_BASE}/search?query=${encodeURIComponent(term)}&categoryId=976759&specialOffer=rollback&numItems=25&responseGroup=full`,
        { headers }
      );
      if (!r.ok) {
        console.error(`Walmart search "${term}" failed: HTTP ${r.status}`);
        return { term, ok: false, reason: `HTTP ${r.status}` };
      }
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
      return { term, ok: true };
    } catch (e) {
      console.error(`Walmart search "${term}" error:`, e.message);
      return { term, ok: false, reason: e.message };
    }
  }));
  const seen = new Set();
  const out = allProducts
    .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
    .sort((a, b) => b.pctOff - a.pctOff)
    .slice(0, 500);
  const maxPct = out.reduce((m, d) => Math.max(m, d.pctOff), 0);
  const failedTerms = termStats.filter(t => !t.ok).map(t => `${t.term} (${t.reason})`);
  const termsSucceeded = termStats.length - failedTerms.length;
  console.log(`Walmart: ${out.length} deals, max ${maxPct}% off (ceiling ${MAX_PLAUSIBLE_PCT_OFF}), ${termsSucceeded}/${termStats.length} terms ok${failedTerms.length ? ` — failed: ${failedTerms.join(", ")}` : ""}`);
  return { deals: out, termsSucceeded, termsTotal: termStats.length, failedTerms };
}

export async function fetchWalmartDeals() {
  const { deals } = await fetchWalmartDealsWithStats();
  return deals;
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
