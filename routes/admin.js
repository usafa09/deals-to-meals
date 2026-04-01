import { Router } from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import {
  supabase, requireAdmin, validateZip,
  getAppToken, getWalmartHeaders, getCategoryImage,
  getCachedDeals, setCachedDeals,
  requireAdminToken, verifyAdminToken, createAdminToken,
  getDailyPoints, DAILY_POINT_LIMIT,
  KROGER_API_BASE, SPOONACULAR_BASE, DEAL_CACHE_TTL,
} from "../lib/utils.js";

const router = Router();

// Middleware: accept either old cookie auth OR new token auth
function adminAuth(req, res, next) {
  if (verifyAdminToken(req)) return next();
  requireAdmin(req, res, next);
}

// ══ ADMIN AUTH ═══════════════════════════════════════════════════════════════

router.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  const adminPwd = process.env.ADMIN_PASSWORD;
  if (!adminPwd) return res.status(500).json({ error: "ADMIN_PASSWORD not configured" });
  if (password === adminPwd) {
    const token = createAdminToken();
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

router.get("/api/admin/verify", (req, res) => {
  if (verifyAdminToken(req)) res.json({ valid: true });
  else res.status(403).json({ valid: false });
});

// ══ OVERVIEW STATS ══════════════════════════════════════════════════════════

router.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now - 7 * 86400000).toISOString();

    const [usersRes, newWeekRes, msgsRes, unreadRes, cacheRes, pointsVal] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("profiles").select("id", { count: "exact", head: true }).gte("updated_at", weekStart),
      supabase.from("contact_messages").select("id", { count: "exact", head: true }),
      supabase.from("contact_messages").select("id", { count: "exact", head: true }).eq("read", false),
      supabase.from("deal_cache").select("cache_key, fetched_at"),
      getDailyPoints(),
    ]);

    const cacheData = cacheRes.data || [];
    const freshCount = cacheData.filter(d => Date.now() - new Date(d.fetched_at).getTime() < DEAL_CACHE_TTL).length;

    // Anthropic spend today
    const { data: anthropicToday } = await supabase.from("api_usage_log").select("cost_estimate").eq("service", "anthropic").gte("created_at", todayStart);
    const anthropicSpend = (anthropicToday || []).reduce((s, r) => s + parseFloat(r.cost_estimate || 0), 0);

    res.json({
      totalUsers: usersRes.count || 0,
      newUsersWeek: newWeekRes.count || 0,
      totalMessages: msgsRes.count || 0,
      unreadMessages: unreadRes.count || 0,
      totalCached: cacheData.length,
      freshStores: freshCount,
      spoonacularPoints: pointsVal,
      spoonacularLimit: DAILY_POINT_LIMIT,
      anthropicSpendToday: anthropicSpend.toFixed(4),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ USERS ════════════════════════════════════════════════════════════════════

router.get("/api/admin/users", adminAuth, async (req, res) => {
  try {
    const { data: users } = await supabase.from("profiles").select("*").order("updated_at", { ascending: false });
    // Count saved recipes per user
    const { data: recipes } = await supabase.from("saved_recipes").select("user_id");
    const recipeCounts = {};
    (recipes || []).forEach(r => { recipeCounts[r.user_id] = (recipeCounts[r.user_id] || 0) + 1; });

    const enriched = (users || []).map(u => ({
      id: u.id,
      full_name: u.full_name || "",
      email: "", // Not stored in profiles, would need auth admin API
      kroger_connected: u.kroger_connected || false,
      household_size: u.household_size || 0,
      dietary_preferences: u.dietary_preferences || [],
      favorite_recipe_types: u.favorite_recipe_types || [],
      preferred_store: u.preferred_store || "",
      saved_recipes: recipeCounts[u.id] || 0,
      updated_at: u.updated_at,
    }));
    res.json({ users: enriched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ MESSAGES ═════════════════════════════════════════════════════════════════

router.get("/api/admin/messages", adminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from("contact_messages").select("*").order("created_at", { ascending: false });
    res.json({ messages: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch("/api/admin/messages/:id", adminAuth, async (req, res) => {
  try {
    const { read } = req.body;
    const { error } = await supabase.from("contact_messages").update({ read }).eq("id", req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/api/admin/messages/:id", adminAuth, async (req, res) => {
  try {
    const { error } = await supabase.from("contact_messages").delete().eq("id", req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ DEAL CACHE ══════════════════════════════════════════════════════════════

router.get("/api/admin/cache-status", adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("deal_cache").select("cache_key, fetched_at, data").order("fetched_at", { ascending: false });
    if (error) throw new Error(error.message);
    const regions = (data || []).map(d => {
      const age = Date.now() - new Date(d.fetched_at).getTime();
      const dealCount = Array.isArray(d.data) ? d.data.length : 0;
      return {
        key: d.cache_key,
        fetched: d.fetched_at,
        ageHours: Math.round(age / 3600000 * 10) / 10,
        fresh: age < DEAL_CACHE_TTL,
        dealCount,
      };
    });
    res.json({ regions, totalCached: regions.length, freshCount: regions.filter(r => r.fresh).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/admin/cache-cleanup", adminAuth, async (req, res) => {
  const { key } = req.body || {};
  try {
    if (key) {
      // Delete specific cache key
      const { error } = await supabase.from("deal_cache").delete().eq("cache_key", key);
      if (error) throw new Error(error.message);
      res.json({ deleted: 1, message: `Removed ${key}` });
    } else {
      // Delete all stale entries
      const cutoff = new Date(Date.now() - DEAL_CACHE_TTL).toISOString();
      const { data, error } = await supabase.from("deal_cache").delete().lt("fetched_at", cutoff).select("cache_key");
      if (error) throw new Error(error.message);
      res.json({ deleted: data?.length || 0, message: "Removed stale entries" });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/admin/extract-all", adminAuth, async (req, res) => {
  const popular = ["publix", "meijer", "sprouts", "food-lion", "giant-eagle", "safeway", "hy-vee", "shoprite", "harris-teeter", "aldi"];
  const results = [];
  for (const store of popular) {
    try {
      const r = await fetch(`${req.protocol}://${req.get("host")}/api/extract-store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeName: store }),
      });
      const d = await r.json();
      results.push({ store, status: d.status });
    } catch (e) { results.push({ store, status: "error", error: e.message }); }
  }
  res.json({ results });
});

// ══ API USAGE ═══════════════════════════════════════════════════════════════

router.get("/api/admin/api-usage", adminAuth, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now - 7 * 86400000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [todayRes, weekRes, monthRes, recentRes, dailyRes, pointsVal] = await Promise.all([
      supabase.from("api_usage_log").select("cost_estimate").eq("service", "anthropic").gte("created_at", todayStart),
      supabase.from("api_usage_log").select("cost_estimate").eq("service", "anthropic").gte("created_at", weekStart),
      supabase.from("api_usage_log").select("cost_estimate").eq("service", "anthropic").gte("created_at", monthStart),
      supabase.from("api_usage_log").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("api_usage_log").select("cost_estimate, created_at").eq("service", "anthropic").gte("created_at", new Date(now - 14 * 86400000).toISOString()),
      getDailyPoints(),
    ]);

    const sum = (arr) => (arr || []).reduce((s, r) => s + parseFloat(r.cost_estimate || 0), 0);

    // Daily breakdown for chart
    const dailySpend = {};
    (dailyRes.data || []).forEach(r => {
      const day = new Date(r.created_at).toISOString().split("T")[0];
      dailySpend[day] = (dailySpend[day] || 0) + parseFloat(r.cost_estimate || 0);
    });

    res.json({
      spoonacular: { used: pointsVal, limit: DAILY_POINT_LIMIT, remaining: DAILY_POINT_LIMIT - pointsVal },
      anthropic: {
        today: sum(todayRes.data).toFixed(4),
        week: sum(weekRes.data).toFixed(4),
        month: sum(monthRes.data).toFixed(4),
      },
      recent: recentRes.data || [],
      dailySpend,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ SEARCH STATS ═════════════════════════════════════════════════════════════

router.get("/api/admin/search-stats", adminAuth, async (req, res) => {
  try {
    const { data: searches } = await supabase.from("search_log").select("*").order("created_at", { ascending: false }).limit(1000);
    const zipCounts = {};
    (searches || []).forEach(s => { zipCounts[s.zip] = (zipCounts[s.zip] || 0) + 1; });
    const topZips = Object.entries(zipCounts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([zip, count]) => ({ zip, count }));

    // Daily searches
    const dailySearches = {};
    (searches || []).forEach(s => {
      const day = new Date(s.created_at).toISOString().split("T")[0];
      dailySearches[day] = (dailySearches[day] || 0) + 1;
    });

    res.json({ topZips, dailySearches, totalSearches: (searches || []).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ ERROR LOG ═══════════════════════════════════════════════════════════════

router.get("/api/admin/errors", adminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from("error_log").select("*").order("created_at", { ascending: false }).limit(100);
    res.json({ errors: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/api/admin/errors", adminAuth, async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data, error } = await supabase.from("error_log").delete().lt("created_at", cutoff).select("id");
    if (error) throw new Error(error.message);
    res.json({ deleted: data?.length || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ SERVER INFO ═════════════════════════════════════════════════════════════

router.get("/api/admin/server-info", adminAuth, (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    nodeVersion: process.version,
    uptime: Math.round(process.uptime()),
    uptimeHuman: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`,
    memory: {
      rss: Math.round(mem.rss / 1048576) + " MB",
      heapUsed: Math.round(mem.heapUsed / 1048576) + " MB",
      heapTotal: Math.round(mem.heapTotal / 1048576) + " MB",
    },
    platform: process.platform,
    env: process.env.NODE_ENV || "development",
  });
});

// ══ LEGACY ENDPOINTS (kept for compatibility) ════════════════════════════════

router.get("/api/admin/ad-regions-stats", adminAuth, async (req, res) => {
  try {
    let allData = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase.from("ad_regions").select("store, banner, division, zip3").range(from, from + pageSize - 1);
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
      store, banners: [...info.banners], divisionCount: info.divisions.size, zipCount: info.zips.size,
    })).sort((a, b) => b.zipCount - a.zipCount);
    res.json({ totalRows: allData.length, uniqueStores: stores.length, uniqueZip3s: uniqueZips.size, stores });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Debug endpoints
router.get("/api/debug-kroger-prices", adminAuth, async (req, res) => {
  try {
    const locationId = req.query.locationId;
    const term = req.query.term || "chicken";
    if (!locationId) return res.status(400).json({ error: "locationId required" });
    const token = await getAppToken();
    const r = await fetch(`${KROGER_API_BASE}/products?filter.locationId=${locationId}&filter.term=${encodeURIComponent(term)}&filter.limit=5`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();
    res.json({ products: (data.data || []).slice(0, 5).map(p => ({ name: p.description, brand: p.brand, size: p.items?.[0]?.size || "", priceObject: p.items?.[0]?.price || {} })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/extract-ad", adminAuth, async (req, res) => {
  try {
    const { image, storeName } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: "Anthropic API key not configured" });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 4000, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } }, { type: "text", text: `Extract grocery deals from this ${storeName || "grocery store"} weekly ad image. Return ONLY a valid JSON array. For each item: {"name":"","brand":"","salePrice":"","unit":"","regularPrice":"","dealType":"sale/bogo/percent_off","category":"meat/produce/dairy/bakery/frozen/pantry/snacks/beverages/deli/seafood/household/other","size":"","notes":""}` }] }] }),
    });
    const data = await response.json();
    const text = data.content?.map(c => c.text || "").join("") || "";
    const deals = JSON.parse(text.replace(/```json|```/g, "").trim());
    const enriched = deals.map((d, i) => ({ ...d, id: `ad-${Date.now()}-${i}`, storeName: storeName || "Unknown", source: "ad-extract", image: getCategoryImage(d.category) }));
    res.json({ deals: enriched, count: enriched.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/admin/import-deals", adminAuth, async (req, res) => {
  try {
    const { deals, storeName, zip3 } = req.body;
    if (!deals || !storeName || !zip3) return res.status(400).json({ error: "Missing deals, storeName, or zip3" });
    const cacheKey = `ad-extract:${storeName.toLowerCase().replace(/\s+/g, "-")}:${zip3}`;
    await setCachedDeals(cacheKey, deals);
    res.json({ success: true, cacheKey, count: deals.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
