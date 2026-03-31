import crypto from "crypto";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// ── Supabase client ─────────────────────────────────────────────────────────
export const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

// ── Constants ───────────────────────────────────────────────────────────────
export const KROGER_TOKEN_URL = "https://api.kroger.com/v1/connect/oauth2/token";
export const KROGER_AUTH_URL  = "https://api.kroger.com/v1/connect/oauth2/authorize";
export const KROGER_API_BASE  = "https://api.kroger.com/v1";
export const REDIRECT_URI     = "https://dishcount.co/auth/kroger/callback";
export const APP_URL          = "https://dishcount.co";
export const SPOONACULAR_BASE = "https://api.spoonacular.com";
export const GOOGLE_MAPS_KEY  = process.env.GOOGLE_MAPS_API_KEY;

export const DEAL_CACHE_TTL   = 24 * 60 * 60 * 1000; // 24 hours
export const STORE_CACHE_TTL  = 30 * 24 * 60 * 60 * 1000; // 30 days
export const CACHE_TTL        = 2 * 60 * 60 * 1000; // 2 hours (recipe cache)

// ── Shared in-memory state ──────────────────────────────────────────────────
export const krogerTokens = new Map();
export const oauthStates = new Map(); // state token → { userId, createdAt }
export const extractingStores = new Set();
export const recipeCache = new Map();
export const aiRecipeCache = new Map();

// In-memory Set of store IDs that have cached deals (populated on startup, updated on cache writes)
export const storesWithDealsCache = new Set();

// Spoonacular point tracking (persisted to Supabase so limits survive deploys)
export const DAILY_POINT_LIMIT = 180;
export const POINTS_PER_SEARCH = 3;
const POINTS_CACHE_KEY = "spoonacular:daily-points";

export async function getDailyPoints() {
  try {
    const { data, error } = await supabase
      .from("deal_cache")
      .select("data, fetched_at")
      .eq("cache_key", POINTS_CACHE_KEY)
      .single();
    if (error || !data) return 0;
    const stored = data.data;
    if (stored.date !== new Date().toDateString()) return 0; // new day, reset
    return stored.points || 0;
  } catch { return 0; }
}

export async function addDailyPoints(n) {
  try {
    const current = await getDailyPoints();
    const today = new Date().toDateString();
    await supabase.from("deal_cache").upsert({
      cache_key: POINTS_CACHE_KEY,
      data: { points: current + n, date: today },
      fetched_at: new Date().toISOString(),
    }, { onConflict: "cache_key" });
  } catch (e) { console.error("Failed to update daily points:", e.message); }
}

export async function checkAndResetPoints() {
  // No-op — reset happens automatically in getDailyPoints() when the date changes
}

