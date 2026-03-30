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

// ── igroceryads.com store URL lookup (used by nearby-stores and on-demand extraction) ──
const IGROCERYADS_STORES = {
  "acme": "https://www.igroceryads.com/acme-weekly-ad-acme-markets-circular/",
  "albertsons": "https://www.igroceryads.com/albertsons-weekly-ad-cat/",
  "bashas": "https://www.igroceryads.com/bashas-weekly-ad/",
  "big y": "https://www.igroceryads.com/big-y-flyer-big-y-circular/",
  "cub foods": "https://www.igroceryads.com/cub-foods-ad-weekly-ad-specials/",
  "el super": "https://www.igroceryads.com/el-super-weekly-ad-cat/",
  "fareway": "https://www.igroceryads.com/fareway-ad-weekly-ad-specials/",
  "food 4 less": "https://www.igroceryads.com/food4less-weekly-ad/",
  "food city": "https://www.igroceryads.com/food-city-weekly-ad-current-circulars/",
  "food lion": "https://www.igroceryads.com/food-lion-circular/",
  "foodtown": "https://www.igroceryads.com/foodtown-ad/",
  "fred meyer": "https://www.igroceryads.com/fred-meyer-weekly-ads/",
  "giant eagle": "https://www.igroceryads.com/giant-eagle-weekly-sale-ad/",
  "giant food": "https://www.igroceryads.com/giant-food-weekly-ad-deals/",
  "hannaford": "https://www.igroceryads.com/hannaford-flyer/",
  "harris teeter": "https://www.ladysavings.com/harristeeter-weekly-ad/",
  "h-e-b": "https://www.igroceryads.com/heb-weekly-ad-cat/",
  "heb": "https://www.igroceryads.com/heb-weekly-ad-cat/",
  "hy-vee": "https://www.igroceryads.com/hy-vee-weekly-ad/",
  "hyvee": "https://www.igroceryads.com/hy-vee-weekly-ad/",
  "ingles": "https://www.igroceryads.com/ingles-weekly-ad-ingles-markets-ad/",
  "jewel-osco": "https://www.igroceryads.com/jewel-osco-weekly-ad/",
  "jewel osco": "https://www.igroceryads.com/jewel-osco-weekly-ad/",
  "key food": "https://www.igroceryads.com/key-food-circular/",
  "lidl": "https://www.igroceryads.com/lidl-promotions/",
  "lowes foods": "https://www.igroceryads.com/lowes-foods/",
  "market basket": "https://www.igroceryads.com/market-basket-flyer/",
  "meijer": "https://www.igroceryads.com/meijer-weekly-ad-deals/",
  "piggly wiggly": "https://www.igroceryads.com/piggly-wiggly-weekly-ad/",
  "price chopper": "https://www.igroceryads.com/price-chopper-ad-price-chopper-flyer/",
  "publix": "https://www.igroceryads.com/publix-weekly-specials/",
  "ralphs": "https://www.igroceryads.com/ralphs-weekly-ad-ralphs-ads/",
  "rouses": "https://www.igroceryads.com/rouses-ad/",
  "safeway": "https://www.igroceryads.com/safeway-weekly-ad-cat/",
  "save a lot": "https://www.igroceryads.com/save-a-lot-ad-specials/",
  "save-a-lot": "https://www.igroceryads.com/save-a-lot-ad-specials/",
  "shaws": "https://www.igroceryads.com/shaws-circular/",
  "shaw's": "https://www.igroceryads.com/shaws-circular/",
  "shoprite": "https://www.igroceryads.com/shoprite-this-week-sale-circular/",
  "smart & final": "https://www.igroceryads.com/smart-and-final-weekly-ad/",
  "sprouts": "https://www.igroceryads.com/sprouts-weekly-ad-sales/",
  "stater bros": "https://www.igroceryads.com/stater-bros-weekly-ad/",
  "stop & shop": "https://www.igroceryads.com/stop-and-shop-weekly-circular/",
  "stop and shop": "https://www.igroceryads.com/stop-and-shop-weekly-circular/",
  "tops": "https://www.igroceryads.com/tops-weekly-ad/",
  "vons": "https://www.igroceryads.com/vons-weekly-ad-cat/",
  "winn-dixie": "https://www.igroceryads.com/winn-dixie-sales/",
  "winn dixie": "https://www.igroceryads.com/winn-dixie-sales/",
  "99 ranch": "https://www.igroceryads.com/99-ranch-market-weekly-ad/",
  "cardenas": "https://www.igroceryads.com/cardenas-weekly-ad-cat/",
  "pavilions": "https://www.igroceryads.com/pavilions-weekly-ad/",
  // ── iweeklyads.com (stores not on igroceryads) ──
  "whole foods": "https://www.iweeklyads.com/whole-foods-ad-specials/",
  "remke": "https://www.iweeklyads.com/remke-markets-weekly-sale-ad/",
  "associated": "https://www.iweeklyads.com/associated-supermarkets-weekly-ad/",
  "brookshire": "https://www.iweeklyads.com/brookshires-weekly-ad/",
  "buehler": "https://www.iweeklyads.com/buehlers-weekly-ad/",
  "country mart": "https://www.iweeklyads.com/country-mart-weekly-ad/",
  "d&w fresh market": "https://www.iweeklyads.com/dw-fresh-market-weekly-ad/",
  "dierbergs": "https://www.iweeklyads.com/dierbergs-weekly-ad/",
  "festival foods": "https://www.ladysavings.com/festivalfoods-weekly-ad/",
  "fresh thyme": "https://www.ladysavings.com/freshthyme-weekly-ad/",
  "grocery outlet": "https://www.ladysavings.com/groceryoutlet-weekly-ad/",
  "homeland": "https://www.iweeklyads.com/homeland-weekly-ad/",
  "king kullen": "https://www.iweeklyads.com/king-kullen-weekly-circular/",
  "lucky": "https://www.iweeklyads.com/lucky-supermarkets-weekly-ad/",
  "martin's": "https://www.iweeklyads.com/martins-weekly-ad/",
  "martins": "https://www.iweeklyads.com/martins-weekly-ad/",
  "new seasons": "https://www.iweeklyads.com/new-seasons-market-weekly-ad/",
  "price rite": "https://www.iweeklyads.com/price-rite-weekly-ad/",
  "raley's": "https://www.iweeklyads.com/raleys-weekly-ad/",
  "raleys": "https://www.iweeklyads.com/raleys-weekly-ad/",
  "ruler foods": "https://www.iweeklyads.com/ruler-foods-weekly-ad/",
  "schnucks": "https://www.iweeklyads.com/schnucks-weekly-ad/",
  "shoppers": "https://www.iweeklyads.com/shoppers-weekly-ad/",
  "weis": "https://www.iweeklyads.com/weis-markets-weekly-ad/",
  "winco": "https://www.iweeklyads.com/winco-weekly-ad/",
  "bi-lo": "https://www.iweeklyads.com/bilo-weekly-ad/",
  "bilo": "https://www.iweeklyads.com/bilo-weekly-ad/",
  "commissary": "https://www.iweeklyads.com/deca-commissary-weekly-ad/",
  "deca": "https://www.iweeklyads.com/deca-commissary-weekly-ad/",
  "hen house": "https://www.iweeklyads.com/hen-house-weekly-ad/",
  "ranch market": "https://www.iweeklyads.com/99-ranch-market-weekly-sale-specials/",
};

