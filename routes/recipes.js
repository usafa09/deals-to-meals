import { Router } from "express";
import { randomBytes } from "crypto";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import { trackStat } from "./gamification.js";
import {
  supabase, getUser,
  recipeCache, aiRecipeCache,
  SPOONACULAR_BASE, CACHE_TTL,
  DAILY_POINT_LIMIT, POINTS_PER_SEARCH,
  getDailyPoints, addDailyPoints, checkAndResetPoints,
  getCacheKey, findDeal, logApiUsage, logError, DIET_MAP, MEAL_TYPE_MAP, KID_QUERIES,
} from "../lib/utils.js";

const router = Router();

// ── Recipe generation tracking + rate limiting ─────────────────────────────
const anonRecipeCount = new Map();
const anonDailyCount = new Map();
const authHourlyCount = new Map();
const authDailyCount = new Map();

// Hourly IP-based rate limiter for anonymous users (5/hour, cannot be spoofed)
const anonRecipeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
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

// ══ SPOONACULAR RECIPE SEARCH ═════════════════════════════════════════════════

router.post("/api/recipes/search", async (req, res) => {
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

    await checkAndResetPoints();
    const currentPoints = await getDailyPoints();
    if (currentPoints + POINTS_PER_SEARCH > DAILY_POINT_LIMIT) {
      return res.status(429).json({ error: "Daily recipe search limit reached. Please try again tomorrow." });
    }

    const typeStr = MEAL_TYPE_MAP[mealType] || "main course";
    const dietStr = diets?.length
      ? diets.filter(d => DIET_MAP[d]).map(d => DIET_MAP[d]).join(",")
      : "";

    const skipBrandWords = new Set(["appleton","farms","happy","fremont","fish","simply","nature","carlini","cattlemens","ranch","southern","grove","stonemill","bakers","corner","specially","selected","park","street","deli","casa","mamita","mama","cozzis","millville","brookdale","reggano","savoritz","emporium","friendly","barissimo","choceur","clancys","moser","roth","elevation","health","ade","northern","catch","poppi","bremer","never","any","market","kitchen","aldi"]);
    const cleanIngName = (name) => name.toLowerCase().replace(/[^a-z\s]/g," ").split(" ").filter(w => w.length > 2 && !skipBrandWords.has(w)).slice(0, 5).join(" ");
    const ingredientStr = ingredients.slice(0, 20).map(i => cleanIngName(i.name)).join(",");
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
    if (diets?.includes("Low Calorie")) searchParams.set("maxCalories", "500");

    await addDailyPoints(POINTS_PER_SEARCH);
    const updatedPoints = await getDailyPoints();
    console.log(`Spoonacular points used today: ${updatedPoints}/${DAILY_POINT_LIMIT}`);

    const searchRes = await fetch(`${SPOONACULAR_BASE}/recipes/complexSearch?${searchParams}`);
    if (!searchRes.ok) throw new Error(await searchRes.text());
    const searchData = await searchRes.json();
    const recipes = searchData.results || [];

    const enriched = recipes.map(recipe => {
      const usedSaleItems = [];
      let totalSavings = 0;
      let estimatedCost = 0;
      const allRecipeIngs = [
        ...(recipe.usedIngredients || []),
        ...(recipe.missedIngredients || []),
      ];
      for (const ing of allRecipeIngs) {
        const deal = findDeal(ing.name, ingredients);
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
          ...(recipe.usedIngredients || []).map(i => ({ name: i.name, onSale: !!findDeal(i.name, ingredients) })),
          ...(recipe.missedIngredients || []).filter(i => !findDeal(i.name, ingredients)).map(i => ({ name: i.name, onSale: false })),
        ],
      };
    });

    enriched.sort((a, b) => b.totalSavings - a.totalSavings);

    recipeCache.set(cacheKey, { recipes: enriched, timestamp: Date.now() });
    for (const [key, val] of recipeCache.entries()) {
      if (Date.now() - val.timestamp > CACHE_TTL) recipeCache.delete(key);
    }

    const finalPoints = await getDailyPoints();
    res.json({ recipes: enriched, cached: false, pointsUsedToday: finalPoints, pointsRemaining: DAILY_POINT_LIMIT - finalPoints });
  } catch (err) {
    console.error("Recipe search error:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ══ CLAUDE AI RECIPE GENERATION ══════════════════════════════════════════════

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

async function handleRecipeGeneration(req, res) {
  let { ingredients, style, mealType, diets, wantItems, haveItems, mealRequest, budgetTarget, leftovers, preferences, weeklyPlan, freezerMeals, offset } = req.body;
  const effectiveMealType = mealType || "Dinner";
  if (!ingredients?.length) return res.status(400).json({ error: "ingredients required" });
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
      return res.json({ recipes: cached.recipes, cached: true });
    }

    const mustInclude = ingredients.filter(i => i.mustInclude).map(i => i.name);
    const mustIncludeNote = mustInclude.length
      ? `\n\nUSER-SELECTED ITEMS (MUST USE ALL OF THESE):\n${mustInclude.map(n => "- " + n).join("\n")}\n\nThese items were hand-picked by the user from the sale list. Every recipe MUST include at least one of these items. Prioritize recipes that use multiple user-selected items together. These take HIGHEST PRIORITY over auto-selected sale items.`
      : `\n\nBUDGET MODE: The user did not select specific items. Generate the most BUDGET-FRIENDLY recipes possible using the cheapest sale items available. Prioritize recipes where the total cost per serving is under $3. Focus on items with the highest discount percentage.`;

    const wantNote = wantItems?.trim()
      ? `\n\nADDITIONAL ITEMS TO BUY: The customer also wants to purchase these items (not on sale): ${wantItems.trim()}. Include these in recipes where they fit naturally and mark them as type "ADDITIONAL".`
      : "";
    const haveNote = haveItems?.trim()
      ? `\n\n🏠 HIGHEST PRIORITY — ITEMS THE USER ALREADY HAS AT HOME (FREE):
${haveItems.trim().split(/,\s*/).map(i => "- " + i.trim()).join("\n")}

These items cost the user $0. Use as many of these as possible in EVERY recipe. They are your most valuable ingredients because they save the most money. Build recipes AROUND these items + sale items. Mark them as type "ON_HAND". Do NOT include them in the estimated cost.`
      : "";
    // Build leftovers note
    const leftoversNote = leftovers?.trim()
      ? `\n\n♻️ HIGHEST PRIORITY — LEFTOVERS TO USE UP:
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

    // Build user profile note from preferences
    let profileNote = "";
    if (prefs.household_size || prefs.skill_level || prefs.cook_time || prefs.dietary?.length || prefs.flavor_preferences?.length || prefs.dislikes) {
      const parts = ["USER PROFILE:"];
      if (prefs.household_size) parts.push(`- Cooking for: ${prefs.household_size} people${prefs.has_kids ? " (including kids under 12 — keep recipes kid-friendly)" : ""}`);
      if (prefs.skill_level) parts.push(`- Skill level: ${prefs.skill_level}`);
      if (prefs.cook_time) parts.push(`- Available time: ${prefs.cook_time === "any" ? "no limit" : prefs.cook_time + " minutes"}`);
      if (prefs.dietary?.length && !prefs.dietary.includes("none")) parts.push(`- Dietary needs: ${prefs.dietary.join(", ")}`);
      if (prefs.flavor_preferences?.length && !prefs.flavor_preferences.includes("anything")) parts.push(`- Flavor preferences: ${prefs.flavor_preferences.join(", ")}`);
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
    };

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
    const catLabels = { protein: "🥩 PROTEINS ON SALE", produce: "🥬 PRODUCE ON SALE", dairy: "🧀 DAIRY ON SALE", pantry: "🥫 PANTRY/STAPLES ON SALE", frozen: "🧊 FROZEN ON SALE", other: "🏷️ OTHER ITEMS ON SALE" };
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
${styleDesc ? "RECIPE STYLE: " + style + "\n" + styleDesc : ""}

${haveNote ? haveNote + "\n" : ""}
${saleItemsList}
${leftoversNote}${mustIncludeNote}${wantNote}${mealRequestNote}${budgetNote}${profileNote}${familyNote}${historyNote}${batchNote}

CRITICAL: Each recipe MUST use AT LEAST 4-6 sale items as core ingredients. Use items from MULTIPLE categories above (e.g. a protein + vegetables + dairy + a pantry item).${haveNote ? " ALSO use as many ON HAND items as possible — they are FREE and save the customer the most money." : ""} Only add non-sale items when absolutely necessary (salt, pepper, water, basic oil, spices). The whole point is cooking from what's cheap THIS WEEK.

RECIPE GENERATION RULES:
1. COST OPTIMIZATION: Using the sale prices provided, calculate the approximate cost per serving for each recipe. Sort recipes from cheapest to most expensive. Include "costPerServing" (a number in dollars, e.g. 2.50) in each recipe object.
2. INGREDIENT SHARING: Design recipes that share ingredients with each other. If chicken thighs are on sale, use them in 2-3 different recipes with different preparations (stir fry, baked, soup). This minimizes what the user needs to buy.
3. VARIETY: Do not repeat the same protein in more than 2 of 6 recipes. Ensure at least 2 different cooking methods (baking, stovetop, slow cooker, no-cook). Include at least 1 vegetarian option.
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
- At the end of instructions for Friday's recipe, add a note about which ingredients were shared across the week` : "Generate exactly 6 recipes."} Each recipe should:
- Use 4-6+ of the sale items above as key ingredients (NOT just 1-2)
- Combine items from at least 2-3 different sale categories
- Be genuinely budget-friendly (under $12 total for 4 servings)
- Include simple pantry staples the customer likely already has (salt, pepper, oil, butter, flour, sugar, dried spices/herbs, vinegar, soy sauce, etc.)
- Have clear, numbered step-by-step instructions a beginner cook could follow
- Be a REAL recipe that actually works — not made up combinations
- Use sale items appropriately based on what they are:
  * RAW INGREDIENTS (chicken breasts, ground beef, fresh vegetables, cheese, rice, pasta) → use in from-scratch recipes as you normally would
  * PRE-MADE/PROCESSED PRODUCTS (chicken nuggets, fish sticks, frozen pizza, hot pockets, breaded shrimp, frozen burritos, mac & cheese boxes) → you have TWO options:
    Option A: Use the product as-is in a creative assembled dish (e.g. chicken nuggets → chicken nugget parmesan, fish sticks → fish stick tacos)
    Option B: IGNORE the processed product entirely and use the BASE raw ingredient instead (e.g. if "chicken nuggets" is on sale, make a recipe using "chicken breast" and note it as PANTRY, NOT as a SALE item)
  * NEVER create a "homemade" version of a processed product that uses that same processed product as an ingredient. "Homemade chicken nuggets" must use raw chicken breast, flour, and breadcrumbs — NOT pre-made chicken nuggets. "Homemade fish sticks" must use fresh fish fillets — NOT frozen fish sticks.
  * NEVER use a processed product as a substitute for a raw ingredient (e.g. do NOT use breaded frozen shrimp in a butter garlic shrimp skillet, do NOT use chicken nuggets in a chicken stir-fry)
${dietNote}

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
- Do NOT include "estimatedCost" — we calculate that from real prices.
- "reasoning" = 1-2 sentences explaining WHY you chose this recipe — mention specific sale prices, savings percentages, and how the sale items work together. Be specific with numbers.
- "calories", "protein", "carbs", "fat", "fiber" = estimated nutrition per serving (numbers only, no units). These are rough estimates.`;

    const _tPromptBuilt = Date.now();
    console.log(`[recipes/ai] prompt_build_ms=${_tPromptBuilt - _t0} history_ms=${_tPromptBuilt - _tHistory} ingredients=${ingredients.length}`);

    const claudeBody = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
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

    // Ask for 6, serve 5 — guards against Claude undercounting
    const rawRecipes = (parsed.recipes || []).slice(0, 5);
    let recipes = rawRecipes.map((r, idx) => {
      const usedSaleItems = [];
      let totalSavings = 0;
      let saleCost = 0;
      let regularCost = 0;
      let additionalCost = 0;

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
          } : null,
        };
      });

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

    recipes.sort((a, b) => b.totalSavings - a.totalSavings);

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

    // Calculate savings summary across all recipes
    let totalSalePrice = 0, totalRegularPrice = 0, totalServings = 0;
    recipes.forEach(r => {
      totalServings += (r.servings || 4);
      (r.usedSaleItems || []).forEach(item => {
        const sale = parseFloat(String(item.salePrice || item.actualCost || "0").replace(/[^0-9.]/g, "")) || 0;
        const reg = parseFloat(String(item.regularPrice || "0").replace(/[^0-9.]/g, "")) || 0;
        totalSalePrice += sale;
        totalRegularPrice += reg > sale ? reg : sale;
      });
    });
    const savingsSummary = {
      totalSalePrice: Math.round(totalSalePrice * 100) / 100,
      totalRegularPrice: Math.round(totalRegularPrice * 100) / 100,
      totalSavings: Math.round((totalRegularPrice - totalSalePrice) * 100) / 100,
      savingsPercent: totalRegularPrice > 0 ? Math.round(((totalRegularPrice - totalSalePrice) / totalRegularPrice) * 100) : 0,
      costPerServing: totalServings > 0 ? Math.round((totalSalePrice / totalServings) * 100) / 100 : 0,
      servings: totalServings,
    };

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

// ══ POINTS STATUS ═════════════════════════════════════════════════════════════

router.get("/api/points", async (req, res) => {
  await checkAndResetPoints();
  const points = await getDailyPoints();
  res.json({ used: points, limit: DAILY_POINT_LIMIT, remaining: DAILY_POINT_LIMIT - points, resetsAt: "midnight" });
});

export default router;