// ── Input validation ────────────────────────────────────────────────────────
const ZIP_RE = /^\d{5}$/;
const STORE_NAME_RE = /^[a-zA-Z0-9\s\-'&.]{1,50}$/;
export function validateZip(zip) { return typeof zip === "string" && ZIP_RE.test(zip); }
export function validateStoreName(name) { return typeof name === "string" && STORE_NAME_RE.test(name); }

// ── Session / Auth ──────────────────────────────────────────────────────────
export function generateSessionToken() {
  return crypto.createHmac("sha256", "dishcount-session-secret")
    .update(process.env.SITE_PASSWORD || "")
    .digest("hex");
}

export function isValidSession(cookieValue) {
  if (!cookieValue || !process.env.SITE_PASSWORD) return false;
  const expected = generateSessionToken();
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function requireAdmin(req, res, next) {
  if (!isValidSession(req.cookies?.site_auth)) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

export async function getUser(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// ── Kroger token helpers ────────────────────────────────────────────────────
export async function getAppToken() {
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

export async function refreshKrogerToken(refreshToken) {
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

// ── Deal cache ──────────────────────────────────────────────────────────────
export async function getCachedDeals(cacheKey) {
  try {
    const { data, error } = await supabase
      .from("deal_cache")
      .select("data, fetched_at")
      .eq("cache_key", cacheKey)
      .single();
    if (error || !data) return null;
    const age = Date.now() - new Date(data.fetched_at).getTime();
    if (age > DEAL_CACHE_TTL) return null;
    console.log(`  Cache HIT: ${cacheKey} (${Math.round(age/60000)}min old)`);
    return data.data;
  } catch (e) { console.error("Cache read error:", e.message); return null; }
}

export async function setCachedDeals(cacheKey, deals) {
  try {
    const { error } = await supabase
      .from("deal_cache")
      .upsert({ cache_key: cacheKey, data: deals, fetched_at: new Date().toISOString() }, { onConflict: "cache_key" });
    if (error) console.error("Cache write error:", error.message);
    else {
      console.log(`  Cache SET: ${cacheKey} (${Array.isArray(deals) ? deals.length + " items" : "stored"})`);
      // Update in-memory storesWithDealsCache if this is an ad-extract key
      if (cacheKey.startsWith("ad-extract:")) {
        const parts = cacheKey.split(":");
        if (parts.length >= 2) {
          storesWithDealsCache.add(parts[1].toLowerCase().replace(/[-\s]/g, ""));
        }
      }
    }
  } catch (e) { console.error("Cache write error:", e.message); }
}

// ── Store cache ─────────────────────────────────────────────────────────────
export async function getCachedStores(zip, cacheKey) {
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
  } catch (e) { console.error("Store cache read error:", e.message); return null; }
}

export async function setCachedStores(zip, stores, cacheKey) {
  try {
    const key = cacheKey || `nearby-stores:${zip}`;
    await supabase.from("deal_cache").upsert({
      cache_key: key,
      data: stores,
      fetched_at: new Date().toISOString(),
    }, { onConflict: "cache_key" });
  } catch (e) { console.error("Store cache write error:", e.message); }
}

// ── Populate storesWithDealsCache on startup ────────────────────────────────
export async function initStoresWithDealsCache() {
  try {
    const { data } = await supabase
      .from("deal_cache")
      .select("cache_key")
      .like("cache_key", "ad-extract:%");
    for (const row of (data || [])) {
      const parts = row.cache_key.split(":");
      if (parts.length >= 2) {
        storesWithDealsCache.add(parts[1].toLowerCase().replace(/[-\s]/g, ""));
      }
    }
    console.log(`Loaded ${storesWithDealsCache.size} stores into storesWithDealsCache`);
  } catch (e) { console.error("Failed to init storesWithDealsCache:", e.message); }
}

// ── Ad Regions ──────────────────────────────────────────────────────────────
export async function getAdRegions(zip) {
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

export function summarizeRegions(regions) {
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

// ── Per-lb detection ────────────────────────────────────────────────────────
export function detectPerLb(sizeLower, nameLower, price) {
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

// ── Deal matching ───────────────────────────────────────────────────────────
const FIND_DEAL_SKIP_WORDS = new Set([
  "the","and","with","for","from","fresh","frozen","organic","natural","premium",
  "classic","original","style","grade","boneless","skinless","extra","large","small",
  "medium","value","family","pack","brand","whole","fat","reduced","low","lite","light",
  "sliced","diced","chopped","shredded","roasted","grilled","baked","seasoned",
]);

export function findDeal(recipeIngName, ingredients) {
  const recipeWords = recipeIngName.toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(" ")
    .filter(w => w.length > 2 && !FIND_DEAL_SKIP_WORDS.has(w));
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

// ── Spoonacular helpers ─────────────────────────────────────────────────────
export function getCacheKey(ingredients, mealType, diets, offset) {
  const ingKey = ingredients.slice(0, 10).map(i => i.name).sort().join(",");
  return `${ingKey}|${mealType}|${(diets||[]).sort().join(",")}|${offset||0}`;
}

// ── Category images for OCR-extracted deals ─────────────────────────────────
export const CATEGORY_IMAGES = {
  meat:       "https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?w=400&h=300&fit=crop",
  vegetables: "https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&h=300&fit=crop",
  fruits:     "https://images.unsplash.com/photo-1619566636858-adf3ef46400b?w=400&h=300&fit=crop",
  produce:    "https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&h=300&fit=crop",
  dairy:      "https://images.unsplash.com/photo-1550583724-b2692b85b150?w=400&h=300&fit=crop",
  bakery:     "https://images.unsplash.com/photo-1509440159596-0249088772ff?w=400&h=300&fit=crop",
  frozen:     "https://images.pexels.com/photos/279151/pexels-photo-279151.jpeg?w=400&h=300&fit=crop",
  pantry:     "https://images.pexels.com/photos/16211537/pexels-photo-16211537.jpeg?w=400&h=300&fit=crop",
  snacks:     "https://images.pexels.com/photos/1894325/pexels-photo-1894325.jpeg?w=400&h=300&fit=crop",
  beverages:  "https://images.pexels.com/photos/1384039/pexels-photo-1384039.jpeg?w=400&h=300&fit=crop",
  deli:       "https://images.unsplash.com/photo-1550507992-eb63ffee0847?w=400&h=300&fit=crop",
  seafood:    "https://images.unsplash.com/photo-1615141982883-c7ad0e69fd62?w=400&h=300&fit=crop",
  household:  "https://images.unsplash.com/photo-1563453392212-326f5e854473?w=400&h=300&fit=crop",
  other:      "https://images.unsplash.com/photo-1542838132-92c53300491e?w=400&h=300&fit=crop",
};

export function getCategoryImage(category) {
  if (!category) return CATEGORY_IMAGES.other;
  const lower = category.toLowerCase();
  if (CATEGORY_IMAGES[lower]) return CATEGORY_IMAGES[lower];
  if (lower.includes("meat") || lower.includes("chicken") || lower.includes("beef") || lower.includes("pork") || lower.includes("turkey") || lower.includes("lamb") || lower.includes("sausage") || lower.includes("bacon")) return CATEGORY_IMAGES.meat;
  if (lower.includes("vegetable") || lower.includes("lettuce") || lower.includes("broccoli") || lower.includes("carrot") || lower.includes("pepper") || lower.includes("onion") || lower.includes("potato") || lower.includes("tomato") || lower.includes("celery") || lower.includes("spinach") || lower.includes("corn") || lower.includes("mushroom")) return CATEGORY_IMAGES.vegetables;
  if (lower.includes("fruit") || lower.includes("apple") || lower.includes("banana") || lower.includes("orange") || lower.includes("grape") || lower.includes("berry") || lower.includes("strawberr") || lower.includes("blueberr") || lower.includes("melon") || lower.includes("mango") || lower.includes("peach") || lower.includes("pear") || lower.includes("lemon") || lower.includes("lime")) return CATEGORY_IMAGES.fruits;
  if (lower.includes("produce")) return CATEGORY_IMAGES.vegetables;
  if (lower.includes("dairy") || lower.includes("cheese") || lower.includes("milk") || lower.includes("yogurt") || lower.includes("butter") || lower.includes("egg") || lower.includes("cream")) return CATEGORY_IMAGES.dairy;
  if (lower.includes("bakery") || lower.includes("bread") || lower.includes("bagel") || lower.includes("muffin") || lower.includes("roll") || lower.includes("bun")) return CATEGORY_IMAGES.bakery;
  if (lower.includes("frozen")) return CATEGORY_IMAGES.frozen;
  if (lower.includes("pantry") || lower.includes("canned") || lower.includes("pasta") || lower.includes("rice") || lower.includes("sauce") || lower.includes("oil") || lower.includes("spice") || lower.includes("condiment") || lower.includes("flour") || lower.includes("sugar") || lower.includes("soup") || lower.includes("broth") || lower.includes("bean") || lower.includes("cereal") || lower.includes("oatmeal")) return CATEGORY_IMAGES.pantry;
  if (lower.includes("snack") || lower.includes("chip") || lower.includes("cracker") || lower.includes("cookie") || lower.includes("candy") || lower.includes("pretzel") || lower.includes("popcorn") || lower.includes("nut")) return CATEGORY_IMAGES.snacks;
  if (lower.includes("beverage") || lower.includes("drink") || lower.includes("juice") || lower.includes("soda") || lower.includes("water") || lower.includes("coffee") || lower.includes("tea") || lower.includes("pop") || lower.includes("energy")) return CATEGORY_IMAGES.beverages;
  if (lower.includes("deli") || lower.includes("lunch meat") || lower.includes("hot dog")) return CATEGORY_IMAGES.deli;
  if (lower.includes("seafood") || lower.includes("fish") || lower.includes("shrimp") || lower.includes("salmon") || lower.includes("tilapia") || lower.includes("crab") || lower.includes("lobster") || lower.includes("tuna")) return CATEGORY_IMAGES.seafood;
  if (lower.includes("household") || lower.includes("cleaning") || lower.includes("paper") || lower.includes("detergent") || lower.includes("trash")) return CATEGORY_IMAGES.household;
  return CATEGORY_IMAGES.other;
}

// ── Kroger deal categories (merged to reduce API calls) ─────────────────────
export const DEAL_CATEGORIES = [
  "poultry", "beef", "pork", "seafood", "lamb", "sausage", "bacon",
  "vegetables", "fruit", "salad", "herbs", "mushrooms", "potatoes",
  "pasta", "rice", "bread", "tortilla", "noodles", "grains",
  "dairy", "cheese", "eggs", "yogurt", "butter", "cream",
  "frozen meals", "frozen vegetables", "frozen pizza", "frozen seafood",
  "snacks", "beverages", "juice", "soda", "water", "tea", "coffee",
  "condiments", "canned goods",
  "breakfast", "cereal", "oatmeal", "pancake",
  "bakery", "dessert", "ice cream", "cookies",
  "deli", "lunch meat", "hot dogs",
];

// ── Recipe config maps ──────────────────────────────────────────────────────
export const DIET_MAP = {
  "Vegan": "vegan",
  "Vegetarian": "vegetarian",
  "Pescetarian": "pescetarian",
  "Keto": "ketogenic",
  "Paleo": "paleo",
  "Gluten-Free": "gluten free",
  "Dairy-Free": "dairy free",
  "Mediterranean": "mediterranean",
};

export const MEAL_TYPE_MAP = {
  "Breakfast": "breakfast",
  "Lunch": "main course,salad,soup",
  "Dinner": "main course,side dish,soup",
  "Snack": "snack,fingerfood,appetizer",
  "Dessert": "dessert",
  "Appetizer": "appetizer,fingerfood",
};

export const KID_QUERIES = {
  "Breakfast": "pancakes waffles french toast eggs",
  "Lunch": "grilled cheese quesadilla mac cheese sandwich",
  "Dinner": "pasta spaghetti meatballs chicken tacos",
  "Snack": "fruit apple cheese crackers",
  "Dessert": "cookies brownies cupcakes pudding",
  "Appetizer": "mini pizza sliders",
};

// ── Geocoding ───────────────────────────────────────────────────────────────
export async function geocodeZip(zip) {
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${zip}&key=${GOOGLE_MAPS_KEY}`
  );
  const data = await res.json();
  if (data.results?.[0]?.geometry?.location) {
    return data.results[0].geometry.location;
  }
  return null;
}

// ── Walmart auth headers ────────────────────────────────────────────────────
export const WALMART_API_BASE = "https://developer.api.walmart.com/api-proxy/service/affil/product/v2";

export function getWalmartHeaders() {
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

// ── igroceryads store URL lookup ────────────────────────────────────────────
export const IGROCERYADS_STORES = {
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

export function findIgroceryadsUrl(storeName) {
  const lower = storeName.toLowerCase().trim();
  if (IGROCERYADS_STORES[lower]) return IGROCERYADS_STORES[lower];
  for (const [key, url] of Object.entries(IGROCERYADS_STORES)) {
    if (lower.includes(key) || key.includes(lower)) return url;
  }
  return null;
}
