import { Router } from "express";
import { randomBytes } from "crypto";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import { trackStat } from "./gamification.js";
import {
  supabase, getUser,
  aiRecipeCache,
  CACHE_TTL,
  findDeal, logApiUsage, logError, DIET_MAP, MEAL_TYPE_MAP, KID_QUERIES,
} from "../lib/utils.js";

const router = Router();

// ── Recipe generation tracking + rate limiting ─────────────────────────────
const anonRecipeCount = new Map();
const anonDailyCount = new Map();
const authHourlyCount = new Map();
const authDailyCount = new Map();

// Hourly IP-based rate limiter for anonymous users (12/hour, cannot be spoofed)
const anonRecipeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Recipe generation limit reached. Create a free account for unlimited recipes!", limitReached: true },
});

// Clean up stale rate limit entries every hour
setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  const currentHour = Math.floor(Date.now() / 3600000);
  for (const key of anonDailyCount.keys()) {
    if (!key.endsWith(today)) anonDailyCount.delete(key);
  }
  for (const key of authDailyCount.keys()) {
    if (!key.endsWith(today)) authDailyCount.delete(key);
  }
  for (const key of authHourlyCount.keys()) {
    const h = parseInt(key.split("-").pop());
    if (h < currentHour - 1) authHourlyCount.delete(key);
  }
}, 60 * 60 * 1000);

// ══ SAVED RECIPES API ═════════════════════════════════════════════════════════

router.get("/api/recipes/saved", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { data, error } = await supabase.from("saved_recipes").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
  if (error) { console.error("Saved recipes fetch error:", error.message); return res.status(500).json({ error: "Something went wrong. Please try again." }); }
  res.json({ recipes: data });
});

router.post("/api/recipes/saved", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { title, emoji, time, servings, difficulty, ingredients, steps, store_name, image } = req.body;
  const { data, error } = await supabase.from("saved_recipes").insert({
    user_id: user.id, title, emoji, time, servings, difficulty, ingredients, steps, store_name, image,
  }).select().single();
  if (error) { console.error("Save recipe error:", error.message); return res.status(500).json({ error: "Something went wrong. Please try again." }); }
  trackStat(user.id, "recipe_saved").catch(() => {});
  res.json(data);
});

router.delete("/api/recipes/saved/:id", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { error } = await supabase.from("saved_recipes").delete().eq("id", req.params.id).eq("user_id", user.id);
  if (error) { console.error("Delete recipe error:", error.message); return res.status(500).json({ error: "Something went wrong. Please try again." }); }
  res.json({ success: true });
});

// ══ CLAUDE AI RECIPE GENERATION ══════════════════════════════════════════════

// Plan-level savings summary. Uses quantity-scaled actualCost (a recipe may use
// 4 ears of corn at $2.50/ea) and scales the regular price by the same
// quantity so sale and regular totals are in the same units. Extracted to a
// function because the cached response path needs it too — before this,
// cache-hit responses omitted savings entirely and the frontend banner
// silently hid for most users.
function computeSavingsSummary(recipes) {
  let totalSalePrice = 0, totalRegularPrice = 0, totalServings = 0;
  (recipes || []).forEach(r => {
    totalServings += (r.servings || 4);
    (r.usedSaleItems || []).forEach(item => {
      const saleUnit = parseFloat(String(item.salePrice || "0").replace(/[^0-9.]/g, "")) || 0;
      const actual = parseFloat(String(item.actualCost || "").replace(/[^0-9.]/g, "")) || saleUnit;
      const qty = saleUnit > 0 ? actual / saleUnit : 1;
      const regUnit = parseFloat(String(item.regularPrice || "0").replace(/[^0-9.]/g, "")) || 0;
      const regScaled = regUnit * qty;
      totalSalePrice += actual;
      totalRegularPrice += regScaled > actual ? regScaled : actual;
    });
  });
  return {
    totalSalePrice: Math.round(totalSalePrice * 100) / 100,
    totalRegularPrice: Math.round(totalRegularPrice * 100) / 100,
    totalSavings: Math.round((totalRegularPrice - totalSalePrice) * 100) / 100,
    savingsPercent: totalRegularPrice > 0 ? Math.round(((totalRegularPrice - totalSalePrice) / totalRegularPrice) * 100) : 0,
    costPerServing: totalServings > 0 ? Math.round((totalSalePrice / totalServings) * 100) / 100 : 0,
    servings: totalServings,
  };
}

router.post("/api/recipes/ai", async (req, res, next) => {
  // Apply stricter rate limit for anonymous users
  const user = await getUser(req);
  if (!user) {
    // Daily cap: 10 per day
    const anonId = req.headers["x-anon-id"] || req.ip;
    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = anonId + "-" + today;
    const dailyUsed = anonDailyCount.get(dailyKey) || 0;
    if (dailyUsed >= 10) {
      return res.status(429).json({ error: "Daily recipe limit reached. Create a free account for unlimited recipes!", limitReached: true });
    }
    // Hourly rate limit (express-rate-limit middleware)
    return anonRecipeLimiter(req, res, () => {
      anonDailyCount.set(dailyKey, dailyUsed + 1);
      req._anonId = anonId;
      handleRecipeGeneration(req, res);
    });
  }
  // Authenticated user rate limits: 20/hour, 50/day
  const uid = user.id;
  const now = Date.now();
  const hour = Math.floor(now / 3600000);
  const today = new Date().toISOString().slice(0, 10);
  const hourKey = uid + "-" + hour;
  const dayKey = uid + "-" + today;
  const hourUsed = authHourlyCount.get(hourKey) || 0;
  const dayUsed = authDailyCount.get(dayKey) || 0;
  if (dayUsed >= 50) {
    return res.status(429).json({ error: "You've generated a lot of recipes today! Your limit resets tomorrow. Browse your previous results in the meantime.", limitReached: true });
  }
  if (hourUsed >= 20) {
    return res.status(429).json({ error: "You've been busy! Take a break and your limit resets within the hour. Your previous recipes are still available.", limitReached: true });
  }
  authHourlyCount.set(hourKey, hourUsed + 1);
  authDailyCount.set(dayKey, dayUsed + 1);
  req._user = user;
  handleRecipeGeneration(req, res);
});

// Smart ingredient selection — prioritize proteins, produce, dairy, pantry staples
function selectSmartIngredients(deals, maxCount = 100) {
  if (deals.length <= maxCount) return deals;
  const NON_FOOD = /\b(paper|towel|tissue|trash|bag|detergent|soap|shampoo|conditioner|lotion|deodorant|toothpaste|mouthwash|bleach|cleaner|sponge|candle|wax|air freshener|pet food|dog food|cat food|cat litter|laundry|fabric softener|disinfectant|polish|batteries|light bulb|aluminum foil|plastic wrap|ziplock|garbage)\b/i;
  const included = deals.filter(d => d.mustInclude);
  const rest = deals.filter(d => !d.mustInclude).filter(d => !NON_FOOD.test(d.name || ""));
  const PROTEIN = /chicken|beef|pork|turkey|salmon|fish|shrimp|sausage|bacon|ground|steak|ham/i;
  const PRODUCE = /lettuce|tomato|onion|pepper|broccoli|carrot|potato|garlic|avocado|spinach|mushroom|corn|celery|cucumber|apple|banana|berry|lemon|lime/i;
  const DAIRY = /cheese|milk|butter|yogurt|cream|egg/i;
  const scored = rest.map(d => {
    let s = 20;
    const n = d.name || "";
    if (PROTEIN.test(n)) s += 25;
    else if (PRODUCE.test(n)) s += 20;
    else if (DAIRY.test(n)) s += 15;
    const pct = d.pctOff || (d.regularPrice && d.salePrice ? Math.round(((parseFloat(String(d.regularPrice).replace(/[^0-9.]/g,"")) - parseFloat(String(d.salePrice).replace(/[^0-9.]/g,""))) / parseFloat(String(d.regularPrice).replace(/[^0-9.]/g,""))) * 100) : 0);
    s += Math.min(pct, 50);
    return { ...d, _score: s };
  }).sort((a, b) => b._score - a._score);
  const result = [...included, ...scored.slice(0, maxCount - included.length)];
  if (result.length > maxCount) return result.slice(0, maxCount);
  console.log(`Smart selection: ${included.length} must-include + ${result.length - included.length} auto = ${result.length} total (from ${deals.length})`);
  return result;
}

// ── Recipe quantity → cost conversion ───────────────────────────────────────
// AI returns structured `quantity` + `unit` per ingredient (added to the prompt
// schema as part of the cost-calc structural fix). These helpers convert that
// structured pair into the per-deal qty the cost calculation needs. Two paths:
// per-lb deals (return lbs) and per-each/per-pack deals (return count). When
// the AI omits or returns an unrecognized unit, both helpers return null so
// the caller can fall back to the legacy hardcoded table (preserved verbatim
// in hardcodedQtyForDeal below).
const _UNIT_NORM = {
  // weight
  "lb":"lb","lbs":"lb","pound":"lb","pounds":"lb",
  "oz":"oz","ounce":"oz","ounces":"oz",
  "kg":"kg","kilogram":"kg","kilograms":"kg",
  "g":"g","gram":"g","grams":"g",
  // volume
  "cup":"cup","cups":"cup",
  "tbsp":"tbsp","tablespoon":"tbsp","tablespoons":"tbsp",
  "tsp":"tsp","teaspoon":"tsp","teaspoons":"tsp",
  "fl_oz":"fl_oz","fl-oz":"fl_oz","floz":"fl_oz","fluid_ounce":"fl_oz","fluid_ounces":"fl_oz",
  "ml":"ml","milliliter":"ml","milliliters":"ml",
  "l":"l","liter":"l","liters":"l","litre":"l","litres":"l",
  "pint":"pint","pints":"pint",
  "quart":"quart","quarts":"quart",
  // count
  "each":"each","piece":"each","pieces":"each","whole":"each","medium":"each","large":"each","small":"each",
  "can":"can","cans":"can",
  "jar":"jar","jars":"jar",
  "box":"box","boxes":"box",
  "package":"package","packages":"package","pkg":"package","pack":"package","packs":"package",
  "bunch":"bunch","bunches":"bunch",
  "head":"head","heads":"head",
  "clove":"clove","cloves":"clove",
};
function _normalizeUnit(u) {
  if (!u) return "";
  const s = String(u).toLowerCase().trim().replace(/\./g, "");
  return _UNIT_NORM[s] || "";
}
const _COUNT_UNITS = ["each","can","jar","box","package","piece","bunch","head","clove"];
// Container units mean "buy N of the deal item" — honor the multiplier.
// Item units count pieces WITHIN a package (8 hot dogs = 1 package), so for
// non-produce per-each deals they must NOT multiply the package price.
const _CONTAINER_UNITS = ["can", "jar", "box", "package"];
const _PRODUCE_CATEGORY_RE = /produce|fruit|vegetable/i;