function findIgroceryadsUrl(storeName) {
  const lower = storeName.toLowerCase().trim();
  if (IGROCERYADS_STORES[lower]) return IGROCERYADS_STORES[lower];
  for (const [key, url] of Object.entries(IGROCERYADS_STORES)) {
    if (lower.includes(key) || key.includes(lower)) return url;
  }
  return null;
}

// ══ NEARBY GROCERY STORES (Google Places API with 30-day cache) ═══════════════

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const STORE_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

async function geocodeZip(zip) {
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${zip}&key=${GOOGLE_MAPS_KEY}`
  );
  const data = await res.json();
  if (data.results?.[0]?.geometry?.location) {
    return data.results[0].geometry.location; // { lat, lng }
  }
  return null;
}

async function getCachedStores(zip, cacheKey) {
  try {
    const key = cacheKey || `nearby-stores:${zip}`;
    const { data, error } = await supabase
      .from("deal_cache")
      .select("data, fetched_at")
      .eq("cache_key", key)
      .single();
    if (error || !data) return null;
    const age = Date.now() - new Date(data.fetched_at).getTime();
    if (age > STORE_CACHE_TTL) return null;
    return data.data;
  } catch { return null; }
}

async function setCachedStores(zip, stores, cacheKey) {
  try {
    const key = cacheKey || `nearby-stores:${zip}`;
    await supabase.from("deal_cache").upsert({
      cache_key: key,
      data: stores,
      fetched_at: new Date().toISOString(),
    }, { onConflict: "cache_key" });
  } catch (e) { console.error("Store cache write error:", e.message); }
}

app.get("/api/nearby-stores", async (req, res) => {
  const { zip, radius: radiusMiles } = req.query;
  if (!zip) return res.status(400).json({ error: "zip is required" });
  const miles = parseInt(radiusMiles) || 10;
  const radiusMeters = Math.min(miles * 1609, 48000); // convert miles to meters, cap at ~30mi
  const cacheKey = `nearby-stores:${zip}:${miles}mi`;

  try {
    // Check cache first
    const cached = await getCachedStores(zip, cacheKey);
    if (cached) {
      const filtered = cached.filter(s => s.hasDeals || s.canExtract || findIgroceryadsUrl(s.name) || s.name === "Kroger" || s.name === "ALDI" || s.name === "Walmart");
      console.log(`Nearby stores for ${zip} (${miles}mi): ${filtered.length} stores [cached]`);
      return res.json({ stores: filtered, cached: true });
    }

    if (!GOOGLE_MAPS_KEY) {
      console.log("Google Maps API key not configured, falling back to ad_regions");
      return res.json({ stores: [], error: "Google Maps API key not configured" });
    }

    // Geocode zip to lat/lng
    const location = await geocodeZip(zip);
    if (!location) return res.status(400).json({ error: "Could not geocode zip code" });

    // Search for grocery stores nearby — run two searches for better coverage
    const searches = [
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location.lat},${location.lng}&radius=${radiusMeters}&type=supermarket&key=${GOOGLE_MAPS_KEY}`,
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location.lat},${location.lng}&radius=${radiusMeters}&keyword=grocery+store&key=${GOOGLE_MAPS_KEY}`,
    ];
    const allPlaces = [];
    const seenIds = new Set();
    for (const url of searches) {
      let nextUrl = url;
      let pages = 0;
      while (nextUrl && pages < 3) { // up to 3 pages (60 results) per search
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
        // Google requires a short delay before requesting next page
        if (placesData.next_page_token) {
          await new Promise(r => setTimeout(r, 2000));
          nextUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?pagetoken=${placesData.next_page_token}&key=${GOOGLE_MAPS_KEY}`;
        } else {
          nextUrl = null;
        }
        pages++;
      }
    }

    // Extract unique store brands from results
    const brandMap = new Map();
    for (const place of allPlaces) {
      const name = place.name || "";
      // Normalize to brand name
      let brand = name;
      // Match known chains
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
      else if (lower.includes("fred meyer")) brand = "Kroger"; // Kroger banner
      else if (lower.includes("king soopers")) brand = "Kroger";
      else if (lower.includes("ralphs")) brand = "Kroger";
      else if (lower.includes("fry's food")) brand = "Kroger";
      else if (lower.includes("smith's food") || lower.includes("smiths food")) brand = "Kroger";
      else if (lower.includes("qfc")) brand = "Kroger";
      else if (lower.includes("dillons")) brand = "Kroger";
      else if (lower.includes("pick n save") || lower.includes("pick 'n save")) brand = "Kroger";
      else if (lower.includes("mariano")) brand = "Kroger";

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

    // Check which stores have cached deals
    const { data: dealKeys } = await supabase
      .from("deal_cache")
      .select("cache_key")
      .like("cache_key", "ad-extract:%");
    const storesWithDeals = new Set();
    for (const row of (dealKeys || [])) {
      const parts = row.cache_key.split(":");
      if (parts.length >= 2) {
        // Normalize: "food-lion" -> "foodlion", "hyvee" -> "hyvee"
        storesWithDeals.add(parts[1].toLowerCase().replace(/[-\s]/g, ""));
      }
    }
    // Mark each store with deal availability and extractability
    const normalizeName = (n) => n.toLowerCase().replace(/['\s-]/g, "");
    const enrichedStores = stores
      .map(s => ({
        ...s,
        hasDeals: storesWithDeals.has(normalizeName(s.name))
          || s.name === "Kroger" || s.name === "ALDI" || s.name === "Walmart",
        canExtract: !!findIgroceryadsUrl(s.name) || s.name === "Kroger" || s.name === "ALDI" || s.name === "Walmart",
      }))
      .filter(s => s.hasDeals || s.canExtract); // only show stores we can get deals for

    // Always include nationwide stores if not already in results
    const existingNames = new Set(enrichedStores.map(s => s.name));
    const alwaysInclude = [
      { name: "Walmart", count: 1, address: "Nearby", hasDeals: true, canExtract: true, lat: location.lat, lng: location.lng },
      { name: "Kroger", count: 1, address: "Nearby", hasDeals: true, canExtract: true, lat: location.lat, lng: location.lng },
      { name: "ALDI", count: 1, address: "Nearby", hasDeals: true, canExtract: true, lat: location.lat, lng: location.lng },
    ];
    for (const s of alwaysInclude) {
      if (!existingNames.has(s.name)) enrichedStores.push(s);
    }

    // Cache for 30 days
    await setCachedStores(zip, enrichedStores, cacheKey);
    console.log(`Nearby stores for ${zip} (${miles}mi): ${enrichedStores.length} brands (${enrichedStores.filter(s=>s.hasDeals).length} with deals) from ${allPlaces.length} places [live]`);

    res.json({ stores: enrichedStores, cached: false });
  } catch (err) {
    console.error("Nearby stores error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══ AD REGIONS (kept for reference/fallback) ═════════════════════════════════

app.get("/api/ad-regions", async (req, res) => {
  const { zip } = req.query;
  if (!zip) return res.status(400).json({ error: "zip is required" });
  try {
    const zip3 = zip.substring(0, 3);
    const regions = await getAdRegions(zip);
    const summary = summarizeRegions(regions);

    // Check which stores actually have cached deals
    const { data: cacheRows } = await supabase
      .from("deal_cache")
      .select("cache_key")
      .or(`cache_key.like.ad-extract:%:${zip3},cache_key.like.ad-extract:%`);

    const cachedStoreIds = new Set();
    for (const row of (cacheRows || [])) {
      // Extract store ID from cache_key like "ad-extract:publix:320" or "ad-extract:publix"
      const parts = row.cache_key.split(":");
      if (parts.length >= 2) cachedStoreIds.add(parts[1]);
    }

    // Mark stores that have deals available
    const enriched = summary.map(s => ({
      ...s,
      hasDeals: cachedStoreIds.has(s.store) || s.store === "kroger" || s.store === "aldi",
    }));

    console.log(`Ad regions for zip ${zip} (${zip3}): ${summary.length} chains, ${enriched.filter(s => s.hasDeals).length} with deals`);
    res.json({
      zip3,
      stores: enriched,
      count: enriched.length,
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

    const results = { kroger: null, aldi: null, sources: [] };
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

    await Promise.all(fetchPromises);

    // Also include any ad-extracted deals
    // Merge both zip3-specific AND master keys (some stores have zip3 keys, some only master)
    let adExtractDeals = [];
    try {
      // Get zip3-specific deals
      const { data: zip3Data } = await supabase.from("deal_cache").select("data, cache_key").like("cache_key", `ad-extract:%:${zip3}`);
      const zip3StoreIds = new Set();
      if (zip3Data) {
        for (const row of zip3Data) {
          if (row.data) {
            adExtractDeals.push(...row.data);
            // Track which stores have zip3-specific data
            const parts = row.cache_key.split(":");
            if (parts[1]) zip3StoreIds.add(parts[1]);
          }
        }
      }

      // Also get master keys (ad-extract:storename) for stores NOT already found via zip3
      const { data: masterData } = await supabase
        .from("deal_cache")
        .select("data, cache_key")
        .like("cache_key", "ad-extract:%")
        .not("cache_key", "like", "ad-extract:%:%");
      if (masterData) {
        for (const row of masterData) {
          const storeId = row.cache_key.split(":")[1];
          if (!zip3StoreIds.has(storeId) && row.data) {
            adExtractDeals.push(...row.data);
          }
        }
      }

      if (adExtractDeals.length > 0) {
        results.sources.push({ store: "ad-extract", deals: adExtractDeals.length, cached: true });
        console.log(`  Ad-extracted deals: ${adExtractDeals.length} deals`);
      }
    } catch (e) {
      console.log(`  No ad-extracted deals found`);
    }

    // Merge all deals into one array
    const allDeals = [
      ...(results.kroger || []),
      ...(results.aldi || []),
      ...adExtractDeals,
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

// ══ ON-DEMAND AD EXTRACTION ═══════════════════════════════════════════════════
// When a user clicks a store without deals, search igroceryads and extract

// In-memory set to track stores currently being extracted (prevent duplicate runs)
const extractingStores = new Set();

app.post("/api/extract-store", async (req, res) => {
  const { storeName } = req.body;
  if (!storeName) return res.status(400).json({ error: "storeName is required" });

  const storeId = storeName.toLowerCase().replace(/['\s]+/g, "-").replace(/--+/g, "-");

  // Check if we already have cached deals (with enough results)
  const existing = await getCachedDeals(`ad-extract:${storeId}`);
  if (existing && existing.length >= 10) {
    return res.json({ status: "ready", deals: existing.length, storeId });
  }

  // Check if extraction is already running
  if (extractingStores.has(storeId)) {
    return res.json({ status: "extracting", message: "Deal extraction in progress" });
  }

  // Find the igroceryads URL
  const adUrl = findIgroceryadsUrl(storeName);
  if (!adUrl) {
    return res.json({ status: "not-found", message: "No ad source found for this store. Upload a photo of their weekly ad to add deals." });
  }

  // Start extraction in background
  extractingStores.add(storeId);
  res.json({ status: "extracting", message: `Found ${storeName} ad — extracting deals now. This takes about 2-3 minutes.` });

  // Background extraction
  try {
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) { extractingStores.delete(storeId); return; }

    // Fetch ad page
    const pageRes = await fetch(adUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    const html = await pageRes.text();

    // Check if this is a ladysavings paginated store
    const isLadySavings = adUrl.includes("ladysavings.com");
    let images = [];

    if (isLadySavings) {
      // Paginated: images hosted on hotcouponworld.com
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
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
          });
          const pHtml = await pRes.text();
          const pImages = (pHtml.match(hcwRegex) || []).filter(url => !url.includes("-150x150") && !url.includes("-300x") && !url.includes("_header"));
          if (pImages.length > 0) images.push(pImages[0]);
        } catch {}
      }
    } else {
      // Standard: igroceryads/iweeklyads images
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

      // Probe for more pages if few found (lazy-loaded images)
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
    } // end else (non-ladysavings)

    console.log(`On-demand extraction for ${storeName}: ${images.length} pages found`);

    // Extract deals from each page
    const allDeals = [];
    const maxPages = Math.min(images.length, 20);
    for (let i = 0; i < maxPages; i++) {
      try {
        const imgRes = await fetch(images[i], {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        if (!imgRes.ok) continue;
        const contentType = imgRes.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) continue;
        const buffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        if (base64.length < 1000) continue;

        const mediaType = images[i].endsWith(".webp") ? "image/webp" : images[i].endsWith(".png") ? "image/png" : "image/jpeg";

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
                { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
                { type: "text", text: `Extract grocery deals from this ${storeName} weekly ad image. Return ONLY a valid JSON array. For each item: {"name":"","brand":"","salePrice":"","unit":"","regularPrice":"","dealType":"sale/bogo/percent_off","category":"meat/produce/dairy/bakery/frozen/pantry/snacks/beverages/deli/seafood/household/other","size":"","notes":""}. No markdown. Include all items with prices.` }
              ]
            }]
          })
        });
        const aiData = await aiRes.json();
        const text = aiData.content?.map(c => c.text || "").join("") || "";
        let cleaned = text.replace(/```json|```/g, "").trim();
        try {
          const deals = JSON.parse(cleaned);
          deals.forEach(d => { d.adImage = images[i]; d.adPage = i + 1; });
          allDeals.push(...deals);
        } catch {
          const lastBrace = cleaned.lastIndexOf("}");
          if (lastBrace > 0) {
            try {
              const recovered = JSON.parse(cleaned.substring(0, lastBrace + 1) + "]");
              recovered.forEach(d => { d.adImage = images[i]; d.adPage = i + 1; });
              allDeals.push(...recovered);
            } catch {}
          }
        }
        if (i < maxPages - 1) await new Promise(r => setTimeout(r, 500));
      } catch (e) { console.error(`  Page ${i+1} error: ${e.message}`); }
    }

    // Deduplicate and enrich
    const seen = new Set();
    let unique = allDeals.filter(d => {
      const key = `${d.name}:${d.salePrice}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // TEXT FALLBACK: If vision found fewer than 10 deals, try extracting from page text
    if (unique.length < 10) {
      console.log(`  Only ${unique.length} deals from images — trying text extraction fallback...`);
      try {
        // The HTML we already fetched (stored in 'html' variable above) may contain deal text
        // Extract just the main content text (strip HTML tags)
        const textContent = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 8000); // limit to ~8000 chars for the AI

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
{"name":"","brand":"","salePrice":"","unit":"","regularPrice":"","dealType":"sale/bogo/percent_off","category":"meat/produce/dairy/bakery/frozen/pantry/snacks/beverages/deli/seafood/household/other","size":"","notes":""}

Rules:
- Only include items that have a clear price
- For "2/$5" deals, set salePrice to "2.50" and notes to "2 for $5"
- For per-lb prices like "$3.99 lb", set unit to "/lb"
- No markdown backticks, return ONLY the JSON array
- If no deals found, return []`
              }]
            })
          });
          const textAiData = await textAiRes.json();
          const textResult = textAiData.content?.map(c => c.text || "").join("") || "";
          let textCleaned = textResult.replace(/```json|```/g, "").trim();
          try {
            const textDeals = JSON.parse(textCleaned);
            if (textDeals.length > unique.length) {
              console.log(`  Text fallback found ${textDeals.length} deals (vs ${unique.length} from images)`);
              // Use text deals instead, deduplicating
              const textSeen = new Set();
              unique = textDeals.filter(d => {
                const key = `${d.name}:${d.salePrice}`;
                if (textSeen.has(key)) return false;
                textSeen.add(key);
                return true;
              });
            }
          } catch {
            const lastBrace = textCleaned.lastIndexOf("}");
            if (lastBrace > 0) {
              try {
                const recovered = JSON.parse(textCleaned.substring(0, lastBrace + 1) + "]");
                if (recovered.length > unique.length) {
                  console.log(`  Text fallback found ${recovered.length} deals (recovered)`);
                  unique = recovered;
                }
              } catch {}
            }
          }
        }
      } catch (e) {
        console.error(`  Text fallback error: ${e.message}`);
      }
    }

    // Enrich with metadata
    unique = unique.map((d, i) => ({
      ...d,
      id: `${storeId}-${Date.now()}-${i}`,
      storeName,
      source: "ad-extract",
      image: null,  // Pexels images added by pipeline, not on-demand
      adSourceUrl: adUrl,
    }));

    // Cache as master key
    if (unique.length > 0) {
      await setCachedDeals(`ad-extract:${storeId}`, unique);
      console.log(`On-demand: ${storeName} — ${unique.length} deals cached`);
    } else {
      console.log(`On-demand: ${storeName} — no deals extracted`);
    }
  } catch (err) {
    console.error(`On-demand extraction error for ${storeName}:`, err.message);
  } finally {
    extractingStores.delete(storeId);
  }
});

