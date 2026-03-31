import { Router } from "express";
import { supabase } from "../lib/utils.js";

const router = Router();

router.get("/api/aldi/deals", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("aldi_deals")
      .select("*")
      .order("name", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    const deals = (data || []).map(d => ({
      id: d.id,
      upc: "",
      name: d.name,
      brand: d.brand || "",
      category: d.category || "ALDI",
      regularPrice: d.regular_price || "",
      salePrice: d.price,
      savings: d.savings || "",
      pctOff: (() => {
        const sale = parseFloat(d.price?.replace(/[^0-9.]/g, ""));
        const reg = parseFloat(d.regular_price?.replace(/[^0-9.]/g, ""));
        if (sale && reg && reg > sale) return Math.round(((reg - sale) / reg) * 100);
        return 0;
      })(),
      size: "",
      image: d.image || null,
      productUrl: d.product_url || null,
      weekStart: d.week_start,
      weekEnd: d.week_end,
      source: "aldi",
    }));
    res.json({ deals });
  } catch (err) {
    console.error("Aldi deals error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/aldi/stores", (req, res) => {
  const zip = req.query.zip || "";
  res.json({
    stores: [{
      id: "aldi-1",
      name: "ALDI",
      address: `Near ${zip}`,
      hours: "9am–8pm",
      chain: "aldi"
    }]
  });
});

router.get("/api/aldi/status", async (req, res) => {
  try {
    const { count, data } = await supabase
      .from("aldi_deals")
      .select("scraped_at", { count: "exact", head: false })
      .order("scraped_at", { ascending: false })
      .limit(1);
    res.json({ deals_in_db: count || 0, last_scraped: data?.[0]?.scraped_at || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
