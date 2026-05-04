import { Router } from "express";
import { supabase, getCachedDeals } from "../lib/utils.js";

const router = Router();

// ALDI deals come from the ad-aggregator OCR pipeline (cache_key=ad-extract:aldi),
// populated weekly by the GH Action POST /api/extract-store. Same path as the
// 80+ other chains we OCR — no bespoke ALDI scraper anymore. Cutover May 2026
// (see commit "Replace broken ALDI scraper with OCR via aldi.weeklyad.us.com").
router.get("/api/aldi/deals", async (req, res) => {
  try {
    const cached = await getCachedDeals("ad-extract:aldi");
    const deals = (cached || []).map(d => ({
      id: d.id || "",
      upc: "",
      name: d.name || "",
      brand: d.brand || "",
      category: d.category || "ALDI",
      regularPrice: d.regularPrice || "",
      salePrice: d.salePrice || "",
      savings: d.savings || "",
      pctOff: (() => {
        const sale = parseFloat(String(d.salePrice || "").replace(/[^0-9.]/g, ""));
        const reg = parseFloat(String(d.regularPrice || "").replace(/[^0-9.]/g, ""));
        if (sale && reg && reg > sale) return Math.round(((reg - sale) / reg) * 100);
        return 0;
      })(),
      size: d.size || "",
      image: d.image || null,
      productUrl: d.productUrl || null,
      source: "aldi",
    }));
    res.json({ deals });
  } catch (err) {
    console.error("Aldi deals error:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

router.get("/api/aldi/status", async (req, res) => {
  try {
    const { data } = await supabase
      .from("deal_cache")
      .select("fetched_at, data")
      .eq("cache_key", "ad-extract:aldi")
      .single();
    const dealCount = Array.isArray(data?.data) ? data.data.length : 0;
    res.json({ deals_in_db: dealCount, last_scraped: data?.fetched_at || null });
  } catch (err) {
    console.error("Aldi status error:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

export default router;