function aiQtyToLbs(quantity, unit, ingredientHint) {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return null;
  const u = _normalizeUnit(unit);
  if (!u) return null;
  // Direct weight conversions
  switch (u) {
    case "lb":    return q * 1.0;
    case "oz":    return q * 0.0625;
    case "kg":    return q * 2.205;
    case "g":     return q * (1 / 453.6);
    case "cup":   return q * 0.4;
    case "pint":  return q * 1.0;
    case "quart": return q * 2.0;
    case "fl_oz": return q * 0.065;
    case "tbsp":  return q * 0.04;
    case "tsp":   return q * 0.013;
    case "ml":    return q * 0.0022;
    case "l":     return q * 2.2;
  }
  // Count units — ingredient-aware lb-per-item lookup
  if (_COUNT_UNITS.includes(u)) {
    const hint = String(ingredientHint || "").toLowerCase();
    let perItem = 0.5;
    if (u === "clove" && hint.includes("garlic")) perItem = 0.01;
    else if (u === "head" && hint.includes("garlic")) perItem = 0.15;
    else if (u === "head" && (hint.includes("lettuce") || hint.includes("cabbage"))) perItem = 1.5;
    else if (u === "bunch" && /parsley|cilantro|basil|mint|thyme|sage|rosemary|chive|dill|tarragon|oregano|herb/.test(hint)) perItem = 0.1;
    else if (hint.includes("onion")) perItem = 0.3;
    else if (/apple|orange|pear/.test(hint)) perItem = 0.35;
    else if (hint.includes("banana")) perItem = 0.25;
    else if (hint.includes("potato")) perItem = 0.5;
    else if (hint.includes("tomato")) perItem = 0.25;
    else if (hint.includes("pepper")) perItem = 0.3;
    else if (/lemon|lime/.test(hint)) perItem = 0.2;
    else if (hint.includes("avocado")) perItem = 0.5;
    return q * perItem;
  }
  return null;
}

function aiQtyToCount(quantity, unit) {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return null;
  const u = _normalizeUnit(unit);
  if (!u) return null;
  if (_COUNT_UNITS.includes(u)) return q;
  // Weight or volume — no sensible count derivation; let fallback handle.
  return null;
}

// Mirrors the per-lb fallback table previously inlined inside the recipe map.
// Values and matching regex are unchanged — extracted for the AI/fallback split.
function hardcodedQtyForDeal(matchedDeal) {
  const nameLower = (matchedDeal && matchedDeal.name || "").toLowerCase();
  if (nameLower.match(/chicken breast|boneless.*chicken|skinless.*chicken/)) return 2.5;
  if (nameLower.match(/chicken thigh|drumstick|chicken leg|wing/)) return 2.5;
  if (nameLower.match(/whole chicken|roaster/)) return 5;
  if (nameLower.match(/ground beef|ground turkey|ground pork/)) return 1;
  if (nameLower.match(/steak/)) return 1.5;
  if (nameLower.match(/beef.*roast|brisket/)) return 3;
  if (nameLower.match(/pork tenderloin/)) return 1.5;
  if (nameLower.match(/pork chop|pork loin/)) return 2;
  if (nameLower.match(/ribs|rack/)) return 3;
  if (nameLower.match(/salmon|tilapia|cod|fish/)) return 1;
  if (nameLower.match(/shrimp/)) return 1;
  if (nameLower.match(/sausage|bratwurst|kielbasa/)) return 1;
  if (nameLower.match(/bacon/)) return 1;
  if (nameLower.match(/apple|orange|pear/)) return 3;
  if (nameLower.match(/banana/)) return 2;
  if (nameLower.match(/grape|strawberr|blueberr|cherry/)) return 1;
  if (nameLower.match(/potato|sweet potato/)) return 3;
  if (nameLower.match(/onion/)) return 1;
  if (nameLower.match(/tomato|pepper|cucumber|zucchini|squash/)) return 0.75;
  if (nameLower.match(/broccoli|cauliflower/)) return 1.5;
  if (nameLower.match(/carrot|celery/)) return 1;
  if (nameLower.match(/lettuce|spinach|greens/)) return 0.75;
  if (nameLower.match(/mushroom/)) return 0.5;
  return 1;
}

// Pantry staples: oils, dried spices, salt/pepper, baking essentials. When a
// SALE deal matches one of these, we keep the matched-deal info available
// (so the Kroger cart-add path still works) but exclude it from the recipe's
// cost total — staples are bought once and reused across many recipes, so
// billing the full bottle/jar to one meal would over-state per-recipe cost.
//
// DELIBERATELY NOT staples (consumed in meaningful recipe quantities):
// vinegars, condiments (soy sauce, hot sauce, ketchup, mustard, mayo,
// worcestershire), flour, sugar, honey, maple syrup, broths/stocks, butter.
const _PANTRY_STAPLE_PATTERNS = [
  /\boil\b/i,                              // olive, canola, vegetable, coconut, avocado, sesame, peanut
  /\b(salt|pepper)\b/i,                    // catches "kosher salt", "black pepper", etc.
  /\b(paprika|cumin|oregano|basil|thyme|rosemary|sage|cinnamon|nutmeg|clove|cardamom|turmeric|coriander|cayenne|chili powder|garlic powder|onion powder|red pepper flake|italian seasoning|herbs de provence|bay leaf)\b/i,
  /\bvanilla extract\b/i,
  /\bbaking (powder|soda)\b/i,
  /\byeast\b/i,
  /\bcornstarch\b/i,
  /\bbutter\b/i,   // shared staple: bought once, not billed to a single recipe
];
function isPantryStaple(...names) {
  return names.filter(Boolean).some(name =>
    _PANTRY_STAPLE_PATTERNS.some(re => re.test(String(name)))
  );
}

// ── Profile dietary normalization ───────────────────────────────────────────
// Profile users can set dietary preferences in their account that flow through
// req.body.preferences.dietary in various string forms (slugs from the
// onboarding survey, capitalized labels from the profile page, etc.). This
// helper maps those forms to canonical DIET_RULES keys so the same server-side
// filter and post-gen sanity check that runs for chip-selected diets also
// runs for profile-selected diets. Deliberately not mapped: "low-carb" (less
// strict than Keto; users tolerate moderate bread/rice) and "nut-allergy"
// (an allergy, not a DIET_RULES diet — belongs in prefs.dislikes).
const _PROFILE_DIET_MAP = {
  "vegetarian":  "Vegetarian",
  "vegan":       "Vegan",
  "gluten-free": "Gluten-Free",
  "gluten_free": "Gluten-Free",
  "glutenfree":  "Gluten-Free",
  "dairy-free":  "Dairy-Free",
  "dairy_free":  "Dairy-Free",
  "dairyfree":   "Dairy-Free",
  "halal":       "Halal",
  "keto":        "Keto",
  "kosher":      "Kosher",
  "low calorie": "Low Calorie",
  "low-calorie": "Low Calorie",
};
function normalizeProfileDiet(s) {
  if (typeof s !== "string") return null;
  return _PROFILE_DIET_MAP[s.trim().toLowerCase()] || null;
}

// ── Post-generation sanity check ────────────────────────────────────────────
// AI sometimes invents ingredients that violate the active diet (e.g. "rice" in
// a Keto recipe, or chicken+cream in a Kosher recipe — the meat-dairy rule the
// pre-filter cannot enforce). These helpers scan the parsed recipe text against
// the same exclusion lists used in the pre-filter, plus a Kosher-specific
// meat-dairy conflict check, and drop violators before we serve the response.
// Defensive: wrapped in try/catch at the call site so a bug here can never
// break the endpoint.
function _escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function _wordBoundaryRegex(term) {
  return new RegExp("\\b" + _escapeRegex(term) + "(s|es)?\\b", "i");
}

function extractRecipeText(recipe) {
  const parts = [];
  if (recipe.title) parts.push(String(recipe.title));
  if (Array.isArray(recipe.ingredients)) {
    for (const ing of recipe.ingredients) {
      if (typeof ing === "string") {
        parts.push(ing);
      } else if (ing && typeof ing === "object") {
        const v = ing.name || ing.item || ing.matchName || ing.text || ing.ingredient || ing.raw || ing.displayName || "";
        if (v) parts.push(String(v));
      }
    }
  }
  if (Array.isArray(recipe.instructions)) {
    for (const step of recipe.instructions) parts.push(String(step));
  } else if (typeof recipe.instructions === "string") {
    parts.push(recipe.instructions);
  }
  if (recipe.reasoning) parts.push(String(recipe.reasoning));
  if (recipe.storage) parts.push(String(recipe.storage));
  return parts.join(" | ").toLowerCase();
}

const NON_DAIRY_PHRASES = ["coconut milk","coconut cream","coconut butter","coconut yogurt","almond milk","almond butter","almond cream","cashew milk","cashew butter","cashew cream","soy milk","soy yogurt","oat milk","oat cream","rice milk","peanut butter","sunflower butter","sun butter","seed butter","nut butter","vegan butter","vegan cheese","vegan cream","vegan yogurt","nutritional yeast"];

function stripNonDairyPhrases(text) {
  let out = text;
  for (const phrase of NON_DAIRY_PHRASES) {
    out = out.split(phrase).join("");
  }
  return out;
}

const KOSHER_MEAT_TERMS = ["chicken","beef","turkey","lamb","duck","bison","veal","bacon","ham","sausage","prosciutto","pepperoni","salami","chorizo","pancetta","brisket","meatball","ground beef","ground turkey"];
const KOSHER_DAIRY_TERMS = ["cheese","milk","butter","yogurt","cream","ghee","buttermilk","cheddar","mozzarella","parmesan","feta","ricotta","sour cream","half and half","cottage cheese","cream cheese"];

function checkMeatDairyConflict(text) {
  const meatTerms = [];
  for (const t of KOSHER_MEAT_TERMS) {
    if (_wordBoundaryRegex(t).test(text)) meatTerms.push(t);
  }
  const stripped = stripNonDairyPhrases(text);
  const dairyTerms = [];
  for (const t of KOSHER_DAIRY_TERMS) {
    if (_wordBoundaryRegex(t).test(stripped)) dairyTerms.push(t);
  }
  return {
    hasMeat: meatTerms.length > 0,
    hasDairy: dairyTerms.length > 0,
    conflict: meatTerms.length > 0 && dairyTerms.length > 0,
    meatTerms,
    dairyTerms,
  };
}

