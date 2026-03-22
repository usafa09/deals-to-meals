import dotenv from 'dotenv';
dotenv.config();
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// ══ PASSWORD GATE — blocks all pages until password entered ══════════════════
app.get("/login.html", (req, res) => {
  res.sendFile(join(__dirname, "public", "login.html"));
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/login.html" ||
      req.path.endsWith(".css") || req.path.endsWith(".woff") ||
      req.path.endsWith(".woff2") || req.path.endsWith(".js")) {
    return next();
  }
  console.log(`[AUTH] path="${req.path}" cookie="${req.cookies?.site_auth}" env="${process.env.SITE_PASSWORD}" match=${req.cookies?.site_auth === process.env.SITE_PASSWORD}`);
  if (req.cookies?.site_auth === process.env.SITE_PASSWORD) {
    return next();
  }
  res.redirect("/login.html");
});
// ═════════════════════════════════════════════════════════════════════════════

app.use(express.static(join(__dirname, "public")));

const KROGER_TOKEN_URL = "https://api.kroger.com/v1/connect/oauth2/token";
const KROGER_AUTH_URL  = "https://api.kroger.com/v1/connect/oauth2/authorize";
const KROGER_API_BASE  = "https://api.kroger.com/v1";
const REDIRECT_URI     = "https://dealstomeals.co/auth/kroger/callback";
const APP_URL          = "https://dealstomeals.co";
const SPOONACULAR_BASE = "https://api.spoonacular.com";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const krogerTokens = new Map();

// ── Ad Regions — maps zip → which stores serve that area ────────────────────

async function getAdRegions(zip) {
  const zip3 = zip.substring(0, 3);
  try {
    const { data, error } = await supabase
      .from("ad_regions")
      .select("store, banner, division, division_code, ad_cycle, notes")
      .eq("zip3", zip3);
    if (error) { console.error("ad_regions query error:", error.message); return []; }
    return data || [];
  } catch (e) { console.error("ad_regions error:", e.message); return []; }
}

// Group ad_regions rows into unique store/banner combos for display
function summarizeRegions(regions) {
  const storeMap = new Map();
  for (const r of regions) {
    const key = `${r.store}:${r.banner}`;
    if (!storeMap.has(key)) {
      storeMap.set(key, {
        store: r.store,
        banner: r.banner,
        division: r.division,
        divisionCode: r.division_code,
        adCycle: r.ad_cycle,
        notes: r.notes,
      });
    }
  }
  return [...storeMap.values()].sort((a, b) => a.banner.localeCompare(b.banner));
}

// ── Supabase Deal Cache (24hr TTL) ──────────────────────────────────────────
const DEAL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function getCachedDeals(cacheKey) {
  try {
    const { data, error } = await supabase
      .from("deal_cache")
      .select("data, fetched_at")
      .eq("cache_key", cacheKey)
      .single();
    if (error || !data) return null;
    const age = Date.now() - new Date(data.fetched_at).getTime();
    if (age > DEAL_CACHE_TTL) return null; // expired
    console.log(`  Cache HIT: ${cacheKey} (${Math.round(age/60000)}min old)`);
    return data.data;
  } catch { return null; }
}

async function setCachedDeals(cacheKey, deals) {
  try {
    const { error } = await supabase
      .from("deal_cache")
      .upsert({ cache_key: cacheKey, data: deals, fetched_at: new Date().toISOString() }, { onConflict: "cache_key" });
    if (error) console.error("Cache write error:", error.message);
    else console.log(`  Cache SET: ${cacheKey} (${Array.isArray(deals) ? deals.length + " items" : "stored"})`);
  } catch (e) { console.error("Cache write error:", e.message); }
}

// ── Spoonacular cache & point tracker ────────────────────────────────────────
const recipeCache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

let dailyPoints = 0;
let pointsResetDate = new Date().toDateString();
const DAILY_POINT_LIMIT = 180;
const POINTS_PER_SEARCH = 3;

// Smart per-lb detection: Kroger API doesn't always flag per-lb in the size field
// but meat/produce priced under ~$15 is almost always per-lb pricing
function detectPerLb(sizeLower, nameLower, price) {
  if (sizeLower === "1 lb" || sizeLower.includes("per lb") || sizeLower.includes("/lb")) return true;
  if (price > 0 && price < 15) {
    const perLbPatterns = [
      /chicken|turkey|duck|cornish/,
      /beef|steak|roast|brisket|ground.*meat|meatloaf/,
      /pork|ham|bacon|ribs|tenderloin|chop/,
      /salmon|tilapia|cod|shrimp|fish|seafood|crab|lobster|tuna.*steak/,
      /sausage|bratwurst|hot dog|kielbasa|chorizo/,
      /lamb|veal/,
      /apple|banana|grape|orange|peach|pear|plum|nectarine|mango|strawberr|blueberr|cherry|melon|watermelon/,
      /potato|sweet potato|onion|tomato|pepper|cucumber|zucchini|squash|broccoli|cauliflower|carrot|celery|mushroom|lettuce|spinach|greens|cabbage|corn.*cob|avocado/,
    ];
    if (perLbPatterns.some(p => p.test(nameLower))) return true;
  }
  return false;
}

function checkAndResetPoints() {
  const today = new Date().toDateString();
  if (today !== pointsResetDate) {
    dailyPoints = 0;
    pointsResetDate = today;
    console.log("Spoonacular daily points reset");
  }
}

function getCacheKey(ingredients, mealType, diets, offset) {
  const ingKey = ingredients.slice(0, 10).map(i => i.name).sort().join(",");
  return `${ingKey}|${mealType}|${(diets||[]).sort().join(",")}|${offset||0}`;
}

const DEAL_CATEGORIES = [
  "chicken", "beef", "pork", "seafood", "turkey", "lamb", "sausage", "bacon",
  "vegetables", "fruit", "salad", "herbs", "mushrooms", "potatoes",
  "pasta", "rice", "bread", "tortilla", "noodles", "grains",
  "dairy", "cheese", "eggs", "yogurt", "butter", "cream",
  "frozen meals", "frozen vegetables", "frozen pizza", "frozen seafood",
  "snacks", "chips", "crackers", "nuts", "popcorn",
  "beverages", "juice", "soda", "water", "tea", "coffee",
  "condiments", "sauce", "oil", "dressing", "spices", "seasoning",
  "soup", "canned goods", "beans", "tomatoes", "broth",
  "breakfast", "cereal", "oatmeal", "pancake",
  "bakery", "dessert", "ice cream", "cookies",
  "deli", "lunch meat", "hot dogs",
];

const DIET_MAP = {
  "Vegan": "vegan",
  "Vegetarian": "vegetarian",
  "Pescetarian": "pescetarian",
  "Keto": "ketogenic",
  "Paleo": "paleo",
  "Gluten-Free": "gluten free",
  "Dairy-Free": "dairy free",
  "Mediterranean": "mediterranean",
};

const MEAL_TYPE_MAP = {
  "Breakfast": "breakfast",
  "Lunch": "main course,salad,soup",
  "Dinner": "main course,side dish,soup",
  "Snack": "snack,fingerfood,appetizer",
  "Dessert": "dessert",
  "Appetizer": "appetizer,fingerfood",
};

const KID_QUERIES = {
  "Breakfast": "pancakes waffles french toast eggs",
  "Lunch": "grilled cheese quesadilla mac cheese sandwich",
  "Dinner": "pasta spaghetti meatballs chicken tacos",
  "Snack": "fruit apple cheese crackers",
  "Dessert": "cookies brownies cupcakes pudding",
  "Appetizer": "mini pizza sliders",
};

async function getAppToken() {
  const credentials = Buffer.from(
    `${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`
  ).toString("base64");
  const res = await fetch(KROGER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${credentials}` },
    body: "grant_type=client_credentials&scope=product.compact",
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).access_token;
}

async function getUser(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

async function refreshKrogerToken(refreshToken) {
  const credentials = Buffer.from(
    `${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`
  ).toString("base64");
  const res = await fetch(KROGER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${credentials}` },
    body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

// ══ SITE LOGIN ════════════════════════════════════════════════════════════════

app.post("/api/site-login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.SITE_PASSWORD) {
    res.setHeader("Set-Cookie", `site_auth=${process.env.SITE_PASSWORD}; Path=/; HttpOnly; Max-Age=86400`);
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Incorrect password" });
  }
});

