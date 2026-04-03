import { Router } from "express";
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

// ── Anonymous recipe generation tracking + rate limiting ────────────────────
const anonRecipeCount = new Map();
const anonDailyCount = new Map();

// Hourly IP-based rate limiter for anonymous users (5/hour, cannot be spoofed)
const anonRecipeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Recipe generation limit reached. Create a free account for unlimited recipes!", limitReached: true },
});

// Clean up stale daily count entries every hour
setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  for (const key of anonDailyCount.keys()) {
    if (!key.endsWith(today)) anonDailyCount.delete(key);
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
  req._user = user;
  handleRecipeGeneration(req, res);
});

async function handleRecipeGeneration(req, res) {
  const { ingredients, style, mealType, diets, wantItems, haveItems, offset } = req.body;
  const effectiveMealType = mealType || "Dinner";
  if (!ingredients?.length) return res.status(400).json({ error: "ingredients required" });
  if (ingredients.length > 50) return res.status(400).json({ error: "Too many ingredients. Maximum 50." });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured. Add it to your .env file." });

  try {
    const cacheKey = JSON.stringify({ items: ingredients.slice(0, 25).map(i => i.name).sort(), style, diets, wantItems: wantItems || "", haveItems: haveItems || "", offset: offset || 0 });
    const cached = aiRecipeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 1800000) {
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
    const batchNote = (offset && offset > 0) ? `\n\nThis is batch #${Math.floor(offset/8)+1}. Generate 8 DIFFERENT recipes from previous batches. Be creative — try different cuisines, cooking methods, and flavor profiles.` : "";

    const prompt = `You are a budget-friendly recipe assistant. A customer is shopping grocery deals and wants recipe ideas based on what's on sale this week.

${mealTypeGuide}
${styleDesc ? "RECIPE STYLE: " + style + "\n" + styleDesc : ""}

HERE ARE THE ITEMS ON SALE THIS WEEK:
${saleItemsList}
${mustIncludeNote}${customNote}${batchNote}

Generate exactly 8 recipes. Each recipe should:
- Use 2-5 of the sale items above as key ingredients
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

    let recipes = (parsed.recipes || []).map((r, idx) => {
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

    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    const cost = (inputTokens * 1 + outputTokens * 5) / 1000000;
    console.log(`AI recipes generated: ${recipes.length} recipes, ${inputTokens}+${outputTokens} tokens, ~$${cost.toFixed(4)}`);
    logApiUsage("anthropic", "recipes-ai", inputTokens, outputTokens, cost);

    // Deal hunter score
    const usedDealNames = new Set();
    recipes.forEach(r => (r.usedSaleItems || []).forEach(i => usedDealNames.add(i.name)));
    const totalIngredients = (req.body.ingredients || []).length;
    const dealHunterScore = totalIngredients > 0 ? { used: usedDealNames.size, total: totalIngredients, percent: Math.round((usedDealNames.size / totalIngredients) * 100) } : null;

    // Track gamification stats
    const user = req._user;
    if (user) {
      const totalSavings = recipes.reduce((s, r) => s + (r.totalSavings || 0), 0);
      const badgeResult = await trackStat(user.id, "recipe_generated", {
        count: recipes.length, savings: totalSavings, mealType: req.body.style,
        diets: req.body.diets, dealHunterPercent: dealHunterScore?.percent || 0,
      });
      res.json({ recipes, cached: false, tokens: { input: inputTokens, output: outputTokens, cost: cost.toFixed(4) }, badges: badgeResult, dealHunterScore });
    } else {
      // Track anonymous generation count
      const anonId = req.headers["x-anon-id"] || req.ip;
      const count = (anonRecipeCount.get(anonId) || 0) + 1;
      anonRecipeCount.set(anonId, count);
      res.json({ recipes, cached: false, tokens: { input: inputTokens, output: outputTokens, cost: cost.toFixed(4) }, dealHunterScore, anonGenerations: count });
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

// ══ POINTS STATUS ═════════════════════════════════════════════════════════════

router.get("/api/points", async (req, res) => {
  await checkAndResetPoints();
  const points = await getDailyPoints();
  res.json({ used: points, limit: DAILY_POINT_LIMIT, remaining: DAILY_POINT_LIMIT - points, resetsAt: "midnight" });
});

export default router;