async function handleRecipeGeneration(req, res) {
  let { ingredients, style, mealType, diets, wantItems, haveItems, mealRequest, budgetTarget, leftovers, preferences, weeklyPlan, freezerMeals, offset } = req.body;
  const effectiveMealType = mealType || "Dinner";
  if (!ingredients?.length) return res.status(400).json({ error: "ingredients required" });
  if (ingredients.length > 500) return res.status(400).json({ error: "Too many ingredients — please select fewer deals or stores." });
  // Smart selection: if too many ingredients, pick the best ones for recipes
  if (ingredients.length > 100) {
    ingredients = selectSmartIngredients(ingredients, 100);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured. Add it to your .env file." });

  const _t0 = Date.now();
  try {
    const cacheKey = JSON.stringify({ items: ingredients.slice(0, 25).map(i => i.name).sort(), style, diets, wantItems: wantItems || "", haveItems: haveItems || "", mealRequest: mealRequest || "", prefs: preferences ? JSON.stringify(preferences) : "", offset: offset || 0 });
    const cached = aiRecipeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 1800000) {
      console.log("Serving cached AI recipes");
      return res.json({ recipes: cached.recipes, savings: computeSavingsSummary(cached.recipes), cached: true });
    }

    const mustInclude = ingredients.filter(i => i.mustInclude).map(i => i.name);
    const mustIncludeNote = mustInclude.length
      ? `\n\nUSER-SELECTED ITEMS (MUST USE ALL OF THESE):\n${mustInclude.map(n => "- " + n).join("\n")}\n\nThese items were hand-picked by the user from the sale list. Every recipe MUST include at least one of these items. Prioritize recipes that use multiple user-selected items together. These take HIGHEST PRIORITY over auto-selected sale items.`
      : `\n\nBUDGET MODE: The user did not select specific items. Generate the most BUDGET-FRIENDLY recipes possible using the cheapest sale items available. Prioritize recipes where the total cost per serving is under $3. Focus on items with the highest discount percentage.`;

    const wantNote = wantItems?.trim()
      ? `\n\nADDITIONAL ITEMS TO BUY: The customer also wants to purchase these items (not on sale): ${wantItems.trim()}. Include these in recipes where they fit naturally and mark them as type "ADDITIONAL".`
      : "";
    const haveNote = haveItems?.trim()
      ? `\n\nHIGHEST PRIORITY — ITEMS THE USER ALREADY HAS AT HOME (FREE):
${haveItems.trim().split(/,\s*/).map(i => "- " + i.trim()).join("\n")}

These items cost the user $0. Use as many of these as possible in EVERY recipe. They are your most valuable ingredients because they save the most money. Build recipes AROUND these items + sale items. Mark them as type "ON_HAND". Do NOT include them in the estimated cost.`
      : "";
    // Build leftovers note
    const leftoversNote = leftovers?.trim()
      ? `\n\nHIGHEST PRIORITY — LEFTOVERS TO USE UP:
${leftovers.trim().split(/,\s*/).map(i => "- " + i.trim()).join("\n")}

These are leftovers that will be WASTED if not used. Use these FIRST in as many recipes as possible. Build at least 2-3 recipes around these leftovers combined with the sale items. Mark leftover items as type "ON_HAND". For each recipe, include "usesLeftovers": true if it uses any leftover items, otherwise "usesLeftovers": false.`
      : "";

    // Build meal request note
    const mealRequestNote = mealRequest?.trim()
      ? `\n\nSPECIAL REQUEST FROM USER: "${mealRequest.trim()}"\nThis is the user's top priority. Try to incorporate this request into as many recipes as possible while still using the sale items. If the request conflicts with available sale items, prioritize the request and find the cheapest way to fulfill it.`
      : "";

    // Build budget constraint note
    const budgetNote = budgetTarget && budgetTarget > 0
      ? `\n\nBUDGET CONSTRAINT: The user wants to spend no more than $${budgetTarget} total for all meals this week. Using the sale prices provided, ensure the combined cost of all recipes stays under this target. If the budget is very tight, prioritize the cheapest possible meals and maximize use of pantry items. Show the total cost prominently.`
      : "";

    // Build family members note
    let familyNote = "";
    const prefs = preferences || {};
    const members = prefs.family_members || [];
    if (members.length > 0) {
      const memberLines = members.map(m => {
        const parts = [`- ${m.name || "Family member"} (${m.ageGroup || "adult"})`];
        if (m.dietary) parts.push(m.dietary);
        if (m.dislikes) parts.push(`dislikes: ${m.dislikes}`);
        if (m.notes) parts.push(m.notes);
        return parts.join(": ");
      });
      familyNote = `\n\nFAMILY MEMBERS:\n${memberLines.join("\n")}\n\nGenerate recipes that work for the WHOLE FAMILY. If a recipe can't please everyone, suggest a simple modification (e.g. "For picky eaters: serve the sauce on the side"). Flag any allergen conflicts.`;
    }

    // Build user profile note from preferences. Coerce array fields defensively:
    // production sends arrays for prefs.dietary and prefs.flavor_preferences,
    // but legacy survey paths and partial-fill profiles can deliver bare strings,
    // and .join() on a string throws TypeError. The coercions below preserve the
    // existing "skip if 'none'/'anything'" semantics for both shapes.
    let profileNote = "";
    const _dietaryArr = Array.isArray(prefs.dietary) ? prefs.dietary : (prefs.dietary ? [prefs.dietary] : []);
    const _flavorArr = Array.isArray(prefs.flavor_preferences) ? prefs.flavor_preferences : (prefs.flavor_preferences ? [prefs.flavor_preferences] : []);
    if (prefs.household_size || prefs.skill_level || prefs.cook_time || _dietaryArr.length || _flavorArr.length || prefs.dislikes) {
      const parts = ["USER PROFILE:"];
      if (prefs.household_size) parts.push(`- Cooking for: ${prefs.household_size} people${prefs.has_kids ? " (including kids under 12 — keep recipes kid-friendly)" : ""}`);
      if (prefs.skill_level) parts.push(`- Skill level: ${prefs.skill_level}`);
      if (prefs.cook_time) parts.push(`- Available time: ${prefs.cook_time === "any" ? "no limit" : prefs.cook_time + " minutes"}`);
      if (_dietaryArr.length && !_dietaryArr.includes("none")) parts.push(`- Dietary needs: ${_dietaryArr.join(", ")}`);
      if (_flavorArr.length && !_flavorArr.includes("anything")) parts.push(`- Flavor preferences: ${_flavorArr.join(", ")}`);
      if (prefs.dislikes) parts.push(`- Dislikes (NEVER include these ingredients): ${prefs.dislikes}`);
      parts.push("");
      parts.push(`IMPORTANT: Respect ALL dietary restrictions and dislikes. NEVER include disliked ingredients. Adjust recipe complexity to match the skill level.${prefs.cook_time && prefs.cook_time !== "any" ? " Keep total cook time within " + prefs.cook_time + " minutes." : ""}${prefs.household_size ? " Default serving size to " + prefs.household_size + " people." : ""}`);
      profileNote = "\n\n" + parts.join("\n");
    }

    // Fetch user history for personalization
    const _tHistory = Date.now();
    let historyNote = "";
    if (req._user?.id) {
      try {
        const { data: interactions } = await supabase
          .from("recipe_interactions")
          .select("recipe_name, recipe_tags, action")
          .eq("user_id", req._user.id)
          .order("created_at", { ascending: false })
          .limit(20);
        if (interactions?.length) {
          const saved = interactions.filter(i => i.action === "saved" || i.action === "cooked").map(i => i.recipe_name);
          const skipped = interactions.filter(i => i.action === "skipped").map(i => i.recipe_name);
          const allTags = interactions.filter(i => i.action === "saved" || i.action === "cooked").flatMap(i => i.recipe_tags || []);
          const tagCounts = {};
          allTags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
          const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
          const parts = ["USER HISTORY — use this to personalize recommendations:"];
          if (saved.length) parts.push(`Recipes they SAVED or COOKED (suggest similar): ${saved.slice(0, 8).join(", ")}`);
          if (skipped.length) parts.push(`Recipes they SKIPPED (avoid similar): ${skipped.slice(0, 5).join(", ")}`);
          if (topTags.length) parts.push(`Preferred styles based on history: ${topTags.join(", ")}`);
          historyNote = "\n\n" + parts.join("\n");
        }
      } catch (e) { /* history fetch failed, continue without it */ }
    }

    // DIET_RULES: existing entries (Vegetarian, Gluten-Free, Dairy-Free, Low Calorie)
    // use `exclude` with naive substring includes() matching. New entries (Halal, Keto,
    // Vegan) use `excludeWord` with word-boundary regex matching (now plural-aware via
    // (s|es)?) to avoid false positives like "egg" matching "eggplant" or "ham" matching
    // "hamburger". Diets can use BOTH fields: substring for terms that need to catch
    // compounds (Keto "bread" → also breadcrumbs, cornbread, shortbread; Vegan "fish" →
    // also swordfish, catfish), word-boundary for terms that risk false positives.
    //
    // OPTIONAL `whitelistPhrase` field: a list of multi-word phrases that, when present
    // as a substring in an ingredient name, BYPASS the excludeWord match for that
    // ingredient. Used for Vegan's "peanut butter" / "almond butter" exception — the
    // \bbutter\b excludeWord rule needs to fire on dairy butter but not on plant-based
    // nut/seed butters. Whitelist applies ONLY to excludeWord, not to substring exclude
    // (substring matches stay authoritative). Whitelists union across active diets, so
    // a phrase whitelisted by one diet bypasses excludeWord checks from any active diet.
    // Future retrofit: migrate the four existing legacy entries to excludeWord too.
    const DIET_RULES = {
      "Vegetarian": {
        rule: "VEGETARIAN: Absolutely NO meat, poultry, or fish of any kind. Eggs and dairy ARE allowed.",
        exclude: ["chicken","beef","pork","turkey","bacon","ham","sausage","salmon","shrimp","tilapia","tuna","cod","lamb","steak","ribs","roast","meatball","hot dog","ground beef","ground turkey","brisket","pepperoni","salami","deli meat","fish","seafood","crab","lobster","clam","mussel","anchov"]
      },
      "Gluten-Free": {
        rule: "GLUTEN-FREE: No wheat, barley, rye, or regular pasta/bread/flour. Use rice, potatoes, corn, gluten-free alternatives.",
        exclude: ["bread","pasta","spaghetti","noodle","flour tortilla","cracker","cookie","cake","pie crust","croissant","bagel","muffin","pancake mix","biscuit","pretzel","wheat","barley","rye","couscous"]
      },
      "Dairy-Free": {
        rule: "DAIRY-FREE: No milk, cheese, butter, cream, yogurt, sour cream, ice cream, or any dairy product.",
        exclude: ["milk","cheese","butter","yogurt","cream","sour cream","ice cream","whipped cream","half and half","cottage cheese","cream cheese"]
      },
      "Low Calorie": { rule: "LOW CALORIE: Each serving must be under 500 calories. Lean proteins, lots of vegetables, minimal oil/butter/cheese.", exclude: [] },
      "Halal": {
        rule: "HALAL: No pork or pork-derived products, no alcohol or cooking wines, no gelatin or other non-halal animal products. Use halal-certified meats and plant-based ingredients only.",
        excludeWord: ["pork","bacon","ham","lard","prosciutto","pepperoni","pancetta","chorizo","salami","wine","beer","rum","vodka","whiskey","sake","mirin","sherry","gelatin"]
      },
      "Keto": {
        rule: "KETO: Very low carbohydrate. No bread, pasta, rice, sugar, starchy vegetables, beans/legumes, or grain products. Focus on fats, proteins, and low-carb vegetables.",
        // "bread" appears in BOTH lists: substring catches compounds (breadcrumbs,
        // cornbread, shortbread, breadfruit), word-boundary catches the standalone
        // form. The duplicate is idempotent — filter logic ORs across both passes.
        exclude: ["bread"],
        excludeWord: ["bread","pasta","rice","potato","corn","sugar","syrup","honey","flour","tortilla","bagel","cereal","oat","granola","lentil","chickpea","bean","cracker","cookie","rolls","roll","bun","biscuit","muffin","croissant","pita","naan","baguette","pancake","waffle","donut","doughnut","pretzel","breadstick"]
      },
      "Vegan": {
        rule: "VEGAN: Absolutely NO animal products of any kind — no meat, poultry, fish, dairy, eggs, honey, or gelatin. Use only plant-based ingredients.",
        exclude: ["fish","seafood","anchov","crab","lobster","clam","mussel","salmon","tuna","tilapia","cod","shrimp","oyster","scallop"],
        excludeWord: ["chicken","beef","pork","turkey","bacon","ham","sausage","lamb","steak","ribs","roast","meatball","hot dog","ground beef","ground turkey","brisket","pepperoni","salami","deli meat","milk","cheese","butter","yogurt","cream","eggs","egg","honey","gelatin","lard","tallow"],
        // Plant-based nut/seed butters: bypass the \bbutter\b excludeWord match.
        // Substring exclude (above) is unaffected — "peanut butter" still gets checked
        // against fish/seafood/etc. terms, none of which appear in nut butters.
        whitelistPhrase: ["peanut butter","almond butter","cashew butter","sunflower butter","nut butter","seed butter"]
      },
      // KOSHER: the meat-dairy separation rule (no mixing meat/poultry with dairy in
      // a single recipe) is a RECIPE-LEVEL constraint that the substring/word-boundary
      // ingredient filter cannot enforce — both meat and dairy can independently pass
      // through. Compliance for that rule relies entirely on AI adherence to the
      // `rule` text below. Same documentation pattern as the Peanut Butter false
      // positive: server-side filter handles what it can, prompt text handles the rest.
      "Kosher": {
        rule: "KOSHER: Follow kashrut laws. NO pork, shellfish, non-finned/scaled fish (catfish, swordfish, shark, eel, monkfish), rabbit, or non-kosher gelatin. CRITICAL: Do NOT mix meat or poultry with dairy in the same recipe. If a recipe contains meat, fish, or poultry, do NOT include any dairy products (milk, cheese, butter, yogurt, cream). Use kosher-certified versions of all animal products and gelatin.",
        exclude: ["seafood"],
        excludeWord: ["pork","bacon","ham","lard","prosciutto","pepperoni","pancetta","chorizo","salami","gelatin","rabbit","hare","catfish","swordfish","shark","eel","monkfish","shrimp","lobster","crab","clam","mussel","oyster","scallop","prawn","crawfish","crayfish","langoustine","octopus","squid","calamari","snail","escargot","cuttlefish"]
      },
    };

    // Merge profile dietary preferences with chip-selected diets. activeDiets
    // is server-side only — the per-recipe response field still reflects the
    // raw chip selections so the frontend behavior is unchanged.
    let activeDiets = Array.isArray(diets) ? [...diets] : [];
    if (prefs && prefs.dietary) {
      const items = Array.isArray(prefs.dietary) ? prefs.dietary : [prefs.dietary];
      for (const raw of items) {
        const norm = normalizeProfileDiet(raw);
        if (norm && !activeDiets.includes(norm)) activeDiets.push(norm);
      }
    }
    if (activeDiets.length > diets?.length) {
      console.log(`Profile dietary merged: chips=[${(diets||[]).join(",")}] → active=[${activeDiets.join(",")}]`);
    }

    let filteredIngredients = [...ingredients];
    let dietNote = "";
    if (activeDiets.length) {
      const allExcluded = new Set();
      const allExcludedWord = new Set();
      const allWhitelist = new Set();
      const rules = [];
      for (const d of activeDiets) {
        const info = DIET_RULES[d];
        if (!info) continue;
        rules.push(info.rule);
        for (const term of (info.exclude || [])) allExcluded.add(term);
        for (const term of (info.excludeWord || [])) allExcludedWord.add(term);
        for (const term of (info.whitelistPhrase || [])) allWhitelist.add(term);
      }
      if (allExcluded.size > 0 || allExcludedWord.size > 0) {
        const wordPatterns = [...allExcludedWord].map(t =>
          new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(s|es)?\\b", "i"));
        const whitelistArr = [...allWhitelist];
        const before = filteredIngredients.length;
        filteredIngredients = filteredIngredients.filter(i => {
          const name = i.name.toLowerCase();
          // Substring exclude is authoritative — whitelist does NOT bypass it.
          if ([...allExcluded].some(term => name.includes(term))) return false;
          // Whitelist bypasses excludeWord (e.g. "peanut butter" survives \bbutter\b).
          const isWhitelisted = whitelistArr.length > 0 && whitelistArr.some(phrase => name.includes(phrase));
          if (!isWhitelisted && wordPatterns.some(re => re.test(name))) return false;
          return true;
        });
        const removed = before - filteredIngredients.length;
        if (removed > 0) console.log(`Diet filter: removed ${removed} items that violate ${activeDiets.join(", ")} restrictions`);
      }
      dietNote = `\n\nSTRICT DIETARY RESTRICTIONS — THESE ARE ABSOLUTE AND MUST NEVER BE VIOLATED:\n${rules.join("\n")}\n\nI have already removed sale items that violate these restrictions from the list below. Do NOT add any ingredients that violate these rules. Do NOT suggest meat/fish/dairy substitutions if those are restricted. Every single recipe must fully comply.`;
    }

    // prefs.dislikes server-side filter — runs after DIET_RULES filter, uses the same
    // word-boundary matching style as the new diet entries. Tokenizes free-text on
    // non-letter chars, drops stop words and short tokens, then word-boundary-matches
    // each token (with optional plural 's') against ingredient names. This catches
    // "peanuts" → "Peanut Butter" while preventing "egg" → "Eggplant" false positives.
    if (prefs.dislikes && typeof prefs.dislikes === "string") {
      const STOP_WORDS = new Set(["no","not","any","i","my","kid","kids","is","are","to","the","a","an","with","from","for","allergic","hate","hates","dislikes","dislike","dont","wont","cant","eat","eats","like","likes","please","food","ingredient","also"]);
      const tokens = prefs.dislikes.toLowerCase()
        .split(/[^a-z]+/)
        .filter(t => t && t.length >= 3 && !STOP_WORDS.has(t))
        .map(t => t.endsWith("s") ? t.slice(0, -1) : t);
      if (tokens.length > 0) {
        const dislikePatterns = tokens.map(t =>
          new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(s)?\\b", "i"));
        const before = filteredIngredients.length;
        filteredIngredients = filteredIngredients.filter(i => {
          const name = i.name.toLowerCase();
          return !dislikePatterns.some(re => re.test(name));
        });
        const removed = before - filteredIngredients.length;
        if (removed > 0) console.log(`Dislikes filter: removed ${removed} items matching tokens [${tokens.join(", ")}]`);
      }
    }

    // Group sale items by category for the prompt
    const CATS = {
      protein: /chicken|beef|pork|turkey|salmon|fish|shrimp|sausage|bacon|ground|steak|ham|tilapia|tuna|meatball/i,
      produce: /lettuce|tomato|onion|pepper|broccoli|carrot|potato|garlic|avocado|spinach|mushroom|corn|celery|cucumber|apple|banana|berry|lemon|lime|zucchini|squash|cabbage|kale|green bean/i,
      dairy: /cheese|milk|butter|yogurt|cream|egg|sour cream/i,
      pantry: /pasta|rice|bread|flour|sugar|oil|sauce|broth|beans|canned|tortilla|cereal|oat|crackers|chips|soup|salsa/i,
      frozen: /frozen|ice cream/i,
    };
    function categorize(name) {
      const n = (name || "").toLowerCase();
      for (const [cat, re] of Object.entries(CATS)) { if (re.test(n)) return cat; }
      return "other";
    }
    const grouped = {};
    const itemsToSend = filteredIngredients.slice(0, 100);
    for (const i of itemsToSend) {
      const cat = categorize(i.name);
      if (!grouped[cat]) grouped[cat] = [];
      const parts = [i.name];
      if (i.salePrice) parts.push(`$${i.salePrice}${i.priceUnit || ""}`);
      if (i.regularPrice && i.regularPrice !== i.salePrice) parts.push(`(reg $${i.regularPrice}${i.priceUnit || ""})`);
      if (i.storeName) parts.push(`at ${i.storeName}`);
      grouped[cat].push("- " + parts.join(" "));
    }
    const catLabels = { protein: "PROTEINS ON SALE", produce: "PRODUCE ON SALE", dairy: "DAIRY ON SALE", pantry: "PANTRY/STAPLES ON SALE", frozen: "FROZEN ON SALE", other: "OTHER ITEMS ON SALE" };
    const saleItemsList = Object.entries(grouped).map(([cat, items]) => `${catLabels[cat] || cat.toUpperCase()}:\n${items.join("\n")}`).join("\n\n");

    const styleGuide = {
      "Quick Weeknight": "30 minutes or less total time. Minimal prep, one pan/pot preferred. Think sheet pan meals, stir fries, tacos, simple pasta dishes.",
      "Family-Friendly": "Kid-approved flavors — nothing too spicy or exotic. Think mac and cheese, chicken tenders, sloppy joes, pizza, meatballs, quesadillas, burgers. Picky eater safe.",
      "Comfort Food": "Hearty, warming, filling. Casseroles, soups, stews, chili, pot pies, meatloaf, baked pasta, one-pot meals. The kind of food grandma would make.",
      "Meal Prep": "Makes 4-6 servings that reheat well. Good for packing lunches. Think grain bowls, burritos, soups, casseroles that last 3-4 days in the fridge.",
      "Healthy & Light": "Under 500 calories per serving. Lots of vegetables, lean proteins, whole grains. Light on cheese/cream/butter. Think salads, grain bowls, grilled proteins with roasted veggies.",
      "Slow Cooker": "Dump-and-go crockpot recipes. 6-8 hour cook time, minimal prep. Think pulled pork, chicken tacos, soups, stews, pot roast. Set it and forget it.",
    };

    const styleDesc = styleGuide[style] || "";
    const MEAL_TYPE_GUIDES = {
      "Breakfast": "MEAL TYPE: BREAKFAST. Only suggest traditional breakfast foods: eggs, pancakes, oatmeal, toast, breakfast burritos, smoothie bowls, french toast, omelets, frittatas, hash browns, breakfast sandwiches, waffles, bacon & eggs, yogurt parfaits. Do NOT suggest desserts, brownies, cookies, candy, marshmallows, cake, or pie. Every recipe must be something people eat for breakfast.",
      "Lunch": "MEAL TYPE: LUNCH. Suggest lunch-appropriate foods: sandwiches, wraps, salads, soups, burgers, quesadillas, grain bowls, pasta salads. Do NOT suggest desserts or heavy dinner-only dishes.",
      "Dinner": "MEAL TYPE: DINNER. Suggest dinner-appropriate foods: main courses with protein and sides, casseroles, stir-fries, pasta dishes, roasts, tacos, soups, stews. Do NOT suggest desserts or breakfast foods.",
      "Snack": "MEAL TYPE: SNACK. Suggest snack-sized items: dips, trail mix, energy bites, veggie trays, popcorn variations, cheese plates, bruschetta.",
      "Dessert": "MEAL TYPE: DESSERT. Suggest sweet treats: cookies, brownies, cakes, pies, ice cream, pudding, fruit desserts.",
      "Appetizer": "MEAL TYPE: APPETIZER. Suggest starters: bruschetta, dips, sliders, spring rolls, stuffed mushrooms, cheese boards.",
    };
    const mealTypeGuide = MEAL_TYPE_GUIDES[effectiveMealType] || MEAL_TYPE_GUIDES["Dinner"];
    const batchNote = (offset && offset > 0) ? `\n\nThis is batch #${Math.floor(offset/5)+1}. Generate 6 DIFFERENT recipes from previous batches. Be creative — try different cuisines, cooking methods, and flavor profiles.` : "";

    const prompt = `You are a budget-friendly recipe assistant. A customer is shopping grocery deals and wants recipe ideas BUILT FROM what's on sale this week. Your #1 goal is to MAXIMIZE the use of sale items in every recipe.

${mealTypeGuide}
${styleDesc ? "RECIPE STYLE: " + style + "\n" + styleDesc : "RECIPE STYLE: Family-friendly default. Recipes should be broadly appealing, approachable, and safe for a household with kids. No exotic ingredients, no advanced techniques, nothing that would surprise a typical American home cook. Keep flavors familiar (mild, savory, mainstream)."}

${haveNote ? haveNote + "\n" : ""}
${saleItemsList}
${leftoversNote}${mustIncludeNote}${wantNote}${mealRequestNote}${budgetNote}${profileNote}${familyNote}${historyNote}${batchNote}

CRITICAL: Each recipe MUST use AT LEAST 4-6 sale items as core ingredients. Use items from MULTIPLE categories above (e.g. a protein + vegetables + dairy + a pantry item).${haveNote ? " ALSO use as many ON HAND items as possible — they are FREE and save the customer the most money." : ""} Only add non-sale items when absolutely necessary (salt, pepper, water, basic oil, spices). The whole point is cooking from what's cheap THIS WEEK.

RECIPE GENERATION RULES:
1. COST OPTIMIZATION: Using the sale prices provided, calculate the approximate cost per serving for each recipe. Sort recipes from cheapest to most expensive. Include "costPerServing" (a number in dollars, e.g. 2.50) in each recipe object.
2. INGREDIENT SHARING: Design recipes that share ingredients with each other. If chicken thighs are on sale, use them in 2-3 different recipes with different preparations (stir fry, baked, soup). This minimizes what the user needs to buy.
3. VARIETY: Do not repeat the same protein in more than 2 recipes. Ensure at least 2 different cooking methods (baking, stovetop, slow cooker, no-cook). Include at least 1 vegetarian option.
4. PRACTICAL COOKING: Assume a home kitchen with basic equipment (oven, stovetop, one sheet pan, one pot, one skillet). No specialty equipment unless the user mentions it.
5. REALISTIC PORTIONS: Default to ${prefs.household_size || "4"} servings. Include storage instructions if the recipe makes good leftovers (add a "storage" field with a short tip, e.g. "Keeps 3 days in the fridge. Reheat in skillet.").
6. SEASONAL AWARENESS: Current month is ${new Date().toLocaleString("en-US", { month: "long" })}. Prefer seasonal produce and cooking styles appropriate for the season.
7. BEGINNER FRIENDLY: ${prefs.skill_level === "confident" || prefs.skill_level === "advanced" ? "The user is an experienced cook — you can use advanced techniques, assume knife skills, and skip basic explanations." : "Write instructions that a beginner cook can follow. Use common terms, specify heat levels (medium-high), and include timing cues (cook until golden brown, about 5 minutes)."}

${freezerMeals ? `Generate exactly 5 FREEZER-FRIENDLY recipes using the sale items. Each recipe MUST:
- Be suitable for freezing and reheating (no salads, no fresh herbs that don't freeze)
- Include freezing and reheating instructions
- Be designed for batch cooking (double or triple batch)
- Prioritize items with the deepest discounts — stock-up opportunities
- Include extra fields: "freezeInstructions", "reheatInstructions", "batchSize", "shelfLife"` :
weeklyPlan ? `Generate exactly 5 dinner recipes for a WEEKLY MEAL PLAN (Monday through Friday). Each recipe MUST include a "day" field ("Monday", "Tuesday", etc.). These recipes MUST:
- Share ingredients across multiple meals to minimize the total shopping list
- Use the same protein in no more than 2 meals
- Progress from easiest on Monday (everyone is tired) to more involved later in the week
- Total combined cost should stay under $50 for a family of ${prefs.household_size || "4"}
- At the end of instructions for Friday's recipe, add a note about which ingredients were shared across the week` : (ingredients.length < 8 ? "Generate exactly 5 recipes. With limited sale items available, prioritize 5 recipes that use distinct cooking methods (e.g., baked, stovetop, slow cooker, sheet pan, no-cook) rather than 6 with overlap." : "Generate exactly 6 recipes.")} Each recipe should:
- Use 4-6+ of the sale items above as key ingredients (NOT just 1-2)
- Combine items from at least 2-3 different sale categories
- Be genuinely budget-friendly (under $12 total for 4 servings)
- Add basic pantry staples as needed (see PANTRY rules below)
- Have clear, numbered step-by-step instructions a beginner cook could follow
- Be a REAL recipe that actually works — not made up combinations
- Stay within ONE cuisine register per recipe (Italian, Mexican, Asian, American, Mediterranean, Tex-Mex, etc.). Do not mix cuisines within a single recipe — for example, no soy sauce in an Italian dish, no taco seasoning on chicken parmigiana.
- Processed products on sale (chicken nuggets, fish sticks, frozen pizza, breaded shrimp, frozen burritos, mac & cheese boxes, etc.): either (a) use as-is in an assembled dish (e.g. nugget parm, fish stick tacos), or (b) skip the product entirely. NEVER substitute a processed product for the raw ingredient it imitates (no breaded frozen shrimp in a butter-garlic shrimp skillet). NEVER list a processed product as an ingredient in a "homemade" version of itself ("homemade chicken nuggets" must use raw chicken breast, not pre-made nuggets).
${dietNote}

Output brevity: keep "instructions" to 5-8 short numbered steps. Keep "reasoning" under 30 words. Aim for 6-9 ingredient lines per recipe; add more only when the dish truly requires it.

Respond with ONLY valid JSON, no other text. Use this exact format:
{
  "recipes": [
    {
      "title": "Recipe Name",
      "cookTime": 25,
      "servings": 4,
      "costPerServing": 2.50,
      "storage": "Keeps 3 days in the fridge. Reheat in skillet.",
      "reasoning": "Chicken thighs are 56% off at Kroger this week, and combined with sale broccoli and pantry rice, this meal costs only $1.85 per serving.",
      "calories": 450,
      "protein": 35,
      "carbs": 40,
      "fat": 15,
      "fiber": 4,
      "saleItemsUsed": ["Chicken Thighs", "Rice"],
      "ingredients": [
        {"item": "1.5 lbs chicken thighs", "type": "SALE", "matchName": "Chicken Thighs", "quantity": 1.5, "unit": "lb"},
        {"item": "2 cups rice", "type": "SALE", "matchName": "Rice", "quantity": 2, "unit": "cup"},
        {"item": "2 medium yellow onions, diced", "type": "SALE", "matchName": "Yellow Onion", "quantity": 2, "unit": "each"},
        {"item": "1 lb fresh broccoli", "type": "ADDITIONAL", "matchName": "", "quantity": 1, "unit": "lb"},
        {"item": "2 cups cooked quinoa", "type": "ON_HAND", "matchName": "", "quantity": 2, "unit": "cup"},
        {"item": "1 tbsp olive oil", "type": "PANTRY", "matchName": "", "quantity": 1, "unit": "tbsp"},
        {"item": "Salt and pepper to taste", "type": "PANTRY", "matchName": "", "quantity": 0, "unit": ""}
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
- "quantity" must be a number representing the recipe's actual quantity. For "to taste" or trivial amounts, use 0.
- "unit" must be from this controlled vocabulary: lb, oz, kg, g, cup, tbsp, tsp, fl_oz, ml, l, pint, quart, each, can, jar, box, package, bunch, head, clove. Use empty string for "to taste" amounts.
- Be ACCURATE about quantity. These fields are used to compute the recipe's actual cost. If "item" says "1.5 lbs chicken thighs", quantity MUST be 1.5 and unit MUST be "lb". Do not round or guess.
- Do NOT include "estimatedCost" — we calculate that from real prices.
- "calories", "protein", "carbs", "fat", "fiber" = estimated nutrition per serving (numbers only, no units). These are rough estimates.`;

    const _tPromptBuilt = Date.now();
    console.log(`[recipes/ai] prompt_build_ms=${_tPromptBuilt - _t0} history_ms=${_tPromptBuilt - _tHistory} ingredients=${ingredients.length}`);

    // PROMPT CACHING OPPORTUNITY (deferred):
    // Static prefix is ~900 tokens; Haiku 4.5 minimum cache is 4,096 tokens.
    // To enable: (1) move dynamic interpolations out (current month, household_size,
    // skill_level, cook_time, mode branches), (2) inline all guide variants verbatim,
    // (3) add concrete recipe examples to hit threshold. ~90% input cost reduction
    // when activated. Defer until: Anthropic lowers Haiku 4.5 cache minimum, OR
    // daily token spend exceeds ~$5/day (~70x current), OR there's a real product
    // reason to expand prompt with examples.
    const claudeBody = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      temperature: 0.7,
      messages: [{ role: "user", content: prompt }],
    });
    const claudeHeaders = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };

    const _tClaude = Date.now();
    let response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: claudeHeaders, body: claudeBody });

    // Retry once with 5s delay on overload (529)
    if (response.status === 529) {
      console.log("Claude API overloaded (529) — retrying in 5 seconds...");
      await new Promise(r => setTimeout(r, 5000));
      response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: claudeHeaders, body: claudeBody });
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error("Claude API error:", response.status, errText);
      if (response.status === 529) {
        return res.status(503).json({ error: "ai_overloaded", message: "Our recipe builder is temporarily busy. Please try again in a minute." });
      }
      throw new Error(`Claude API error ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const _tClaudeDone = Date.now();
    const text = data.content?.[0]?.text || "";
    const stopReason = data.stop_reason || "";
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    if (stopReason === "max_tokens") console.log("⚠️ AI response was truncated (hit max_tokens limit)");
    console.log(`[recipes/ai] claude_ms=${_tClaudeDone - _tClaude} input_tokens=${inputTokens} output_tokens=${outputTokens} response_chars=${text.length} stop=${stopReason}`);

    let clean = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      console.log("Initial JSON parse failed, attempting recovery...");
      try {
        const recipesStart = clean.indexOf('"recipes"');
        if (recipesStart === -1) throw new Error("No recipes found");
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

    // Post-generation sanity check: drop AI-generated recipes that violate active
    // diet restrictions. Defensive — falls back to unfiltered output on any error.
    if (Array.isArray(parsed.recipes) && activeDiets.length) {
      try {
        const validateRecipes = (recipeList, activeDiets) => {
          const valid = [];
          const dropped = [];
          for (const recipe of recipeList) {
            const text = extractRecipeText(recipe);
            const reasons = [];
            for (const diet of activeDiets) {
              if (diet === "Kosher") {
                const c = checkMeatDairyConflict(text);
                if (c.conflict) {
                  reasons.push(`Kosher meat-dairy mix: meat=[${c.meatTerms.join(",")}], dairy=[${c.dairyTerms.join(",")}]`);
                }
              }
              const info = DIET_RULES[diet];
              if (!info) continue;
              for (const term of (info.exclude || [])) {
                if (text.includes(term)) reasons.push(`${diet} forbidden term: ${term}`);
              }
              for (const term of (info.excludeWord || [])) {
                if (_wordBoundaryRegex(term).test(text)) reasons.push(`${diet} forbidden term: ${term}`);
              }
            }
            if (reasons.length > 0) dropped.push({ recipe, reasons });
            else valid.push(recipe);
          }
          return { valid, dropped };
        };

        const result = validateRecipes(parsed.recipes, activeDiets);
        if (result.dropped.length > 0) {
          console.log(`Post-gen sanity check: dropped ${result.dropped.length}/${parsed.recipes.length} recipes for diet violations`);
          for (const d of result.dropped) {
            console.log(`  • [${d.recipe.title}] ${d.reasons.join("; ")}`);
          }
        }
        parsed.recipes = result.valid;
      } catch (e) {
        console.error("Post-gen sanity check failed (falling back to unfiltered):", e.message);
      }
    }

    // Ask for 6, serve 5 — guards against Claude undercounting
    const rawRecipes = (parsed.recipes || []).slice(0, 5);
    let recipes = rawRecipes.map((r, idx) => {
      const usedSaleItems = [];
      let totalSavings = 0;
      let saleCost = 0;
      let regularCost = 0;
      let additionalCost = 0;
      let aiQtyCount = 0;
      let fbQtyCount = 0;
      let stapleExcludedCount = 0;

      const ingredientLookup = ingredients.map(ing => ({
        ...ing,
        nameLower: ing.name.toLowerCase(),
        nameWords: ing.name.toLowerCase().split(/[\s,\-\/]+/).filter(w => w.length > 2),
      }));

      const processedIngredients = (r.ingredients || []).map(ing => {
        const isStructured = typeof ing === "object" && ing.item;
        const itemText = isStructured ? ing.item : String(ing);
        const type = isStructured ? (ing.type || "PANTRY") :
          (itemText.toLowerCase().includes("on sale") ? "SALE" :
           itemText.toLowerCase().includes("additional") ? "ADDITIONAL" :
           itemText.toLowerCase().includes("on hand") ? "ON_HAND" : "PANTRY");
        const matchName = isStructured ? (ing.matchName || "") : "";

        let matchedDeal = null;

        if (type === "SALE") {
          if (matchName) {
            const matchLower = matchName.toLowerCase();
            matchedDeal = ingredientLookup.find(d => d.nameLower === matchLower);
            if (!matchedDeal) {
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

          // Tier 1: AI-supplied quantity + unit. Tier 2: hardcoded fallback table.
          let qtySource = "fallback";
          if (isPerLb) {
            const aiLbs = aiQtyToLbs(ing && ing.quantity, ing && ing.unit, matchedDeal.name);
            if (aiLbs != null && aiLbs > 0) { qty = aiLbs; qtySource = "ai"; }
            else { qty = hardcodedQtyForDeal(matchedDeal); qtySource = "fallback"; }
          } else {
            const aiCnt = aiQtyToCount(ing && ing.quantity, ing && ing.unit);
            const normUnit = _normalizeUnit(ing && ing.unit);
            const isContainerUnit = _CONTAINER_UNITS.includes(normUnit);
            const isProduce = _PRODUCE_CATEGORY_RE.test(String(matchedDeal.category || ""));
            if (aiCnt != null && aiCnt > 0) {
              if (isContainerUnit || isProduce) {
                qty = aiCnt; qtySource = "ai";
              } else {
                // Item-count unit on a packaged good: one package covers the recipe.
                qty = 1; qtySource = "ai-clamped";
                console.warn(`qty-clamp: "${ing && ing.item}" matched "${matchedDeal.name}" — AI count ${aiCnt} ${normUnit || "?"} clamped to 1 package`);
              }
            }
            else { qty = 1; qtySource = "fallback"; }
          }
          if (qtySource === "ai") aiQtyCount++; else fbQtyCount++;

          // Pantry-staple exclusion: zero the cost contribution if this match is a
          // staple (oils, dried spices, salt/pepper, baking essentials). The matched
          // deal still appears in usedSaleItems with full identity (price, store, upc)
          // so the Kroger cart-add path keeps working; only the cost roll-up is zeroed.
          const isStaple = isPantryStaple(ing && ing.item, ing && ing.matchName, matchedDeal.name);
          // Validation gate: per-each non-produce ingredient charging >4 packages
          // or >$20 is a units error, not a real basket. Clamp and log.
          if (!isPerLb && qty > 4 && !_PRODUCE_CATEGORY_RE.test(String(matchedDeal.category || ""))) {
            console.warn(`qty-gate: "${matchedDeal.name}" qty ${qty} exceeds gate, clamped to 1`);
            qty = 1;
          }
          if (!isPerLb && sale * qty > 20 && !_PRODUCE_CATEGORY_RE.test(String(matchedDeal.category || ""))) {
            console.warn(`qty-gate: "${matchedDeal.name}" cost $${(sale * qty).toFixed(2)} exceeds $20 gate, clamped to 1 package`);
            qty = 1;
          }
          const itemSaleCost_raw = sale * qty;
          const itemRegCost_raw = reg * qty;
          const itemSaleCost = isStaple ? 0 : itemSaleCost_raw;
          const itemRegCost = isStaple ? 0 : itemRegCost_raw;
          const savings = itemRegCost > itemSaleCost && itemSaleCost > 0 ? itemRegCost - itemSaleCost : 0;
          itemActualCost = isStaple ? "0.00" : itemSaleCost.toFixed(2);
          if (isStaple) stapleExcludedCount++;

          usedSaleItems.push({
            name: matchedDeal.name,
            category: matchedDeal.category || "",
            salePrice: isPerLb ? `$${sale.toFixed(2)}/lb` : (matchedDeal.salePrice || ""),
            regularPrice: isPerLb ? `$${reg.toFixed(2)}/lb` : (matchedDeal.regularPrice || "—"),
            actualCost: itemActualCost,
            packageNote: isPerLb
              ? `~${qty} lb pkg ≈ $${itemSaleCost.toFixed(2)}`
              : (["tbsp","tsp","cup","oz","fl_oz","ml","g"].includes(_normalizeUnit(ing && ing.unit)) && !isStaple
                  ? "full package — you'll use the rest"
                  : ""),
            savings: savings > 0 ? savings.toFixed(2) : "",
            storeName: matchedDeal.storeName || "",
            isPerLb,
            qty,
            isPantryStaple: isStaple,
          });

          saleCost += itemSaleCost;
          regularCost += itemRegCost > 0 ? itemRegCost : itemSaleCost;
          totalSavings += savings;
        }

        if (type === "ADDITIONAL") {
          additionalCost += 2.50;
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
            storeName: matchedDeal.storeName || "",
            upc: matchedDeal.upc || "",
          } : null,
        };
      });

      const estimatedCost = saleCost + additionalCost;
      const regularPriceTotal = regularCost + additionalCost;

      // Observability: per-recipe qty source counts and AI-vs-server cost mismatch.
      // The AI's costPerServing is still discarded for display; this is monitoring only.
      console.log(`Recipe "${r.title}": qty source ai=${aiQtyCount} fallback=${fbQtyCount}`);
      if (stapleExcludedCount > 0) {
        console.log(`Recipe "${r.title}": pantry staples excluded from cost: ${stapleExcludedCount}`);
      }
      const aiClaimed = parseFloat(r.costPerServing);
      const servings = r.servings || 4;
      if (Number.isFinite(aiClaimed) && aiClaimed > 0 && servings > 0 && estimatedCost > 0) {
        const serverPerServing = estimatedCost / servings;
        const delta = Math.abs(serverPerServing - aiClaimed) / aiClaimed;
        if (delta > 0.4) {
          const deltaPercent = Math.round(delta * 100);
          console.warn(`Recipe "${r.title}": cost-calc mismatch, server=$${serverPerServing.toFixed(2)}/serving, AI claimed $${aiClaimed.toFixed(2)}/serving (delta ${deltaPercent}%)`);
        }
      }

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

    // Post-filter: remove inappropriate recipes for the meal type
    const BREAKFAST_BLACKLIST = ["brownie","cake","cookie","candy","marshmallow","fudge","pie","cupcake","ice cream","sundae","cheesecake","tart","truffle","s'more","frosting","pudding"];
    const DINNER_BLACKLIST = ["smoothie","cereal","granola","overnight oats","parfait"];
    const beforeFilter = recipes.length;
    if (effectiveMealType === "Breakfast") {
      recipes = recipes.filter(r => !BREAKFAST_BLACKLIST.some(w => r.title.toLowerCase().includes(w)));
    } else if (effectiveMealType === "Lunch" || effectiveMealType === "Dinner") {
      recipes = recipes.filter(r => !BREAKFAST_BLACKLIST.some(w => r.title.toLowerCase().includes(w)));
    }
    if (beforeFilter !== recipes.length) console.log(`Meal type filter: removed ${beforeFilter - recipes.length} inappropriate recipes for ${effectiveMealType}`);

    // Savings-first sort with a modest dinner-anchor blend, mirroring the
    // deal-ranking philosophy in app.js: fresh protein and produce get a
    // dollar-scale head start so the #1 card is a meal, not whatever
    // processed item discounted deepest this week.
    const FRESH_PROTEIN_RE = /chicken|beef|pork(?!.*(hot dog|frank))|steak|salmon|tilapia|cod|shrimp|scallop|turkey breast|roast|chop|tenderloin|ground (beef|turkey|pork)/i;
    const PROCESSED_RE = /hot dog|frank|bologna|spam|corn dog|lunchable/i;
    const PRODUCE_RE = /produce|fruit|vegetable/i;
    const recipeAnchorScore = (r) => {
      const names = (r.usedSaleItems || []).map(i => i.name || "").join(" | ");
      const cats = (r.usedSaleItems || []).map(i => i.category || "").join(" | ");
      let boost = 0;
      if (FRESH_PROTEIN_RE.test(names)) boost += 5;
      if (PRODUCE_RE.test(cats)) boost += 2;
      if (PROCESSED_RE.test(names) && !FRESH_PROTEIN_RE.test(names)) boost -= 4;
      return (r.totalSavings || 0) + boost;
    };
    recipes.sort((a, b) => recipeAnchorScore(b) - recipeAnchorScore(a));

    aiRecipeCache.set(cacheKey, { recipes, timestamp: Date.now() });
    for (const [key, val] of aiRecipeCache.entries()) {
      if (Date.now() - val.timestamp > 1800000) aiRecipeCache.delete(key);
    }

    const cost = (inputTokens * 1 + outputTokens * 5) / 1000000;
    const _tPostProcess = Date.now();
    console.log(`[recipes/ai] parse_match_ms=${_tPostProcess - _tClaudeDone} recipes=${recipes.length} cost=$${cost.toFixed(4)}`);
    logApiUsage("anthropic", "recipes-ai", inputTokens, outputTokens, cost);

    // Deal hunter score
    const usedDealNames = new Set();
    recipes.forEach(r => (r.usedSaleItems || []).forEach(i => usedDealNames.add(i.name)));
    const totalIngredients = (req.body.ingredients || []).length;
    const dealHunterScore = totalIngredients > 0 ? { used: usedDealNames.size, total: totalIngredients, percent: Math.round((usedDealNames.size / totalIngredients) * 100) } : null;

    // Savings summary (see computeSavingsSummary above)
    const savingsSummary = computeSavingsSummary(recipes);

    console.log(`[recipes/ai] TOTAL_ms=${Date.now() - _t0} breakdown: prompt=${_tPromptBuilt - _t0}ms claude=${_tClaudeDone - _tClaude}ms parse=${_tPostProcess - _tClaudeDone}ms post=${Date.now() - _tPostProcess}ms`);

    // Track gamification stats + update savings tracker
    const user = req._user;
    if (user) {
      const totalSavings = recipes.reduce((s, r) => s + (r.totalSavings || 0), 0);
      const badgeResult = await trackStat(user.id, "recipe_generated", {
        count: recipes.length, savings: totalSavings, mealType: req.body.style,
        diets: req.body.diets, dealHunterPercent: dealHunterScore?.percent || 0,
      });
      // Update cumulative savings tracker
      try {
        const { data: profile } = await supabase.from("profiles").select("total_savings, recipes_generated").eq("id", user.id).single();
        if (profile) {
          await supabase.from("profiles").update({
            total_savings: (parseFloat(profile.total_savings) || 0) + savingsSummary.totalSavings,
            recipes_generated: (parseInt(profile.recipes_generated) || 0) + recipes.length,
          }).eq("id", user.id);
        }
      } catch (e) { /* savings tracking failed, continue */ }
      res.json({ recipes, savings: savingsSummary, cached: false, tokens: { input: inputTokens, output: outputTokens, cost: cost.toFixed(4) }, badges: badgeResult, dealHunterScore });
    } else {
      // Track anonymous generation count
      const anonId = req.headers["x-anon-id"] || req.ip;
      const count = (anonRecipeCount.get(anonId) || 0) + 1;
      anonRecipeCount.set(anonId, count);
      res.json({ recipes, savings: savingsSummary, cached: false, tokens: { input: inputTokens, output: outputTokens, cost: cost.toFixed(4) }, dealHunterScore, anonGenerations: count });
    }
  } catch (err) {
    logError("POST /api/recipes/ai", err.message);
    res.status(500).json({ error: "Something went wrong generating recipes. Please try again." });
  }
}

// ══ RECIPE IMAGE (lazy Pexels lookup) ═════════════════════════════════════════

router.get("/api/recipe-image", async (req, res) => {
  const { title } = req.query;
  if (!title) return res.status(400).json({ error: "title required" });
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (!pexelsKey) return res.json({ url: null });
  try {
    const query = title.replace(/[^\w\s]/g, "").trim();
    const pRes = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query + " food")}&per_page=1&orientation=landscape`, {
      headers: { Authorization: pexelsKey },
    });
    if (!pRes.ok) return res.json({ url: null });
    const pData = await pRes.json();
    const photo = pData.photos?.[0];
    res.json({
      url: photo?.src?.medium || photo?.src?.small || null,
      photographer: photo?.photographer || "",
    });
  } catch (e) {
    res.json({ url: null });
  }
});

// ══ RECEIPT SCANNER ═══════════════════════════════════════════════════════════

const receiptDailyCount = new Map();
setInterval(() => { const today = new Date().toISOString().slice(0, 10); for (const k of receiptDailyCount.keys()) { if (!k.endsWith(today)) receiptDailyCount.delete(k); } }, 60 * 60 * 1000);

router.post("/api/scan-receipt", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ success: false, error: "Sign in to scan receipts" });
  const today = new Date().toISOString().slice(0, 10);
  const key = user.id + "-" + today;
  const used = receiptDailyCount.get(key) || 0;
  if (used >= 3) return res.status(429).json({ success: false, error: "3 scans per day limit reached" });
  receiptDailyCount.set(key, used + 1);

  const { image } = req.body;
  if (!image) return res.status(400).json({ success: false, error: "No image provided" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: "API key not configured" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: 800,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: 'Read this grocery receipt. Return ONLY a JSON object: {"store": "store name", "totalSpent": total as number, "itemCount": number of items, "savingsOnReceipt": any savings/discounts shown on receipt as number or 0}. Return ONLY valid JSON.' }
        ]}]
      }),
    });
    const result = await response.json();
    const text = result.content?.[0]?.text?.trim() || "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const receiptData = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    const totalSpent = parseFloat(receiptData.totalSpent) || 0;
    const receiptSavings = parseFloat(receiptData.savingsOnReceipt) || 0;
    const regularPrice = receiptSavings > 0 ? totalSpent + receiptSavings : Math.round(totalSpent * 1.35 * 100) / 100;
    const saved = Math.round((regularPrice - totalSpent) * 100) / 100;

    // Update user's total savings
    try {
      const { data: profile } = await supabase.from("profiles").select("total_savings").eq("id", user.id).single();
      await supabase.from("profiles").update({ total_savings: (parseFloat(profile?.total_savings) || 0) + saved }).eq("id", user.id);
    } catch (e) { /* continue */ }

    res.json({ success: true, totalSpent: totalSpent.toFixed(2), regularPrice: regularPrice.toFixed(2), saved: saved.toFixed(2), itemCount: receiptData.itemCount || 0, store: receiptData.store || "" });
  } catch (e) {
    console.error("Receipt scan error:", e.message);
    res.json({ success: false });
  }
});

// ══ SHARED MEAL PLANS ════════════════════════════════════════════════════════

router.post("/api/plans/share", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Sign in to share plans" });
  const { recipes, savings } = req.body;
  if (!recipes?.length) return res.status(400).json({ error: "No recipes to share" });
  const shareId = randomBytes(6).toString("hex");
  try {
    await supabase.from("shared_plans").insert({
      share_id: shareId, user_id: user.id,
      plan_data: { recipes, savings },
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    res.json({ shareUrl: `https://dishcount.co/plan/${shareId}`, shareId });
  } catch (e) {
    console.error("Share plan error:", e.message);
    res.status(500).json({ error: "Could not share plan" });
  }
});

router.get("/api/plans/:shareId", async (req, res) => {
  try {
    const { data } = await supabase.from("shared_plans").select("plan_data, created_at, expires_at").eq("share_id", req.params.shareId).single();
    if (!data) return res.status(404).json({ error: "Plan not found or expired" });
    if (new Date(data.expires_at) < new Date()) return res.status(410).json({ error: "This plan has expired" });
    res.json(data.plan_data);
  } catch (e) { res.status(404).json({ error: "Plan not found" }); }
});

// ══ PANTRY PHOTO SCAN ═════════════════════════════════════════════════════════

const scanHourlyCount = new Map();
setInterval(() => { const h = Math.floor(Date.now() / 3600000); for (const k of scanHourlyCount.keys()) { if (!k.endsWith(String(h))) scanHourlyCount.delete(k); } }, 60 * 60 * 1000);

router.post("/api/scan-pantry", async (req, res) => {
  const userId = req.headers["x-anon-id"] || req.ip;
  const hour = Math.floor(Date.now() / 3600000);
  const key = userId + "-" + hour;
  const used = scanHourlyCount.get(key) || 0;
  if (used >= 5) return res.status(429).json({ error: "Scan limit reached. Try again in a bit.", items: [] });
  scanHourlyCount.set(key, used + 1);

  const { image } = req.body;
  if (!image) return res.status(400).json({ error: "No image provided", items: [] });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured", items: [] });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            { type: "text", text: 'List every food PRODUCT visible in this photo. Return the product name as you would write it on a grocery list — NOT the ingredients that make up the product. For example: "jar of pasta sauce" NOT "tomatoes, garlic, basil". "Box of cereal" NOT "oats, wheat, sugar". "Bottle of olive oil" NOT "olives". Return ONLY a JSON array of product names, no brands. Example: ["pasta sauce", "olive oil", "rice", "canned tomatoes", "chicken broth"]. Return ONLY the JSON array.' }
          ]
        }]
      }),
    });
    const result = await response.json();
    if (result.error) { console.error("Pantry scan API error:", result.error); return res.json({ items: [] }); }
    const text = result.content?.[0]?.text?.trim() || "[]";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const items = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    console.log(`Pantry scan: found ${items.length} items from ${(image.length / 1024).toFixed(0)}KB image`);
    res.json({ items });
  } catch (e) {
    console.error("Pantry scan error:", e.message, e.stack?.split("\n")[1] || "");
    res.json({ items: [] });
  }
});

// ══ INGREDIENT SUBSTITUTION ═══════════════════════════════════════════════════

const swapHourlyCount = new Map();
setInterval(() => { const h = Math.floor(Date.now() / 3600000); for (const k of swapHourlyCount.keys()) { if (!k.endsWith(String(h))) swapHourlyCount.delete(k); } }, 60 * 60 * 1000);

router.post("/api/recipes/substitute", async (req, res) => {
  const user = await getUser(req);
  const userId = user?.id || req.headers["x-anon-id"] || req.ip;
  const hour = Math.floor(Date.now() / 3600000);
  const key = userId + "-" + hour;
  const used = swapHourlyCount.get(key) || 0;
  if (used >= 10) return res.status(429).json({ error: "Swap limit reached. Try again in a bit." });
  swapHourlyCount.set(key, used + 1);

  const { ingredient, recipeName, dietary, availableDeals } = req.body;
  if (!ingredient || !recipeName) return res.status(400).json({ error: "ingredient and recipeName required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  const dealNames = (availableDeals || []).slice(0, 50).map(d => {
    const parts = [d.name];
    if (d.salePrice) parts.push(`$${d.salePrice}`);
    if (d.storeName) parts.push(`at ${d.storeName}`);
    return parts.join(" ");
  }).join(", ");

  const dietNote = dietary?.length ? `The user has these dietary restrictions: ${dietary.join(", ")}. All substitutions must comply.` : "";

  const prompt = `The user wants to substitute "${ingredient}" in the recipe "${recipeName}". Suggest 3 alternatives. ${dietNote}

Items currently on sale: ${dealNames || "none provided"}

For each substitute, explain how it changes the recipe and adjust cooking instructions if needed. PREFER items that are currently on sale.

Respond with ONLY valid JSON:
[{"substitute": "item name", "reason": "why this works, include price if on sale", "adjustedInstructions": "brief cooking adjustment or 'No changes needed'", "onSale": true}]`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });
    const result = await response.json();
    const text = result.content?.[0]?.text || "[]";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const substitutes = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    res.json({ substitutes });
  } catch (e) {
    console.error("Substitute error:", e.message);
    res.status(500).json({ error: "Could not generate substitutions" });
  }
});