// Check extraction status
app.get("/api/extract-status", async (req, res) => {
  const { store } = req.query;
  if (!store) return res.status(400).json({ error: "store is required" });
  const storeId = store.toLowerCase().replace(/['\s]+/g, "-").replace(/--+/g, "-");

  if (extractingStores.has(storeId)) {
    return res.json({ status: "extracting" });
  }
  const cached = await getCachedDeals(`ad-extract:${storeId}`);
  if (cached && cached.length > 0) {
    return res.json({ status: "ready", deals: cached.length });
  }
  res.json({ status: "none" });
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
- Include simple pantry staples the customer likely already has (salt, pepper, oil, butter, flour, sugar, dried spices/herbs, vinegar, soy sauce, etc.)
- Have clear, numbered step-by-step instructions a beginner cook could follow
- Be a REAL recipe that actually works — not made up combinations
- Use sale items appropriately based on what they are. Raw ingredients (chicken breasts, ground beef, fresh vegetables) should be used in from-scratch recipes. Pre-made or processed products (breaded shrimp, frozen pizza, fish sticks, nuggets) should only be used in recipes where that product IS the dish or a natural component (e.g. breaded shrimp → shrimp po'boy, frozen pizza → loaded pizza). NEVER use a processed product as a substitute for a raw ingredient (e.g. do NOT use breaded frozen shrimp in a butter garlic shrimp skillet).
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
- "PANTRY" = ONLY non-perishable staples most kitchens have: salt, pepper, cooking oil, butter, flour, sugar, dried spices/herbs (paprika, cumin, oregano, chili powder, etc.), vinegar, soy sauce, hot sauce, mustard, ketchup, honey, vanilla extract, baking powder, baking soda, cornstarch. PANTRY does NOT include any fresh/perishable items — garlic, onion, lemon, lime, ginger, fresh herbs, eggs, milk, cream, cheese, and all fresh vegetables/fruits must be "ADDITIONAL" (things the customer needs to buy).
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
    const keyPattern = req.query.key; // delete specific key or pattern
    let query;
    if (keyPattern) {
      if (keyPattern.includes("%")) {
        query = supabase.from("deal_cache").delete().like("cache_key", keyPattern).select("cache_key");
      } else {
        query = supabase.from("deal_cache").delete().eq("cache_key", keyPattern).select("cache_key");
      }
    } else if (clearAll) {
      query = supabase.from("deal_cache").delete().neq("cache_key", "").select("cache_key");
    } else {
      const cutoff = new Date(Date.now() - DEAL_CACHE_TTL).toISOString();
      query = supabase.from("deal_cache").delete().lt("fetched_at", cutoff).select("cache_key");
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ deleted: data?.length || 0, message: keyPattern ? `Cleared cache for: ${keyPattern}` : clearAll ? "Cleared ALL cache entries" : "Removed entries older than 24 hours" });
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

// ══════════════════════════════════════════════════════════════════════════
// AD IMAGE → DEALS EXTRACTION (Claude Vision)
// ══════════════════════════════════════════════════════════════════════════

app.post("/api/extract-ad", async (req, res) => {
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

    // Parse JSON from response
    const cleaned = text.replace(/```json|```/g, "").trim();
    const deals = JSON.parse(cleaned);

    // Add storeName and source to each deal
    const enriched = deals.map((d, i) => ({
      ...d,
      id: `ad-${Date.now()}-${i}`,
      storeName: storeName || "Unknown",
      source: "ad-extract",
      image: null,
    }));

    console.log(`Extracted ${enriched.length} deals from ad image`);
    res.json({ deals: enriched, count: enriched.length });
  } catch (err) {
    console.error("Ad extraction error:", err);
    res.status(500).json({ error: "Failed to extract deals from image", detail: err.message });
  }
});

// Admin: manually import extracted deals into cache
app.post("/api/admin/import-deals", async (req, res) => {
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

// ══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Dishcount running on port ${PORT}`));
