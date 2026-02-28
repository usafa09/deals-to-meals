import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// ── Site password protection ──────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/auth") || req.path === "/login.html") {
    return next();
  }
  const cookies = req.headers.cookie || "";
  const authed = cookies.split(";").some(c => c.trim() === `site_auth=${process.env.SITE_PASSWORD}`);
  if (authed) return next();
  res.redirect("/login.html");
});

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

// Spoonacular diet mapping
const DIET_MAP = {
  "Vegan": "vegan",
  "Vegetarian": "vegetarian",
  "Pescetarian": "pescetarian",
  "Ketogenic": "ketogenic",
  "Keto": "ketogenic",
  "Paleo": "paleo",
  "Gluten-Free": "gluten free",
  "Dairy-Free": "dairy free",
  "Mediterranean": "mediterranean",
  "Low Calorie": "whole30",
};

// Spoonacular meal type mapping
const MEAL_TYPE_MAP = {
  "Breakfast": "breakfast",
  "Lunch": "main course,salad,soup",
  "Dinner": "main course,side dish,soup",
  "Snack": "snack,fingerfood,appetizer",
  "Dessert": "dessert",
  "Appetizer": "appetizer,fingerfood",
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

// ══ STORES API ════════════════════════════════════════════════════════════════

app.get("/api/stores", async (req, res) => {
  const { zip } = req.query;
  if (!zip) return res.status(400).json({ error: "zip is required" });
  try {
    const token = await getAppToken();
    const r = await fetch(
      `${KROGER_API_BASE}/locations?filter.zipCode.near=${zip}&filter.radiusInMiles=15&filter.limit=8`,
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

// ══ DEALS API ═════════════════════════════════════════════════════════════════

app.get("/api/deals", async (req, res) => {
  const { locationId } = req.query;
  if (!locationId) return res.status(400).json({ error: "locationId is required" });
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
            const pctOff = Math.round(((item.price.regular - item.price.promo) / item.price.regular) * 100);
            return {
              id: p.productId, upc: item.upc || "", name: p.description, brand: p.brand || "", category,
              regularPrice: item.price.regular.toFixed(2), salePrice: item.price.promo.toFixed(2),
              savings: (item.price.regular - item.price.promo).toFixed(2), pctOff, size: item.size || "",
              image: p.images?.find(i => i.perspective === "front")?.sizes?.find(s => s.size === "thumbnail")?.url || null,
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
    res.json({ deals: unique });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ SPOONACULAR RECIPE SEARCH ═════════════════════════════════════════════════

app.post("/api/recipes/search", async (req, res) => {
  const { ingredients, mealType, diets, coupons, boostDeals } = req.body;
  if (!ingredients?.length) return res.status(400).json({ error: "ingredients required" });

  try {
    const apiKey = process.env.SPOONACULAR_API_KEY;

    // Build query params
    const ingredientStr = ingredients.slice(0, 20).map(i => i.name).join(",");
    const typeStr = MEAL_TYPE_MAP[mealType] || "main course";
    const dietStr = diets?.length
      ? diets.map(d => DIET_MAP[d] || d.toLowerCase()).filter(Boolean).join(",")
      : "";

    // Search for recipes using sale ingredients
const offset = req.body.offset || 0;
    const searchParams = new URLSearchParams({
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

    // Handle special filters not directly supported by Spoonacular
    if (diets?.includes("Halal")) searchParams.set("excludeIngredients", "pork,bacon,lard,gelatin,alcohol,wine,beer");
    if (diets?.includes("Kosher")) searchParams.set("excludeIngredients", "pork,shellfish,bacon,lard");
    if (diets?.includes("Low Calorie")) searchParams.set("maxCalories", "500");
    if (diets?.includes("High Fiber")) searchParams.set("minFiber", "5");

    const searchRes = await fetch(`${SPOONACULAR_BASE}/recipes/complexSearch?${searchParams}`);
    if (!searchRes.ok) throw new Error(await searchRes.text());
    const searchData = await searchRes.json();
    const recipes = searchData.results || [];

    // Build ingredient lookup for savings calculation
    const ingredientLookup = {};
    for (const ing of ingredients) {
      const key = ing.name.toLowerCase().split(" ")[0];
      ingredientLookup[key] = ing;
    }

    // Enrich each recipe with savings data and coupon recommendations
    const enriched = recipes.map(recipe => {
      const usedSaleItems = [];
      let totalSavings = 0;
      let estimatedCost = 0;

      // Match recipe ingredients to sale items
      for (const ing of (recipe.usedIngredients || [])) {
        const key = ing.name.toLowerCase().split(" ")[0];
        const deal = ingredientLookup[key] || ingredients.find(i =>
          i.name.toLowerCase().includes(ing.name.toLowerCase().split(" ")[0])
        );
        if (deal) {
          usedSaleItems.push({ name: deal.name, salePrice: deal.salePrice, regularPrice: deal.regularPrice, savings: deal.savings, upc: deal.upc });
          totalSavings += parseFloat(deal.savings) || 0;
          estimatedCost += parseFloat(deal.salePrice) || 0;
        }
      }

      // Add estimated pantry item costs (~$0.50 each)
      estimatedCost += (recipe.missedIngredientCount || 0) * 0.5;

      // Match available coupons to recipe ingredients
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
        summary: recipe.summary?.replace(/<[^>]*>/g, "").slice(0, 200) + "..." || "",
        diets: recipe.diets || [],
        cuisines: recipe.cuisines || [],
        instructions: recipe.analyzedInstructions?.[0]?.steps?.map(s => s.step) || [],
        allIngredients: [
          ...(recipe.usedIngredients || []).map(i => ({ name: i.name, onSale: true })),
          ...(recipe.missedIngredients || []).map(i => ({ name: i.name, onSale: false })),
        ],
      };
    });

    // Sort by largest savings first
    enriched.sort((a, b) => b.totalSavings - a.totalSavings);

    res.json({ recipes: enriched });
  } catch (err) {
    console.error("Recipe search error:", err.message);
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Deals to Meals running on port ${PORT}`));