// ══ KROGER OAUTH ══════════════════════════════════════════════════════════════

app.get("/auth/kroger", (req, res) => {
  const { userId } = req.query;
  const scope = encodeURIComponent("cart.basic:write product.compact");
  const state = userId || "anonymous";
  const url = `${KROGER_AUTH_URL}?client_id=${process.env.KROGER_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}&state=${state}`;
  res.redirect(url);
});

app.get("/auth/kroger/callback", async (req, res) => {
  const { code, state: userId, error } = req.query;
  if (error || !code) return res.redirect(`${APP_URL}/profile.html?kroger=error`);
  try {
    const credentials = Buffer.from(
      `${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`
    ).toString("base64");
    const tokenRes = await fetch(KROGER_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${credentials}` },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    });
    if (!tokenRes.ok) throw new Error(await tokenRes.text());
    const tokens = await tokenRes.json();
    const profileRes = await fetch(`${KROGER_API_BASE}/identity/profile`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    let krogerProfile = {};
    if (profileRes.ok) krogerProfile = (await profileRes.json()).data || {};
    krogerTokens.set(userId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      profile: krogerProfile,
    });
    if (userId !== "anonymous") {
      await supabase.from("profiles").update({ kroger_connected: true }).eq("id", userId);
    }
    res.redirect(`${APP_URL}/profile.html?kroger=success`);
  } catch (err) {
    console.error("Kroger callback error:", err.message);
    res.redirect(`${APP_URL}/profile.html?kroger=error`);
  }
});

app.get("/auth/kroger/disconnect", async (req, res) => {
  const user = await getUser(req);
  if (user) {
    krogerTokens.delete(user.id);
    await supabase.from("profiles").update({ kroger_connected: false }).eq("id", user.id);
  }
  res.json({ success: true });
});

// ══ PROFILE API ═══════════════════════════════════════════════════════════════

app.get("/api/profile", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (error) return res.status(500).json({ error: error.message });
  const krogerData = krogerTokens.get(user.id);
  res.json({ ...data, kroger_connected: !!krogerData, kroger_profile: krogerData?.profile || null });
});

app.patch("/api/profile", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const allowed = ["full_name", "household_size", "dietary_preferences", "favorite_recipe_types", "preferred_store"];
  const updates = {};
  for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("profiles").update(updates).eq("id", user.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ══ SAVED RECIPES API ═════════════════════════════════════════════════════════

app.get("/api/recipes/saved", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { data, error } = await supabase.from("saved_recipes").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ recipes: data });
});

app.post("/api/recipes/saved", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { title, emoji, time, servings, difficulty, ingredients, steps, store_name, image } = req.body;
  const { data, error } = await supabase.from("saved_recipes").insert({
    user_id: user.id, title, emoji, time, servings, difficulty, ingredients, steps, store_name, image,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/recipes/saved/:id", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { error } = await supabase.from("saved_recipes").delete().eq("id", req.params.id).eq("user_id", user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ══ WALMART AUTH ═════════════════════════════════════════════════════════════

function getWalmartHeaders() {
  const consumerId = process.env.WALMART_CONSUMER_ID;
  const privateKeyStr = process.env.WALMART_PRIVATE_KEY;
  if (!consumerId || !privateKeyStr) throw new Error("Walmart credentials not configured");

  const timestamp = Date.now().toString();
  const keyVersion = "1";

  const pemKey = privateKeyStr.includes("-----BEGIN")
    ? privateKeyStr
    : `-----BEGIN PRIVATE KEY-----\n${privateKeyStr}\n-----END PRIVATE KEY-----`;

  const strToSign = `${consumerId}\n${timestamp}\n${keyVersion}\n`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(strToSign);
  const signature = sign.sign(pemKey, "base64");

  return {
    "WM_SEC.KEY_VERSION": keyVersion,
    "WM_CONSUMER.ID": consumerId,
    "WM_CONSUMER.INTIMESTAMP": timestamp,
    "WM_SEC.AUTH_SIGNATURE": signature,
    "WM_SVC.NAME": "Walmart Affiliate APIs",
    "WM_QOS.CORRELATION_ID": Math.random().toString(36).slice(2),
    "Accept": "application/json",
  };
}

const WALMART_API_BASE = "https://developer.api.walmart.com/api-proxy/service/affil/product/v2";

// ══ ALDI API ══════════════════════════════════════════════════════════════════

app.get("/api/aldi/deals", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("aldi_deals")
      .select("*")
      .order("name", { ascending: true })
      .limit(300);
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

app.get("/api/aldi/stores", (req, res) => {
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

app.get("/api/aldi/status", async (req, res) => {
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

// ══ WALMART STORES & DEALS ════════════════════════════════════════════════════

app.get("/api/walmart/stores", async (req, res) => {
  const { zip } = req.query;
  if (!zip) return res.status(400).json({ error: "zip is required" });
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
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/walmart/deals", async (req, res) => {
  try {
    const headers = getWalmartHeaders();
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
            const sale = p.salePrice;
            const regular = p.regularPrice || p.msrp;
            return sale && regular && sale < regular && regular <= 50;
          })
          .map(p => {
            const regular = p.regularPrice || p.msrp;
            const savings = (regular - p.salePrice).toFixed(2);
            const pctOff = Math.round(((regular - p.salePrice) / regular) * 100);
            return {
              id: String(p.itemId), upc: p.upc || "", name: p.name, brand: p.brandName || "",
              category: term, regularPrice: regular.toFixed(2), salePrice: p.salePrice.toFixed(2),
              savings, pctOff, size: p.size || "",
              image: p.thumbnailImage || p.mediumImage || null,
              productUrl: p.productUrl || null, source: "walmart",
            };
          });
        allProducts.push(...items);
      } catch (e) {}
    }));
    const seen = new Set();
    const unique = allProducts
      .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
      .sort((a, b) => b.pctOff - a.pctOff)
      .slice(0, 200);
    res.json({ deals: unique });
  } catch (err) {
    console.error("Walmart deals error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══ STORES API (Kroger) ═══════════════════════════════════════════════════════

app.get("/api/stores", async (req, res) => {
  const { zip, radius } = req.query;
  if (!zip) return res.status(400).json({ error: "zip is required" });
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

// ══ AD REGIONS — which stores serve a given zip ═══════════════════════════════

app.get("/api/ad-regions", async (req, res) => {
  const { zip } = req.query;
  if (!zip) return res.status(400).json({ error: "zip is required" });
  try {
    const regions = await getAdRegions(zip);
    const summary = summarizeRegions(regions);
    console.log(`Ad regions for zip ${zip} (${zip.substring(0,3)}): ${summary.length} store/banners`);
    res.json({
      zip3: zip.substring(0, 3),
      stores: summary,
      count: summary.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ REGIONAL DEALS — fetch deals for ALL stores in a zip using ad_regions ════

app.get("/api/deals/regional", async (req, res) => {
  const { zip, locationId } = req.query;
  if (!zip) return res.status(400).json({ error: "zip is required" });

  try {
    const zip3 = zip.substring(0, 3);
    const regions = await getAdRegions(zip);
    const summary = summarizeRegions(regions);
    console.log(`\n═══ Regional deals for ${zip} (${zip3}) — ${summary.length} chains ═══`);

    const results = { kroger: null, aldi: null, flipp: null, sources: [] };
    const fetchPromises = [];

    // ── Kroger: use division from ad_regions if available ──
    const krogerRegion = summary.find(s => s.store === "kroger");
    if (krogerRegion && locationId) {
      fetchPromises.push((async () => {
        const cacheKey = `kroger:${locationId}`;
        const cached = await getCachedDeals(cacheKey);
        if (cached) {
          results.kroger = cached;
          results.sources.push({ store: "kroger", banner: krogerRegion.banner, division: krogerRegion.division, deals: cached.length, cached: true });
          console.log(`  Kroger ${krogerRegion.banner} (${krogerRegion.division}): ${cached.length} deals [cached]`);
        } else {
          // Fetch live from Kroger API
          try {
            const token = await getAppToken();
            const allProducts = [];
            const batchSize = 8;
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
                      storeName: krogerRegion.banner, source: "kroger",
                    };
                  });
                  allProducts.push(...products);
                } catch (e) {}
              }));
            }
            const seen = new Set();
            const unique = allProducts.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; }).sort((a, b) => b.pctOff - a.pctOff).slice(0, 200);
            await setCachedDeals(cacheKey, unique);
            results.kroger = unique;
            results.sources.push({ store: "kroger", banner: krogerRegion.banner, division: krogerRegion.division, deals: unique.length, cached: false });
            console.log(`  Kroger ${krogerRegion.banner} (${krogerRegion.division}): ${unique.length} deals [live]`);
          } catch (e) {
            console.error(`  Kroger fetch error: ${e.message}`);
            results.sources.push({ store: "kroger", banner: krogerRegion.banner, deals: 0, error: e.message });
          }
        }
      })());
    }

    // ── ALDI: national ad, cache as aldi:national ──
    const aldiRegion = summary.find(s => s.store === "aldi");
    if (aldiRegion) {
      fetchPromises.push((async () => {
        const cacheKey = "aldi:national";
        const cached = await getCachedDeals(cacheKey);
        if (cached) {
          results.aldi = cached;
          results.sources.push({ store: "aldi", banner: "ALDI", division: "National", deals: cached.length, cached: true });
          console.log(`  ALDI National: ${cached.length} deals [cached]`);
        } else {
          results.sources.push({ store: "aldi", banner: "ALDI", division: "National", deals: 0, note: "Run Aldi-v2.js to populate" });
          console.log(`  ALDI National: no cache — run Aldi-v2.js`);
        }
      })());
    }

    // ── Flipp: all other stores, cache by zip3 ──
    const flippStores = summary.filter(s => s.store !== "kroger" && s.store !== "aldi");
    if (flippStores.length > 0) {
      fetchPromises.push((async () => {
        try {
          const deals = await fetchFlippDeals(zip, null);
          results.flipp = deals;
          // Count deals per store
          const storeCounts = {};
          for (const d of deals) {
            const sn = d.storeName || "Unknown";
            storeCounts[sn] = (storeCounts[sn] || 0) + 1;
          }
          results.sources.push({
            store: "flipp", banner: "All via Flipp", division: zip3,
            deals: deals.length, cached: deals._fromCache || false,
            storeBreakdown: storeCounts,
          });
          console.log(`  Flipp (${zip3}): ${deals.length} deals across ${Object.keys(storeCounts).length} stores`);
        } catch (e) {
          console.error(`  Flipp fetch error: ${e.message}`);
          results.sources.push({ store: "flipp", deals: 0, error: e.message });
        }
      })());
    }

    await Promise.all(fetchPromises);

    // Merge all deals into one array
    const allDeals = [
      ...(results.kroger || []),
      ...(results.aldi || []),
      ...(results.flipp || []),
    ];

    console.log(`═══ Total: ${allDeals.length} deals from ${results.sources.length} sources ═══\n`);

    res.json({
      zip3,
      totalDeals: allDeals.length,
      deals: allDeals,
      sources: results.sources,
      availableChains: summary.map(s => s.banner),
    });
  } catch (err) {
    console.error("Regional deals error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══ DEALS API (Kroger) ════════════════════════════════════════════════════════

app.get("/api/deals", async (req, res) => {
  const { locationId } = req.query;
  if (!locationId) return res.status(400).json({ error: "locationId is required" });
  try {
    // Check Supabase cache first (keyed by locationId)
    const cacheKey = `kroger:${locationId}`;
    const dbCached = await getCachedDeals(cacheKey);
    if (dbCached) {
      console.log(`Kroger Supabase cache HIT for location ${locationId} (${dbCached.length} deals)`);
      return res.json({ deals: dbCached, cached: true });
    }

    console.log(`Kroger cache MISS for location ${locationId} — fetching live...`);
    const token = await getAppToken();
    const allProducts = [];
    const batchSize = 8;
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
            };
          });
          allProducts.push(...products);
        } catch (e) {}
      }));
    }
    const seen = new Set();
    const unique = allProducts
      .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
      .sort((a, b) => b.pctOff - a.pctOff)
      .slice(0, 200);

    // Save to Supabase
    await setCachedDeals(cacheKey, unique);
    console.log(`Kroger: saved ${unique.length} deals for location ${locationId}`);

    res.json({ deals: unique });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ SPOONACULAR RECIPE SEARCH ═════════════════════════════════════════════════

app.post("/api/recipes/search", async (req, res) => {
  const { ingredients, mealType, diets, coupons, boostDeals, offset: reqOffset } = req.body;
  if (!ingredients?.length) return res.status(400).json({ error: "ingredients required" });

  try {
    const apiKey = process.env.SPOONACULAR_API_KEY;
    const offset = reqOffset || 0;

    const cacheKey = getCacheKey(ingredients, mealType, diets, offset);
    const cached = recipeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log("Serving cached recipes");
      return res.json({ recipes: cached.recipes, cached: true });
    }

    checkAndResetPoints();
    if (dailyPoints + POINTS_PER_SEARCH > DAILY_POINT_LIMIT) {
      return res.status(429).json({ error: "Daily recipe search limit reached. Please try again tomorrow." });
    }

    const typeStr = MEAL_TYPE_MAP[mealType] || "main course";
    const isKidFriendly = diets?.includes("Kid Friendly");
    const dietStr = diets?.length
      ? diets.filter(d => d !== "Kid Friendly" && DIET_MAP[d]).map(d => DIET_MAP[d]).join(",")
      : "";

    let searchParams;

    if (isKidFriendly) {
      searchParams = new URLSearchParams({
        apiKey,
        query: KID_QUERIES[mealType] || "pasta chicken rice",
        type: typeStr,
        number: "50",
        offset: String(offset),
        maxReadyTime: "45",
        sort: "popularity",
        sortDirection: "desc",
        addRecipeInformation: "true",
        fillIngredients: "true",
        instructionsRequired: "true",
        excludeIngredients: "alcohol,wine,beer,chili,cayenne,jalapeno,sriracha,wasabi,anchovies,liver,habanero",
      });
    } else {
      const skipBrandWords = new Set(["appleton","farms","happy","fremont","fish","simply","nature","carlini","cattlemens","ranch","southern","grove","stonemill","bakers","corner","specially","selected","park","street","deli","casa","mamita","mama","cozzis","millville","brookdale","reggano","savoritz","emporium","friendly","barissimo","choceur","clancys","moser","roth","elevation","health","ade","northern","catch","poppi","bremer","never","any","market","kitchen","aldi"]);
      const cleanIngName = (name) => name.toLowerCase().replace(/[^a-z\s]/g," ").split(" ").filter(w => w.length > 2 && !skipBrandWords.has(w)).slice(-3).join(" ");
      const ingredientStr = ingredients.slice(0, 20).map(i => cleanIngName(i.name)).join(",");
      searchParams = new URLSearchParams({
        apiKey,
        includeIngredients: ingredientStr,
        type: typeStr,
        number: "50",
        offset: String(offset),
        sort: "max-used-ingredients",
        sortDirection: "desc",
        addRecipeInformation: "true",
        fillIngredients: "true",
        instructionsRequired: "true",
      });
      if (dietStr) searchParams.set("diet", dietStr);
      if (diets?.includes("Halal")) searchParams.set("excludeIngredients", "pork,bacon,lard,gelatin,alcohol,wine,beer");
      if (diets?.includes("Kosher")) searchParams.set("excludeIngredients", "pork,shellfish,bacon,lard");
      if (diets?.includes("Low Calorie")) searchParams.set("maxCalories", "500");
      if (diets?.includes("High Fiber")) searchParams.set("minFiber", "8");
    }

    dailyPoints += POINTS_PER_SEARCH;
    console.log(`Spoonacular points used today: ${dailyPoints}/${DAILY_POINT_LIMIT}`);

    const searchRes = await fetch(`${SPOONACULAR_BASE}/recipes/complexSearch?${searchParams}`);
    if (!searchRes.ok) throw new Error(await searchRes.text());
    const searchData = await searchRes.json();
    const recipes = searchData.results || [];

    // ── IMPROVED findDeal: works for ALDI brand names and short ingredient words ──
    function findDeal(recipeIngName) {
      const skipWords = new Set([
        "the","and","with","for","from","fresh","frozen","organic","natural","premium",
        "classic","original","style","grade","boneless","skinless","extra","large","small",
        "medium","value","family","pack","brand","whole","fat","reduced","low","lite","light",
        "sliced","diced","chopped","shredded","roasted","grilled","baked","seasoned",
      ]);

      const recipeWords = recipeIngName.toLowerCase()
        .replace(/[^a-z\s]/g, "")
        .split(" ")
        .filter(w => w.length > 2 && !skipWords.has(w));

      if (!recipeWords.length) return null;

      let bestDeal = null;
      let bestScore = 0;

      for (const ing of ingredients) {
        const dealName = ing.name.toLowerCase()
          .replace(/[^a-z\s]/g, " ")
          .replace(/\b(aldi|appleton farms|happy farms|never any|fremont fish|simply nature|carlini|cattlemens ranch|southern grove|stonemill|bakers corner|baker s corner|specially selected|park street deli|casa mamita|mama cozzis|millville|brookdale|chef s cupboard|reggano|savoritz|emporium selection|friendly farms|barissimo|choceur|clancy s|moser roth|elevation|health ade|northern catch|poppi|bremer)\b/g, "")
          .trim();

        let score = 0;
        for (const word of recipeWords) {
          if (dealName.includes(word)) score++;
        }

        const isAldi = ing.source === "aldi";
        const minScore = isAldi ? 1 : (recipeWords.length === 1 ? 1 : 2);

        if (score >= minScore && score > bestScore) {
          bestScore = score;
          bestDeal = ing;
        }
      }
      return bestDeal;
    }

    // ── Enrich each recipe ────────────────────────────────────────────────────
    const enriched = recipes.map(recipe => {
      const usedSaleItems = [];
      let totalSavings = 0;
      let estimatedCost = 0;

      const allRecipeIngs = [
        ...(recipe.usedIngredients || []),
        ...(recipe.missedIngredients || []),
      ];
      for (const ing of allRecipeIngs) {
        const deal = findDeal(ing.name);
        if (deal) {
          const salePrice = parseFloat(deal.salePrice?.replace(/[^0-9.]/g, "")) || 0;
          const regularPrice = parseFloat(deal.regularPrice?.replace(/[^0-9.]/g, "")) || 0;
          const savingsAmt = deal.savings
            ? parseFloat(deal.savings?.replace(/[^0-9.]/g, "")) || 0
            : (regularPrice > salePrice ? regularPrice - salePrice : 0);

          usedSaleItems.push({
            name: deal.name,
            salePrice: deal.salePrice,
            regularPrice: deal.regularPrice || "—",
            savings: savingsAmt > 0 ? savingsAmt.toFixed(2) : "",
            upc: deal.upc,
          });
          totalSavings += savingsAmt;
          estimatedCost += salePrice;
        }
      }
      estimatedCost += (recipe.missedIngredientCount || 0) * 0.5;

      const allCoupons = [...(coupons || []), ...(boostDeals || [])];
      const couponsToClip = allCoupons.filter(c => {
        const desc = (c.description + " " + c.brand).toLowerCase();
        return (recipe.usedIngredients || []).some(ing =>
          desc.includes(ing.name.toLowerCase().split(" ")[0])
        );
      }).map(c => ({ description: c.description, savings: c.savings, clipped: c.clipped, type: c.type }));

      return {
        id: recipe.id,
        title: recipe.title,
        image: recipe.image,
        time: recipe.readyInMinutes ? `${recipe.readyInMinutes} min` : "N/A",
        readyInMinutes: recipe.readyInMinutes || 0,
        servings: recipe.servings || 4,
        usedIngredientCount: recipe.usedIngredientCount || 0,
        missedIngredientCount: recipe.missedIngredientCount || 0,
        usedSaleItems,
        totalSavings: parseFloat(totalSavings.toFixed(2)),
        estimatedCost: parseFloat(estimatedCost.toFixed(2)),
        couponsToClip,
        diets: recipe.diets || [],
        cuisines: recipe.cuisines || [],
        instructions: recipe.analyzedInstructions?.[0]?.steps?.map(s => s.step) || [],
        allIngredients: [
          ...(recipe.usedIngredients || []).map(i => ({ name: i.name, onSale: !!findDeal(i.name) })),
          ...(recipe.missedIngredients || []).filter(i => !findDeal(i.name)).map(i => ({ name: i.name, onSale: false })),
        ],
      };
    });

    enriched.sort((a, b) => b.totalSavings - a.totalSavings);

    recipeCache.set(cacheKey, { recipes: enriched, timestamp: Date.now() });
    for (const [key, val] of recipeCache.entries()) {
      if (Date.now() - val.timestamp > CACHE_TTL) recipeCache.delete(key);
    }

    res.json({ recipes: enriched, cached: false, pointsUsedToday: dailyPoints, pointsRemaining: DAILY_POINT_LIMIT - dailyPoints });
  } catch (err) {
    console.error("Recipe search error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══ CLAUDE AI RECIPE GENERATION ══════════════════════════════════════════════

const aiRecipeCache = new Map();

app.post("/api/recipes/ai", async (req, res) => {
  const { ingredients, style, diets, wantItems, haveItems, offset } = req.body;
  if (!ingredients?.length) return res.status(400).json({ error: "ingredients required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured. Add it to your .env file." });

  try {
    // Build a cache key from the inputs
    const cacheKey = JSON.stringify({ items: ingredients.slice(0, 25).map(i => i.name).sort(), style, diets, wantItems: wantItems || "", haveItems: haveItems || "", offset: offset || 0 });
    const cached = aiRecipeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 1800000) { // 30 min cache
      console.log("Serving cached AI recipes");
      return res.json({ recipes: cached.recipes, cached: true });
    }

    const mustInclude = ingredients.filter(i => i.mustInclude).map(i => i.name);
    const mustIncludeNote = mustInclude.length
      ? `\n\nIMPORTANT: The customer specifically wants these items used: ${mustInclude.join(", ")}. Every recipe MUST use at least one of these.`
      : "";

    const wantNote = wantItems?.trim()
      ? `\n\nADDITIONAL ITEMS TO BUY: The customer also wants to purchase these items (not on sale): ${wantItems.trim()}. Include these in recipes AND mark them with (ADDITIONAL) in the ingredients list.`
      : "";
    const haveNote = haveItems?.trim()
      ? `\n\nITEMS ALREADY ON HAND: The customer already has these at home: ${haveItems.trim()}. Use these freely in recipes and mark them with (ON HAND) in the ingredients list. Do NOT include these in the estimated cost.`
      : "";
    const customNote = wantNote + haveNote;

    // Explicit dietary restriction definitions with excluded ingredient keywords
    const DIET_RULES = {
      "Vegetarian": {
        rule: "VEGETARIAN: Absolutely NO meat, poultry, or fish of any kind. Eggs and dairy ARE allowed.",
        exclude: ["chicken","beef","pork","turkey","bacon","ham","sausage","salmon","shrimp","tilapia","tuna","cod","lamb","steak","ribs","roast","meatball","hot dog","ground beef","ground turkey","brisket","pepperoni","salami","deli meat","fish","seafood","crab","lobster","clam","mussel","anchov"]
      },
      "Vegan": {
        rule: "VEGAN: NO animal products whatsoever. No meat, fish, dairy, eggs, butter, cheese, cream, honey.",
        exclude: ["chicken","beef","pork","turkey","bacon","ham","sausage","salmon","shrimp","tilapia","tuna","cod","lamb","steak","ribs","fish","seafood","milk","cheese","butter","yogurt","cream","egg","honey","whey","casein","gelatin","lard"]
      },
      "Gluten-Free": {
        rule: "GLUTEN-FREE: No wheat, barley, rye, or regular pasta/bread/flour. Use rice, potatoes, corn, gluten-free alternatives.",
        exclude: ["bread","pasta","spaghetti","noodle","flour tortilla","cracker","cookie","cake","pie crust","croissant","bagel","muffin","pancake mix","biscuit","pretzel","wheat","barley","rye","couscous"]
      },
      "Dairy-Free": {
        rule: "DAIRY-FREE: No milk, cheese, butter, cream, yogurt, sour cream, ice cream, or any dairy product.",
        exclude: ["milk","cheese","butter","yogurt","cream","sour cream","ice cream","whipped cream","half and half","cottage cheese","cream cheese"]
      },
      "Keto": {
        rule: "KETO: Very low carb (under 20g net carbs per serving). No bread, pasta, rice, potatoes, sugar, corn, or beans.",
        exclude: ["bread","pasta","rice","potato","sugar","corn","beans","cereal","oatmeal","flour","tortilla","chip","cracker","juice","soda"]
      },
      "Paleo": {
        rule: "PALEO: No grains, dairy, legumes, refined sugar, or processed foods.",
        exclude: ["bread","pasta","rice","cheese","milk","yogurt","butter","beans","lentil","peanut","soy","corn","cereal","oatmeal","sugar"]
      },
      "Low Calorie": {
        rule: "LOW CALORIE: Each serving must be under 500 calories. Lean proteins, lots of vegetables, minimal oil/butter/cheese.",
        exclude: []
      },
      "High Fiber": {
        rule: "HIGH FIBER: Each serving should have 8+ grams of fiber. Prioritize beans, lentils, whole grains, vegetables.",
        exclude: []
      },
      "Pescetarian": {
        rule: "PESCETARIAN: No meat or poultry. Fish and seafood ARE allowed. No chicken, beef, pork, turkey, bacon, ham, sausage.",
        exclude: ["chicken","beef","pork","turkey","bacon","ham","sausage","lamb","steak","ribs","roast","meatball","hot dog","ground beef","ground turkey","brisket","pepperoni","salami","deli meat"]
      },
      "Mediterranean": {
        rule: "MEDITERRANEAN: Focus on olive oil, fish, whole grains, vegetables, legumes, nuts. Limit red meat.",
        exclude: []
      },
      "Halal": {
        rule: "HALAL: No pork, bacon, ham, lard, or alcohol/wine in cooking.",
        exclude: ["pork","bacon","ham","lard","pepperoni","salami","prosciutto"]
      },
      "Kosher": {
        rule: "KOSHER: No pork or shellfish. Do not mix meat and dairy in the same recipe.",
        exclude: ["pork","bacon","ham","shrimp","crab","lobster","clam","mussel","oyster","scallop"]
      },
    };

    // Filter out sale items that violate dietary restrictions BEFORE sending to AI
    let filteredIngredients = [...ingredients];
    let dietNote = "";
    if (diets?.length) {
      const allExcluded = new Set();
      const rules = [];
      for (const d of diets) {
        const info = DIET_RULES[d];
        if (!info) continue;
        rules.push(info.rule);
        for (const term of info.exclude) allExcluded.add(term);
      }
      if (allExcluded.size > 0) {
        const before = filteredIngredients.length;
        filteredIngredients = filteredIngredients.filter(i => {
          const name = i.name.toLowerCase();
          return ![...allExcluded].some(term => name.includes(term));
        });
        const removed = before - filteredIngredients.length;
        if (removed > 0) console.log(`Diet filter: removed ${removed} items that violate ${diets.join(", ")} restrictions`);
      }
      dietNote = `\n\n⚠️ STRICT DIETARY RESTRICTIONS — THESE ARE ABSOLUTE AND MUST NEVER BE VIOLATED:\n${rules.join("\n")}\n\nI have already removed sale items that violate these restrictions from the list below. Do NOT add any ingredients that violate these rules. Do NOT suggest meat/fish/dairy substitutions if those are restricted. Every single recipe must fully comply.`;
    }

    // Build the sale items list for the prompt (using filtered list)
    const saleItemsList = filteredIngredients.slice(0, 20).map(i => {
      const parts = [i.name];
      if (i.salePrice) {
        const unit = i.priceUnit || "";
        parts.push(`$${i.salePrice}${unit}`);
      }
      if (i.regularPrice && i.regularPrice !== i.salePrice) {
        const unit = i.priceUnit || "";
        parts.push(`(reg $${i.regularPrice}${unit})`);
      }
      if (i.storeName) parts.push(`at ${i.storeName}`);
      return "- " + parts.join(" ");
    }).join("\n");


    const styleGuide = {
      "Quick Weeknight": "30 minutes or less total time. Minimal prep, one pan/pot preferred. Think sheet pan meals, stir fries, tacos, simple pasta dishes.",
      "Family-Friendly": "Kid-approved flavors — nothing too spicy or exotic. Think mac and cheese, chicken tenders, sloppy joes, pizza, meatballs, quesadillas, burgers. Picky eater safe.",
      "Comfort Food": "Hearty, warming, filling. Casseroles, soups, stews, chili, pot pies, meatloaf, baked pasta, one-pot meals. The kind of food grandma would make.",
      "Meal Prep": "Makes 4-6 servings that reheat well. Good for packing lunches. Think grain bowls, burritos, soups, casseroles that last 3-4 days in the fridge.",
      "Healthy & Light": "Under 500 calories per serving. Lots of vegetables, lean proteins, whole grains. Light on cheese/cream/butter. Think salads, grain bowls, grilled proteins with roasted veggies.",
      "Slow Cooker": "Dump-and-go crockpot recipes. 6-8 hour cook time, minimal prep. Think pulled pork, chicken tacos, soups, stews, pot roast. Set it and forget it.",
    };

    const styleDesc = styleGuide[style] || "Budget-friendly family meals.";
    const batchNote = (offset && offset > 0) ? `\n\nThis is batch #${Math.floor(offset/8)+1}. Generate 8 DIFFERENT recipes from previous batches. Be creative — try different cuisines, cooking methods, and flavor profiles.` : "";

    const prompt = `You are a budget-friendly recipe assistant. A customer is shopping grocery deals and wants recipe ideas based on what's on sale this week.

RECIPE STYLE: ${style}
${styleDesc}

HERE ARE THE ITEMS ON SALE THIS WEEK:
${saleItemsList}
${mustIncludeNote}${customNote}${batchNote}

Generate exactly 8 recipes. Each recipe should:
- Use 2-5 of the sale items above as key ingredients
- Be genuinely budget-friendly (under $12 total for 4 servings)
- Include simple pantry staples the customer likely already has (salt, pepper, oil, garlic, onion, butter, flour, etc.)
- Have clear, numbered step-by-step instructions a beginner cook could follow
- Be a REAL recipe that actually works — not made up combinations
${dietNote}

Respond with ONLY valid JSON, no other text. Use this exact format:
{
  "recipes": [
    {
      "title": "Recipe Name",
      "cookTime": 25,
      "servings": 4,
      "saleItemsUsed": ["Chicken Thighs", "Rice"],
      "ingredients": [
        {"item": "1.5 lbs chicken thighs", "type": "SALE", "matchName": "Chicken Thighs"},
        {"item": "2 cups rice", "type": "SALE", "matchName": "Rice"},
        {"item": "1 lb fresh broccoli", "type": "ADDITIONAL", "matchName": ""},
        {"item": "2 cups cooked quinoa", "type": "ON_HAND", "matchName": ""},
        {"item": "3 cloves garlic", "type": "PANTRY", "matchName": ""},
        {"item": "1 tbsp olive oil", "type": "PANTRY", "matchName": ""},
        {"item": "Salt and pepper to taste", "type": "PANTRY", "matchName": ""}
      ],
      "instructions": [
        "Preheat oven to 400°F.",
        "Season chicken thighs with salt, pepper, and garlic.",
        "Heat olive oil in an oven-safe skillet over medium-high heat.",
        "Sear chicken skin-side down for 4 minutes until golden.",
        "Flip and transfer skillet to oven for 20 minutes.",
        "Meanwhile, cook rice according to package directions.",
        "Serve chicken over rice."
      ]
    }
  ]
}

IMPORTANT ingredient type rules:
- "SALE" = item from the sale list above. "matchName" MUST exactly match one of the sale item names listed above.
- "ADDITIONAL" = item the customer said they want to buy (from ADDITIONAL ITEMS list). 
- "ON_HAND" = item the customer already has (from ON HAND list).
- "PANTRY" = common staples most people have (salt, pepper, oil, garlic, onion, butter, flour, sugar, spices, vinegar, soy sauce, etc.)
- Do NOT include "estimatedCost" — we calculate that from real prices.`;

    console.log(`Calling Claude AI for ${style} recipes with ${ingredients.length} sale items...`);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Claude API error:", response.status, errText);
      throw new Error(`Claude API error ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    const stopReason = data.stop_reason || "";
    if (stopReason === "max_tokens") console.log("⚠️ AI response was truncated (hit max_tokens limit)");
    console.log(`AI response: ${text.length} chars, stop_reason: ${stopReason}`);

    // Parse JSON from response (strip markdown fences if present)
    let clean = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      // Response may have been truncated — try to recover partial recipes
      console.log("Initial JSON parse failed, attempting recovery...");
      try {
        // Find the last complete recipe object by looking for the last complete "}," or "}" before truncation
        const recipesStart = clean.indexOf('"recipes"');
        if (recipesStart === -1) throw new Error("No recipes found");
        
        // Find all complete recipe objects using a bracket counter
        const arrayStart = clean.indexOf('[', recipesStart);
        if (arrayStart === -1) throw new Error("No recipe array found");
        
        let depth = 0;
        let lastCompleteRecipe = -1;
        let inString = false;
        let escape = false;
        
        for (let i = arrayStart + 1; i < clean.length; i++) {
          const c = clean[i];
          if (escape) { escape = false; continue; }
          if (c === '\\') { escape = true; continue; }
          if (c === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (c === '{') depth++;
          if (c === '}') { depth--; if (depth === 0) lastCompleteRecipe = i; }
        }
        
        if (lastCompleteRecipe > arrayStart) {
          const recovered = clean.substring(0, lastCompleteRecipe + 1) + ']}';
          parsed = JSON.parse(recovered);
          console.log(`Recovered ${parsed.recipes?.length || 0} complete recipes from truncated response`);
        } else {
          throw new Error("Could not recover any complete recipes");
        }
      } catch (e2) {
        console.error("Failed to parse AI recipe response:", text.substring(0, 500));
        throw new Error("AI returned invalid recipe format. Please try again.");
      }
    }

    const recipes = (parsed.recipes || []).map((r, idx) => {
      // ── Match sale items to real deal data for accurate pricing ──
      const usedSaleItems = [];
      let totalSavings = 0;
      let saleCost = 0;       // what you'll pay for sale items
      let regularCost = 0;    // what those items would cost at regular price
      let additionalCost = 0; // estimated cost for non-sale items you need to buy

      // Build a lookup for quick matching
      const ingredientLookup = ingredients.map(ing => ({
        ...ing,
        nameLower: ing.name.toLowerCase(),
        nameWords: ing.name.toLowerCase().split(/[\s,\-\/]+/).filter(w => w.length > 2),
      }));

      // Process structured ingredients from AI
      const processedIngredients = (r.ingredients || []).map(ing => {
        // Handle both new structured format and legacy string format
        const isStructured = typeof ing === "object" && ing.item;
        const itemText = isStructured ? ing.item : String(ing);
        const type = isStructured ? (ing.type || "PANTRY") : 
          (itemText.toLowerCase().includes("on sale") ? "SALE" : 
           itemText.toLowerCase().includes("additional") ? "ADDITIONAL" :
           itemText.toLowerCase().includes("on hand") ? "ON_HAND" : "PANTRY");
        const matchName = isStructured ? (ing.matchName || "") : "";

        let matchedDeal = null;

        if (type === "SALE") {
          // Try exact matchName first
          if (matchName) {
            const matchLower = matchName.toLowerCase();
            matchedDeal = ingredientLookup.find(d => d.nameLower === matchLower);
            if (!matchedDeal) {
              // Try partial matching: score each deal by how many words match
              const matchWords = matchLower.split(/[\s,\-\/]+/).filter(w => w.length > 2);
              let bestScore = 0;
              for (const d of ingredientLookup) {
                const score = matchWords.filter(w => d.nameLower.includes(w)).length;
                if (score > bestScore && score >= Math.min(2, matchWords.length)) {
                  bestScore = score;
                  matchedDeal = d;
                }
              }
            }
          }
          // Fallback: try matching from the ingredient text itself
          if (!matchedDeal) {
            const textLower = itemText.toLowerCase();
            const textWords = textLower.split(/[\s,\-\/]+/).filter(w => w.length > 2);
            let bestScore = 0;
            for (const d of ingredientLookup) {
              const score = d.nameWords.filter(w => textWords.some(tw => tw.includes(w) || w.includes(tw))).length;
              if (score > bestScore && score >= 1) {
                bestScore = score;
                matchedDeal = d;
              }
            }
          }
        }

        let isPerLb = false;
        let qty = 1;
        let itemActualCost = null;

        if (matchedDeal) {
          const sale = parseFloat(String(matchedDeal.salePrice).replace(/[^0-9.]/g, "")) || 0;
          const reg = parseFloat(String(matchedDeal.regularPrice).replace(/[^0-9.]/g, "")) || 0;
          isPerLb = matchedDeal.isPerLb || matchedDeal.priceUnit === "/lb";
          
          // For per-lb items, use TYPICAL PACKAGE SIZE (what you actually buy at the store)
          if (isPerLb) {
            const nameLower = (matchedDeal.name || "").toLowerCase();
            if (nameLower.match(/chicken breast|boneless.*chicken|skinless.*chicken/)) qty = 2.5;
            else if (nameLower.match(/chicken thigh|drumstick|chicken leg|wing/)) qty = 2.5;
            else if (nameLower.match(/whole chicken|roaster/)) qty = 5;
            else if (nameLower.match(/ground beef|ground turkey|ground pork/)) qty = 1;
            else if (nameLower.match(/steak/)) qty = 1.5;
            else if (nameLower.match(/beef.*roast|brisket/)) qty = 3;
            else if (nameLower.match(/pork tenderloin/)) qty = 1.5;
            else if (nameLower.match(/pork chop|pork loin/)) qty = 2;
            else if (nameLower.match(/ribs|rack/)) qty = 3;
            else if (nameLower.match(/salmon|tilapia|cod|fish/)) qty = 1;
            else if (nameLower.match(/shrimp/)) qty = 1;
            else if (nameLower.match(/sausage|bratwurst|kielbasa/)) qty = 1;
            else if (nameLower.match(/bacon/)) qty = 1;
            else if (nameLower.match(/apple|orange|pear/)) qty = 3;
            else if (nameLower.match(/banana/)) qty = 2;
            else if (nameLower.match(/grape|strawberr|blueberr|cherry/)) qty = 1;
            else if (nameLower.match(/potato|sweet potato/)) qty = 3;
            else if (nameLower.match(/onion/)) qty = 1;
            else if (nameLower.match(/tomato|pepper|cucumber|zucchini|squash/)) qty = 0.75;
            else if (nameLower.match(/broccoli|cauliflower/)) qty = 1.5;
            else if (nameLower.match(/carrot|celery/)) qty = 1;
            else if (nameLower.match(/lettuce|spinach|greens/)) qty = 0.75;
            else if (nameLower.match(/mushroom/)) qty = 0.5;
            else qty = 1;
          }
          
          const itemSaleCost = sale * qty;
          const itemRegCost = reg * qty;
          const savings = itemRegCost > itemSaleCost && itemSaleCost > 0 ? itemRegCost - itemSaleCost : 0;
          itemActualCost = itemSaleCost.toFixed(2);

          usedSaleItems.push({
            name: matchedDeal.name,
            salePrice: isPerLb ? `$${sale.toFixed(2)}/lb` : (matchedDeal.salePrice || ""),
            regularPrice: isPerLb ? `$${reg.toFixed(2)}/lb` : (matchedDeal.regularPrice || "—"),
            actualCost: itemActualCost,
            packageNote: isPerLb ? `~${qty} lb pkg ≈ $${itemSaleCost.toFixed(2)}` : "",
            savings: savings > 0 ? savings.toFixed(2) : "",
            storeName: matchedDeal.storeName || "",
            isPerLb,
            qty,
          });

          saleCost += itemSaleCost;
          regularCost += itemRegCost > 0 ? itemRegCost : itemSaleCost;
          totalSavings += savings;
        }

        // Estimate cost for ADDITIONAL items (not on sale, needs to be bought)
        if (type === "ADDITIONAL") {
          additionalCost += 2.50; // average cost estimate per non-sale grocery item
        }

        return {
          name: itemText.replace(/\s*\(ON SALE\)|\(ADDITIONAL\)|\(ON HAND\)/gi, "").trim(),
          type,
          onSale: type === "SALE" && matchedDeal !== null,
          matchedDeal: matchedDeal ? { 
            name: matchedDeal.name, 
            salePrice: matchedDeal.salePrice, 
            regularPrice: matchedDeal.regularPrice,
            isPerLb,
            actualCost: itemActualCost,
          } : null,
        };
      });

      // Final cost = sale items at sale price + additional items estimate
      // ON_HAND and PANTRY items cost $0 (customer already has them)
      const estimatedCost = saleCost + additionalCost;
      const regularPriceTotal = regularCost + additionalCost;

      return {
        id: `ai-${Date.now()}-${idx}`,
        title: r.title,
        image: null,
        time: r.cookTime ? `${r.cookTime} min` : "N/A",
        readyInMinutes: r.cookTime || 0,
        servings: r.servings || 4,
        usedIngredientCount: usedSaleItems.length,
        missedIngredientCount: 0,
        usedSaleItems,
        totalSavings: parseFloat(totalSavings.toFixed(2)),
        estimatedCost: parseFloat(estimatedCost.toFixed(2)) || 0,
        regularPriceTotal: parseFloat(regularPriceTotal.toFixed(2)) || 0,
        saleCost: parseFloat(saleCost.toFixed(2)),
        additionalCost: parseFloat(additionalCost.toFixed(2)),
        couponsToClip: [],
        diets: diets || [],
        cuisines: [],
        instructions: r.instructions || [],
        allIngredients: processedIngredients,
      };
    });

    recipes.sort((a, b) => b.totalSavings - a.totalSavings);

    // Fetch food images from Pexels for each recipe
    const pexelsKey = process.env.PEXELS_API_KEY;
    if (pexelsKey) {
      console.log("Fetching recipe images from Pexels...");
      const imageResults = await Promise.allSettled(recipes.map(async (r) => {
        // Clean recipe title for better search - extract the food name
        const query = r.title.replace(/[^\w\s]/g, "").trim();
        try {
          const pRes = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query + " food")}&per_page=1&orientation=landscape`, {
            headers: { Authorization: pexelsKey },
          });
          if (!pRes.ok) return null;
          const pData = await pRes.json();
          const photo = pData.photos?.[0];
          return photo ? {
            url: photo.src?.medium || photo.src?.small || null,
            photographer: photo.photographer || "",
            pexelsUrl: photo.url || "",
          } : null;
        } catch { return null; }
      }));
      for (let i = 0; i < recipes.length; i++) {
        const result = imageResults[i];
        if (result?.status === "fulfilled" && result.value?.url) {
          recipes[i].image = result.value.url;
          recipes[i].photoCredit = result.value.photographer;
          recipes[i].photoUrl = result.value.pexelsUrl;
        }
      }
      const found = recipes.filter(r => r.image).length;
      console.log(`Pexels images: ${found}/${recipes.length} recipes have photos`);
    } else {
      console.log("No PEXELS_API_KEY configured — skipping recipe images");
    }

    // Cache results
    aiRecipeCache.set(cacheKey, { recipes, timestamp: Date.now() });
    // Clean old cache entries
    for (const [key, val] of aiRecipeCache.entries()) {
      if (Date.now() - val.timestamp > 1800000) aiRecipeCache.delete(key);
    }

    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    const cost = (inputTokens * 1 + outputTokens * 5) / 1000000;
    console.log(`AI recipes generated: ${recipes.length} recipes, ${inputTokens}+${outputTokens} tokens, ~$${cost.toFixed(4)}`);

    res.json({ recipes, cached: false, tokens: { input: inputTokens, output: outputTokens, cost: cost.toFixed(4) } });
  } catch (err) {
    console.error("AI recipe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══ COUPONS API ═══════════════════════════════════════════════════════════════

app.get("/api/coupons", async (req, res) => {
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

app.post("/api/cart", async (req, res) => {
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

// ══ POINTS STATUS ═════════════════════════════════════════════════════════════

app.get("/api/points", (req, res) => {
  checkAndResetPoints();
  res.json({ used: dailyPoints, limit: DAILY_POINT_LIMIT, remaining: DAILY_POINT_LIMIT - dailyPoints, resetsAt: "midnight" });
});

// ══ DEBUG ══════════════════════════════════════════════════════════════════════

app.get("/api/debug-kroger-prices", async (req, res) => {
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
    // Return raw price objects for first 5 products
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

app.get("/api/debug-walmart", async (req, res) => {
  try {
    const headers = getWalmartHeaders();
    const zip = req.query.zip || "10001";
    const r = await fetch(`https://developer.api.walmart.com/api-proxy/service/affil/product/v2/stores?zip=${zip}`, { headers });
    const text = await r.text();
    res.json({ status: r.status, raw: text.slice(0, 1000) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/debug-recipes", async (req, res) => {
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

// ══ FLIPP INTEGRATION ═════════════════════════════════════════════════════
// Universal grocery deals from weekly ads — covers Publix, Albertsons,
// Safeway, Target, Meijer, HEB, Food Lion, Sprouts, and hundreds more.
// Queries backflipp.wishabi.com live, caches 1 hour per zip.
// ══════════════════════════════════════════════════════════════════════════

const FLIPP_API = "https://backflipp.wishabi.com/flipp";
const flippCache = new Map();
const FLIPP_CACHE_TTL = 60 * 60 * 1000; // 1 hour

const FLIPP_SKIP_STORES = new Set([
  "aldi", "kroger", "ralphs", "fred meyer", "king soopers",
  "harris teeter", "smith's", "fry's", "qfc", "mariano's", "dillons",
  "pick n save", "city market", "baker's",
]);

function shouldSkipFlippStore(name) {
  const lower = (name || "").toLowerCase();
  for (const skip of FLIPP_SKIP_STORES) {
    if (lower.includes(skip)) return true;
  }
  return false;
}

const FLIPP_SEARCH_TERMS = [
  "chicken", "beef", "pork", "ground beef", "steak", "salmon", "shrimp",
  "turkey", "sausage", "bacon", "hot dogs", "tilapia", "tuna",
  "apples", "bananas", "oranges", "strawberries", "grapes",
  "avocado", "tomatoes", "potatoes", "onions", "broccoli", "carrots",
  "lettuce", "spinach", "peppers", "mushrooms",
  "milk", "eggs", "cheese", "butter", "yogurt", "cream cheese",
  "pasta", "rice", "bread", "cereal", "oatmeal",
  "canned tomatoes", "beans", "soup", "broth", "peanut butter",
  "olive oil", "salsa", "tortillas",
  "frozen pizza", "frozen vegetables", "ice cream",
  "chips", "crackers", "nuts", "juice", "coffee",
];

function cleanFlippName(rawName) {
  let name = rawName;
  name = name
    .replace(/,?\s*\d[\d.\s]*(oz|lb|lbs|fl oz|ct|count|pack|pk|each|gal|qt|pt|ml|l|kg|g)\b.*$/i, "")
    .replace(/\s*-\s*\d[\d.\s]*(oz|lb|lbs|fl oz|ct|count|pack|pk|each|gal|qt|pt)\s*$/i, "")
    .trim();
  name = name.replace(/^[A-Z][a-zA-Z']+[®™]\s+/g, "").trim();
  name = name
    .replace(/^[,\s—–\-!]+/, "")
    .replace(/[,\s—–\-!]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return name || rawName;
}

function formatFlippPrice(price) {
  if (!price && price !== 0) return "";
  return `$${parseFloat(price).toFixed(2)}`;
}

async function fetchFlippDeals(zip, storeFilter) {
  const region = zip.substring(0, 3); // 3-digit zip prefix = ad region
  const cacheKey = `flipp:${region}`;

  // Check in-memory cache first (fast)
  const memCached = flippCache.get(cacheKey);
  if (memCached && Date.now() - memCached.timestamp < FLIPP_CACHE_TTL) {
    console.log(`  Flipp memory cache HIT for region ${region}`);
    const deals = memCached.deals;
    if (storeFilter) return deals.filter(d => (d.storeName || "").toLowerCase().includes(storeFilter.toLowerCase()));
    return deals;
  }

  // Check Supabase cache (persists across restarts, 24hr TTL)
  const dbCached = await getCachedDeals(cacheKey);
  if (dbCached) {
    console.log(`  Flipp Supabase cache HIT for region ${region} (${dbCached.length} deals)`);
    flippCache.set(cacheKey, { deals: dbCached, timestamp: Date.now() }); // warm memory cache
    if (storeFilter) return dbCached.filter(d => (d.storeName || "").toLowerCase().includes(storeFilter.toLowerCase()));
    return dbCached;
  }

  console.log(`  Flipp cache MISS for region ${region} — fetching live...`);
  const allDeals = [];

  for (const term of FLIPP_SEARCH_TERMS) {
    try {
      const url = `${FLIPP_API}/items/search?q=${encodeURIComponent(term)}&postal_code=${zip}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
        },
      });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 3000)); continue; }
      if (!res.ok) continue;

      const data = await res.json();
      const items = (data.items || [])
        .filter(item => !shouldSkipFlippStore(item.merchant_name))
        .filter(item => !storeFilter || (item.merchant_name || "").toLowerCase().includes(storeFilter.toLowerCase()));

      allDeals.push(...items.map(item => ({
        flippId: item.id || item.flyer_item_id,
        name: item.name || "",
        merchant: item.merchant_name || "",
        merchantId: item.merchant_id,
        currentPrice: item.current_price,
        originalPrice: item.original_price,
        saleStory: item.sale_story || "",
        postPriceText: item.post_price_text || "",
        image: item.clean_image_url || item.clipping_image_url || "",
        validFrom: item.valid_from || "",
        validTo: item.valid_to || "",
        category: term,
      })));

      await new Promise(r => setTimeout(r, 200));
    } catch (e) { /* skip */ }
  }

  // Deduplicate
  const seen = new Set();
  const unique = allDeals.filter(d => {
    if (seen.has(d.flippId)) return false;
    seen.add(d.flippId);
    return true;
  });

  const deals = unique.map(d => {
    const cleaned = cleanFlippName(d.name);
    const sale = parseFloat(d.currentPrice) || 0;
    const reg = parseFloat(d.originalPrice) || 0;
    const savings = reg > sale ? (reg - sale).toFixed(2) : "";
    const pctOff = reg > sale ? Math.round(((reg - sale) / reg) * 100) : 0;
    return {
      id: `flipp-${d.flippId}`, upc: "", name: cleaned, brand: "", category: d.category,
      regularPrice: formatFlippPrice(d.originalPrice), salePrice: formatFlippPrice(d.currentPrice),
      savings: savings ? `$${savings}` : "", pctOff, size: "",
      image: d.image || null, productUrl: null,
      saleStory: d.saleStory, postPriceText: d.postPriceText,
      storeName: d.merchant, storeId: String(d.merchantId),
      weekStart: d.validFrom ? d.validFrom.split("T")[0] : "",
      weekEnd: d.validTo ? d.validTo.split("T")[0] : "",
      source: "flipp",
    };
  });

  deals.sort((a, b) => b.pctOff - a.pctOff);

  // Save to memory cache AND Supabase
  flippCache.set(cacheKey, { deals, timestamp: Date.now() });
  await setCachedDeals(cacheKey, deals);
  console.log(`  Flipp: saved ${deals.length} deals for region ${region}`);

  for (const [key, val] of flippCache.entries()) {
    if (Date.now() - val.timestamp > FLIPP_CACHE_TTL) flippCache.delete(key);
  }

  if (storeFilter) return deals.filter(d => (d.storeName || "").toLowerCase().includes(storeFilter.toLowerCase()));
  return deals;
}

app.get("/api/flipp/deals", async (req, res) => {
  const { zip, store } = req.query;
  if (!zip) return res.status(400).json({ error: "zip is required" });
  try {
    console.log(`Flipp: fetching deals for zip ${zip}${store ? ` store: ${store}` : ""}`);
    const deals = await fetchFlippDeals(zip, store);
    console.log(`Flipp: ${deals.length} deals found`);
    res.json({ deals });
  } catch (err) {
    console.error("Flipp deals error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/flipp/stores", async (req, res) => {
  const { zip } = req.query;
  if (!zip) return res.status(400).json({ error: "zip is required" });
  try {
    // Get Flipp-discovered stores
    const url = `${FLIPP_API}/items/search?q=chicken&postal_code=${zip}`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    if (!r.ok) throw new Error("Flipp API error");
    const data = await r.json();
    const storeMap = new Map();
    for (const item of (data.items || [])) {
      const name = item.merchant_name || "";
      if (!name || shouldSkipFlippStore(name)) continue;
      if (!storeMap.has(name)) {
        storeMap.set(name, {
          id: `flipp-${item.merchant_id}`,
          name,
          merchantId: item.merchant_id,
          address: `Near ${zip}`,
          source: "flipp",
        });
      }
    }

    // Enrich with ad_regions — show which chains SHOULD be in this area
    const regions = await getAdRegions(zip);
    const summary = summarizeRegions(regions);
    const adRegionBanners = summary
      .filter(s => s.store !== "kroger" && s.store !== "aldi") // these have their own APIs
      .map(s => s.banner);

    const stores = [...storeMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    res.json({ stores, adRegionChains: adRegionBanners });
  } catch (err) {
    console.error("Flipp stores error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══ DEAL CACHE ADMIN ═════════════════════════════════════════════════════════

// View cache status
app.get("/api/admin/cache-status", async (req, res) => {
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

// Pre-populate Flipp deals for a list of regions
// Usage: POST /api/admin/prepopulate with { "zips": ["10001","30301","60601","90001","43210"] }
app.post("/api/admin/prepopulate", async (req, res) => {
  const { zips } = req.body;
  if (!zips?.length) return res.status(400).json({ error: "Provide a 'zips' array" });

  const results = [];
  for (const zip of zips) {
    const region = zip.substring(0, 3);
    const cacheKey = `flipp:${region}`;

    // Skip if already fresh
    const existing = await getCachedDeals(cacheKey);
    if (existing) {
      results.push({ zip, region, status: "already cached", deals: existing.length });
      continue;
    }

    try {
      console.log(`Pre-populating region ${region} (zip ${zip})...`);
      const deals = await fetchFlippDeals(zip, null);
      results.push({ zip, region, status: "fetched", deals: deals.length });
      // Rate limit — wait between regions to be nice to Flipp
      await new Promise(r => setTimeout(r, 5000));
    } catch (e) {
      results.push({ zip, region, status: "error", error: e.message });
    }
  }

  res.json({ results, summary: `Populated ${results.filter(r => r.status === "fetched").length} new regions` });
});

// Clear expired cache entries
app.post("/api/admin/cache-cleanup", async (req, res) => {
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

// GET version — also supports ?all=true to clear entire cache
app.get("/api/admin/cache-cleanup", async (req, res) => {
  try {
    const clearAll = req.query.all === "true";
    let query;
    if (clearAll) {
      query = supabase.from("deal_cache").delete().neq("cache_key", "").select("cache_key");
    } else {
      const cutoff = new Date(Date.now() - DEAL_CACHE_TTL).toISOString();
      query = supabase.from("deal_cache").delete().lt("fetched_at", cutoff).select("cache_key");
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    // Also clear in-memory caches
    flippCache.clear();
    res.json({ deleted: data?.length || 0, message: clearAll ? "Cleared ALL cache entries + memory" : "Removed entries older than 24 hours" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ad regions stats
app.get("/api/admin/ad-regions-stats", async (req, res) => {
  try {
    // Paginate to get ALL rows (Supabase defaults to 1000 max)
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
      if (data.length < pageSize) break; // last page
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

// Check which ad_regions zips have cached deals vs need fetching
app.get("/api/admin/cache-coverage", async (req, res) => {
  const { store } = req.query; // optional filter
  try {
    // Get distinct zip3s from ad_regions (paginated)
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

    // Get all cache keys
    const { data: cacheData, error: cacheErr } = await supabase
      .from("deal_cache")
      .select("cache_key, fetched_at");
    if (cacheErr) throw new Error(cacheErr.message);

    const cacheKeys = new Set((cacheData || []).map(d => d.cache_key));
    const freshCutoff = Date.now() - DEAL_CACHE_TTL;
    const freshKeys = new Set((cacheData || []).filter(d => new Date(d.fetched_at).getTime() > freshCutoff).map(d => d.cache_key));

    // Check coverage
    const zip3Set = new Set();
    let cached = 0, stale = 0, missing = 0;
    for (const row of (regionData || [])) {
      if (zip3Set.has(row.zip3 + row.store)) continue;
      zip3Set.add(row.zip3 + row.store);

      // Determine expected cache key
      let expectedKey;
      if (row.store === "aldi") expectedKey = "aldi:national";
      else expectedKey = `flipp:${row.zip3}`;

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

// ══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Deals to Meals running on port ${PORT}`));