// ══ LEFTOVER RECIPES ═════════════════════════════════════════════════════════

router.post("/api/recipes/leftovers", async (req, res) => {
  const user = await getUser(req);
  if (!user) {
    const anonId = req.headers["x-anon-id"] || req.ip;
    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = anonId + "-" + today;
    const dailyUsed = anonDailyCount.get(dailyKey) || 0;
    if (dailyUsed >= 10) return res.status(429).json({ error: "Daily limit reached.", limitReached: true });
    return anonRecipeLimiter(req, res, () => {
      anonDailyCount.set(dailyKey, dailyUsed + 1);
      handleLeftoverGeneration(req, res);
    });
  }
  handleLeftoverGeneration(req, res);
});

async function handleLeftoverGeneration(req, res) {
  const { leftovers, availableDeals, preferences } = req.body;
  if (!leftovers?.trim()) return res.status(400).json({ error: "leftovers required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  const prefs = preferences || {};
  const dealsList = (availableDeals || []).slice(0, 40).map(d => {
    const parts = [d.name];
    if (d.salePrice) parts.push(`$${d.salePrice}`);
    if (d.storeName) parts.push(`at ${d.storeName}`);
    return "- " + parts.join(" ");
  }).join("\n");

  let profileNote = "";
  if (prefs.skill_level || prefs.cook_time || prefs.dislikes) {
    const parts = [];
    if (prefs.skill_level) parts.push(`Skill: ${prefs.skill_level}`);
    if (prefs.cook_time && prefs.cook_time !== "any") parts.push(`Max cook time: ${prefs.cook_time} min`);
    if (prefs.dislikes) parts.push(`NEVER use: ${prefs.dislikes}`);
    profileNote = "\nUser preferences: " + parts.join(". ") + ".";
  }

  const prompt = `You are a zero-waste recipe assistant. The user has these LEFTOVERS they want to use up:
${leftovers.trim()}

Also available on sale this week:
${dealsList || "No sale items provided."}
${profileNote}

Generate exactly 4 recipes that USE THE LEFTOVERS as the primary ingredients. The goal is ZERO FOOD WASTE. Each recipe should:
- Use at least one leftover item as a main ingredient
- Combine leftovers with sale items where possible to save money
- Be practical and easy to make
- List which leftovers each recipe uses

Respond with ONLY valid JSON:
{
  "recipes": [
    {
      "title": "Recipe Name",
      "cookTime": 20,
      "servings": ${prefs.household_size || "4"},
      "leftoverItems": ["half a rotisserie chicken", "cooked rice"],
      "saleItemsUsed": ["Bell Peppers"],
      "ingredients": [
        {"item": "2 cups shredded rotisserie chicken", "type": "LEFTOVER", "matchName": ""},
        {"item": "1 cup cooked rice", "type": "LEFTOVER", "matchName": ""},
        {"item": "2 bell peppers, diced", "type": "SALE", "matchName": "Bell Peppers"},
        {"item": "1 tbsp soy sauce", "type": "PANTRY", "matchName": ""}
      ],
      "instructions": ["Step 1...", "Step 2..."]
    }
  ]
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
    });
    const result = await response.json();
    const text = result.content?.[0]?.text || "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { recipes: [] };
    res.json({ recipes: parsed.recipes || [], isLeftover: true });
  } catch (e) {
    console.error("Leftover recipe error:", e.message);
    res.status(500).json({ error: "Could not generate leftover recipes" });
  }
}

// ══ RECIPE INTERACTIONS (LEARNING) ═══════════════════════════════════════════

router.post("/api/recipes/interact", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { recipe_name, recipe_tags, action } = req.body;
  if (!recipe_name || !action) return res.status(400).json({ error: "recipe_name and action required" });
  const allowed = ["saved", "cooked", "printed", "added_to_cart", "skipped"];
  if (!allowed.includes(action)) return res.status(400).json({ error: "Invalid action" });

  try {
    await supabase.from("recipe_interactions").insert({
      user_id: user.id,
      recipe_name,
      recipe_tags: recipe_tags || [],
      action,
    });
    res.json({ success: true });
  } catch (e) {
    console.error("Interaction tracking error:", e.message);
    res.status(500).json({ error: "Could not save interaction" });
  }
});

router.get("/api/recipes/history", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.json({ interactions: [] });
  try {
    const { data } = await supabase
      .from("recipe_interactions")
      .select("recipe_name, recipe_tags, action")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20);
    res.json({ interactions: data || [] });
  } catch (e) {
    res.json({ interactions: [] });
  }
});

// ══ RECIPE RATINGS ════════════════════════════════════════════════════════════

router.post("/api/recipes/rate", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Sign in to rate recipes" });
  const { recipe_name, recipe_hash, taste_rating, ease_rating, would_make_again, notes } = req.body;
  if (!recipe_name || !recipe_hash) return res.status(400).json({ error: "recipe_name and recipe_hash required" });
  if (taste_rating && (taste_rating < 1 || taste_rating > 5)) return res.status(400).json({ error: "Ratings must be 1-5" });
  try {
    await supabase.from("recipe_ratings").insert({
      user_id: user.id, recipe_name, recipe_hash,
      taste_rating: taste_rating || null, ease_rating: ease_rating || null,
      would_make_again: would_make_again ?? null, notes: notes || null,
    });
    // Fetch aggregated stats
    const { data: ratings } = await supabase.from("recipe_ratings").select("taste_rating, ease_rating, would_make_again").eq("recipe_hash", recipe_hash);
    const count = ratings?.length || 0;
    const avgTaste = count > 0 ? Math.round(ratings.reduce((s, r) => s + (r.taste_rating || 0), 0) / ratings.filter(r => r.taste_rating).length * 10) / 10 : 0;
    const avgEase = count > 0 ? Math.round(ratings.reduce((s, r) => s + (r.ease_rating || 0), 0) / ratings.filter(r => r.ease_rating).length * 10) / 10 : 0;
    const makeAgainPct = count > 0 ? Math.round(ratings.filter(r => r.would_make_again).length / count * 100) : 0;
    res.json({ success: true, stats: { count, avgTaste, avgEase, makeAgainPct } });
  } catch (e) {
    console.error("Rating error:", e.message);
    res.status(500).json({ error: "Could not save rating" });
  }
});

router.get("/api/recipes/ratings/:hash", async (req, res) => {
  try {
    const { data: ratings } = await supabase.from("recipe_ratings").select("taste_rating, ease_rating, would_make_again").eq("recipe_hash", req.params.hash);
    const count = ratings?.length || 0;
    if (count === 0) return res.json({ count: 0 });
    const avgTaste = Math.round(ratings.reduce((s, r) => s + (r.taste_rating || 0), 0) / ratings.filter(r => r.taste_rating).length * 10) / 10;
    const makeAgainPct = Math.round(ratings.filter(r => r.would_make_again).length / count * 100);
    res.json({ count, avgTaste, makeAgainPct });
  } catch (e) { res.json({ count: 0 }); }
});

// ══ COMMUNITY RECIPE SUBMISSIONS ═════════════════════════════════════════════

router.post("/api/community/recipes", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Sign in to share recipes" });
  const { title, ingredients, instructions, stores_used, cost_per_serving } = req.body;
  if (!title || !ingredients || !instructions) return res.status(400).json({ error: "title, ingredients, and instructions required" });
  try {
    const { data, error } = await supabase.from("community_recipes").insert({
      user_id: user.id, title, ingredients, instructions,
      stores_used: stores_used || [], cost_per_serving: cost_per_serving || null,
    }).select().single();
    if (error) throw error;
    res.json({ success: true, recipe: data });
  } catch (e) {
    console.error("Community recipe error:", e.message);
    res.status(500).json({ error: "Could not save recipe" });
  }
});

export default router;
