function escapeHtml(str) {
  if (str == null) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

function parseFraction(str) {
  if (!str) return 0;
  const parts = str.split("/");
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    return den !== 0 ? num / den : 0;
  }
  return parseFloat(str) || 0;
}

const SUPABASE_URL = "https://bvwwtrwxnuncalgtuqvx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ2d3d0cnd4bnVuY2FsZ3R1cXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNzMwODAsImV4cCI6MjA4NzY0OTA4MH0.EYBbEBMsRuGngDJ-pM_CSE7tGgD1GoEduTDwLFarDJw";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
    flowType: "implicit",
    storage: window.localStorage,
    storageKey: "dtm-auth-token",
  }
});

function updateAuthUI(session) {
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  if (!session?.user) {
    setText("profileBtnText", "Sign In");
    setText("landingSigninBtn", "Sign In");
    const btn = document.getElementById("profileBtn"); if (btn) btn.classList.remove("logged-in");
    return;
  }
  const user = session.user;
  sb.from("profiles").select("full_name").eq("id", user.id).single().then(({ data: profile }) => {
    const name = profile?.full_name || user.email?.split("@")[0] || "Profile";
    const firstName = name.split(" ")[0];
    setText("profileBtnText", firstName);
    setText("landingSigninBtn", firstName);
    const btn = document.getElementById("profileBtn"); if (btn) btn.classList.add("logged-in");
  });
}

// Listen for auth state changes (handles OAuth redirects, sign-in, sign-out)
sb.auth.onAuthStateChange((event, session) => {
  console.log("auth state change:", event, !!session);
  updateAuthUI(session);
  // Restore app state after sign-in redirect
  if (session && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")) {
    const pending = restorePendingState();
    if (pending) {
      console.log("Restoring pending state:", pending.pendingAction);
      state.zip = pending.zip || state.zip;
      state.distance = pending.distance || state.distance;
      state.selectedBrands = pending.selectedBrands || state.selectedBrands;
      state.selectedKrogerId = pending.selectedKrogerId || state.selectedKrogerId;
      state.deals = pending.deals || state.deals;
      state.dealStates = pending.dealStates || state.dealStates;
      state.selectedMealType = pending.selectedMealType || state.selectedMealType;
      state.selectedStyle = pending.selectedStyle || state.selectedStyle;
      state.selectedDiets = pending.selectedDiets || state.selectedDiets;
      state.recipes = pending.recipes || state.recipes;
      if (pending.recipes?.length) {
        const idx = pending.currentRecipeIndex >= 0 ? pending.currentRecipeIndex : 0;
        state.currentRecipe = state.recipes[idx] || state.recipes[0];
        goTo(6);
        renderRecipeGrid();
        if (pending.pendingAction === "save_recipe" && state.currentRecipe) {
          setTimeout(() => { openModal(idx); setTimeout(saveRecipe, 500); }, 300);
        } else if (pending.pendingAction === "add_to_cart") {
          setTimeout(() => showToast("Signed in! You can now add items to your Kroger cart.", "success"), 300);
        }
      }
    }
  }
});

// Also check on page load
sb.auth.getSession().then(({ data }) => updateAuthUI(data?.session));

// ── Recipe Preview Modal (landing page) ─────────────────────────────────────
const PREVIEW_RECIPES = [
  {
    title: "Honey Garlic Chicken Thighs", emoji: "\u{1F357}", time: "35 min", servings: 4, saleCount: 3,
    ingredients: [
      { name: "2 lbs chicken thighs", tag: "SALE" },
      { name: "3 tbsp honey", tag: "SALE" },
      { name: "3 tbsp soy sauce", tag: "SALE" },
      { name: "4 cloves garlic, minced", tag: "PANTRY" },
      { name: "1 tbsp olive oil", tag: "PANTRY" },
      { name: "2 cups jasmine rice", tag: "PANTRY" },
      { name: "1 lb broccoli florets", tag: "ADDITIONAL" },
    ],
    steps: [
      "Cook rice according to package directions.",
      "Whisk together honey, soy sauce, and minced garlic in a small bowl.",
      "Heat olive oil in a large skillet over medium-high heat. Sear chicken thighs 5 minutes per side until golden brown.",
      "Pour honey garlic sauce over chicken, reduce heat to medium-low, cover and cook 10 minutes until chicken reaches 165\u00b0F. Serve over rice with steamed broccoli.",
    ],
  },
  {
    title: "One-Pot Pasta Primavera", emoji: "\u{1F35D}", time: "25 min", servings: 6, saleCount: 5,
    ingredients: [
      { name: "1 lb penne pasta", tag: "SALE" },
      { name: "2 bell peppers, sliced", tag: "SALE" },
      { name: "2 zucchini, diced", tag: "SALE" },
      { name: "1 pint cherry tomatoes, halved", tag: "SALE" },
      { name: "2 tbsp olive oil", tag: "PANTRY" },
      { name: "\u00bd cup grated parmesan", tag: "SALE" },
      { name: "3 cloves garlic, minced", tag: "PANTRY" },
      { name: "Salt, pepper, Italian seasoning", tag: "PANTRY" },
    ],
    steps: [
      "Heat olive oil in a large pot over medium heat. Saut\u00e9 garlic, bell peppers, and zucchini for 3 minutes.",
      "Add 4 cups water, bring to a boil, then add pasta. Cook 10 minutes, stirring occasionally, until pasta is tender and liquid is mostly absorbed.",
      "Toss in cherry tomatoes and Italian seasoning, cook 2 more minutes.",
      "Remove from heat, stir in parmesan, season with salt and pepper, and serve.",
    ],
  },
  {
    title: "Sheet Pan Sausage & Veggies", emoji: "\u{1F957}", time: "40 min", servings: 4, saleCount: 4,
    ingredients: [
      { name: "1 lb Italian sausage links, sliced", tag: "SALE" },
      { name: "1 lb baby potatoes, quartered", tag: "SALE" },
      { name: "2 bell peppers, chunked", tag: "SALE" },
      { name: "1 large onion, chunked", tag: "SALE" },
      { name: "2 tbsp olive oil", tag: "PANTRY" },
      { name: "1 tsp Italian seasoning", tag: "PANTRY" },
      { name: "Salt and pepper to taste", tag: "PANTRY" },
    ],
    steps: [
      "Preheat oven to 425\u00b0F. Line a large sheet pan with parchment paper.",
      "Toss sausage, potatoes, bell peppers, and onion with olive oil, Italian seasoning, salt, and pepper.",
      "Spread everything in a single layer on the sheet pan.",
      "Roast 30\u201335 minutes, tossing halfway, until sausage is cooked through and veggies are golden and tender.",
    ],
  },
];

function showPreviewRecipe(idx) {
  const r = PREVIEW_RECIPES[idx];
  if (!r) return;
  const overlay = document.getElementById("previewModalOverlay");
  const modal = document.getElementById("previewModal");
  const tagColors = { SALE: { bg: "var(--green-light)", color: "var(--green-dark)", icon: "\u{1F3F7}\uFE0F" }, ADDITIONAL: { bg: "#FFF8E8", color: "#8B6914", icon: "\u{1F6D2}" }, PANTRY: { bg: "#F5F0E8", color: "#5A4A30", icon: "\u{1FAD9}" } };
  modal.innerHTML = `<div class="modal-img-placeholder">${r.emoji}</div>
    <div class="modal-body">
      <div class="modal-header"><div class="modal-title">${escapeHtml(r.title)}</div><button class="modal-close" onclick="document.getElementById('previewModalOverlay').classList.remove('show')">\u2715</button></div>
      <div class="modal-stats">
        <span class="stat-pill stat-time">\u23F1 ${escapeHtml(r.time)}</span>
        <span class="stat-pill stat-servings">\u{1F37D}\uFE0F ${r.servings} servings</span>
        <span class="stat-pill stat-cost">\u{1F3F7}\uFE0F ${r.saleCount} sale items used</span>
      </div>
      <div class="modal-section"><div class="modal-section-title">\u{1F955} Ingredients</div>
        <div class="ing-list">${r.ingredients.map(ing => {
          const t = tagColors[ing.tag] || tagColors.PANTRY;
          return `<div class="ing-row" style="background:${t.bg}"><span>${t.icon} ${escapeHtml(ing.name)}</span><span style="font-size:10px;font-weight:700;color:${t.color}">${ing.tag}</span></div>`;
        }).join("")}</div>
      </div>
      <div class="modal-section"><div class="modal-section-title">\u{1F4CB} Instructions</div>
        <div class="steps-list">${r.steps.map((s, i) => `<div class="step-row"><div class="step-num">${i + 1}</div><div class="step-text">${escapeHtml(s)}</div></div>`).join("")}</div>
      </div>
      <div style="text-align:center;padding-top:16px;border-top:2px solid #F5EFE0">
        <button onclick="document.getElementById('zipInput').focus();window.scrollTo({top:0,behavior:'smooth'});document.getElementById('previewModalOverlay').classList.remove('show')" class="btn btn-primary" style="max-width:320px">Find deals near me \u2192</button>
      </div>
    </div>`;
  overlay.classList.add("show");
}

// ── Email Capture ───────────────────────────────────────────────────────────
async function handleSubscribe(e) {
  e.preventDefault();
  const email = document.getElementById("subscribeEmail").value.trim();
  const zip = document.getElementById("subscribeZip").value.trim();
  if (!email || !zip || !/^\d{5}$/.test(zip)) { showToast("Please enter a valid email and 5-digit zip code"); return false; }
  const btn = document.getElementById("subscribeBtn");
  btn.disabled = true; btn.textContent = "Subscribing...";
  try {
    const res = await fetch("/api/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, zip }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    document.getElementById("emailCaptureForm").style.display = "none";
    document.getElementById("subscribeSuccess").style.display = "block";
  } catch (err) { showToast(err.message); btn.disabled = false; btn.textContent = "Subscribe"; }
  return false;
}

// Handle Kroger OAuth return — restore state and show success
// ── Founding Member Banner ───────────────────────────────────────────────────
(async function loadFoundingBanner() {
  try {
    const { data } = await sb.auth.getSession();
    if (data?.session) return; // signed in, don't show
    const res = await fetch("/api/founding-spots");
    if (!res.ok) return;
    const d = await res.json();
    const banner = document.getElementById("foundingBanner");
    const text = document.getElementById("foundingText");
    if (!banner || !text) return;
    if (d.remaining > 0) {
      text.innerHTML = `\u{1F31F} ${d.remaining}/${d.total} Founding Member spots remaining \u2014 <a href="/profile.html">Sign up to claim yours!</a>`;
    } else {
      text.textContent = "\u{1F31F} All 250 Founding Member badges have been claimed!";
    }
    banner.style.display = "";
  } catch {}
})();

(function handleKrogerReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("kroger") === "success") {
    showToast("Kroger account connected!", "success");
    window.history.replaceState({}, "", "/");
    // Restore saved state and jump back to deals
    try {
      const saved = JSON.parse(localStorage.getItem("dishcount-restore-state"));
      if (saved?.zip) {
        state.zip = saved.zip;
        state.selectedBrands = saved.selectedBrands || [];
        state.selectedKrogerId = saved.selectedKrogerId || null;
        state.krogerConnected = true;
        document.getElementById("zipInput").value = saved.zip;
        // Auto-reload deals
        setTimeout(() => loadDealsAndShow(), 500);
      }
      localStorage.removeItem("dishcount-restore-state");
    } catch(e) {}
  } else if (params.get("kroger") === "error") {
    showToast("Kroger connection failed. Please try again.");
    window.history.replaceState({}, "", "/");
  }
})();

const MEAL_TYPES = [
  { id:"Breakfast", icon:"🍳", label:"Breakfast" },
  { id:"Lunch", icon:"🥪", label:"Lunch" },
  { id:"Dinner", icon:"🍽️", label:"Dinner" },
  { id:"Snack", icon:"🍿", label:"Snack" },
  { id:"Dessert", icon:"🍰", label:"Dessert" },
  { id:"Appetizer", icon:"🥗", label:"Appetizer" },
];
const RECIPE_STYLES = [
  { id:"Quick Weeknight", icon:"🏃", label:"Quick Weeknight", sub:"30 min or less" },
  { id:"Family-Friendly", icon:"👨‍👩‍👧‍👦", label:"Family-Friendly", sub:"Kids will eat it" },
  { id:"Comfort Food", icon:"🍲", label:"Comfort Food", sub:"Casseroles, soups, one-pot" },
  { id:"Meal Prep", icon:"📦", label:"Meal Prep", sub:"Great leftovers" },
  { id:"Healthy & Light", icon:"🥗", label:"Healthy & Light", sub:"Under 500 cal/serving" },
  { id:"Slow Cooker", icon:"🫕", label:"Slow Cooker", sub:"Set it and forget it" },
];
const DIET_FILTERS = ["Vegetarian","Gluten-Free","Dairy-Free","Low Calorie"];

let state = {
  zip:"", distance:15, storeBrands:[], selectedBrands:[], krogerLocations:[], selectedKrogerId:null,
  deals:[], dealStates:{}, coupons:[], boostDeals:[], saleStoreFilter:"all", saleCategoryFilter:"all",
  selectedMealType:"Dinner", selectedStyle:null, selectedDiets:[], recipeOffset:0, recipes:[], currentRecipe:null, savedRecipeIds:new Set(), shoppingList:[],
};

function goTo(step) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(`screen${step}`).classList.add("active");
  // Toggle landing nav vs app header
  const landingNav = document.getElementById("landingNav");
  const appHeader = document.getElementById("appHeader");
  if (step === 1) {
    if (landingNav) landingNav.style.display = "";
    if (appHeader) appHeader.style.display = "none";
  } else {
    if (landingNav) landingNav.style.display = "none";
    if (appHeader) appHeader.style.display = "flex";
  }
  renderProgress(step);
  window.scrollTo({ top:0, behavior:"smooth" });
  if (step === 5) { renderMealTypes(); renderStyleGrid(); renderFilterGrid(); }
}
function renderProgress(step) {
  document.getElementById("progressBar").innerHTML = Array.from({length:6},(_,i) => {
    const a = i < step;
    return `<div class="pip" style="width:${a?20:8}px;background:${a?"var(--green-mid)":"#D5D5D5"}"></div>`;
  }).join("");
}
function resetApp() {
  state = { zip:"", distance:15, storeBrands:[], selectedBrands:[], krogerLocations:[], selectedKrogerId:null, deals:[], dealStates:{}, coupons:[], boostDeals:[], saleStoreFilter:"all", saleCategoryFilter:"all", selectedMealType:"Dinner", selectedStyle:null, selectedDiets:[], recipeOffset:0, recipes:[], currentRecipe:null, savedRecipeIds:new Set(), shoppingList:[] };
  document.getElementById("zipInput").value = "";
  document.getElementById("zipBtn").disabled = true;
}
let cookingInterval = null;
let tipInterval = null;
const COOKING_TIPS = [
  // Money-saving (25)
  "Buying whole chickens and breaking them down yourself saves 40\u201360% vs pre-cut pieces.",
  "Frozen vegetables are just as nutritious as fresh \u2014 and way cheaper.",
  "Store-brand spices are identical to name-brand. Save up to 70%.",
  "Buy cheese in blocks and shred it yourself \u2014 pre-shredded costs 30% more.",
  "Dried beans cost about $0.15 per serving vs $0.75 for canned.",
  "Buy produce in season and freeze the extras. You\u2019ll eat better for less all year.",
  "Batch cooking on Sunday saves money AND time during the week.",
  "Whole grains like rice, oats, and lentils are the cheapest healthy foods on earth.",
  "Buying a whole pork loin and slicing your own chops saves about 50%.",
  "Eggs are one of the cheapest complete proteins \u2014 about $0.25 each.",
  "A slow cooker turns cheap cuts of meat into tender, flavorful meals.",
  "Making your own salad dressing costs pennies compared to bottled.",
  "Buy marked-down bread and freeze it \u2014 it thaws perfectly for toast and sandwiches.",
  "Homemade stock from veggie scraps and bones is free and tastes better than store-bought.",
  "Canned tomatoes are often better than fresh for cooking \u2014 and cheaper year-round.",
  "A $2 bag of dried chickpeas makes about 6 cans worth of chickpeas.",
  "Buying in bulk and dividing into portions can cut your meat costs by 30%.",
  "Generic canned goods are usually the exact same product as name brands.",
  "Plan your meals around what\u2019s on sale this week \u2014 that\u2019s what Dishcount is for!",
  "Leftover rice makes the best fried rice \u2014 fresh rice is too moist.",
  "A sharp knife is safer than a dull one. It requires less force, so it\u2019s less likely to slip.",
  "Freeze overripe bananas for smoothies or banana bread later.",
  "Buy large containers of yogurt instead of individual cups \u2014 save up to 40%.",
  "Roasting a whole chicken on Sunday gives you meals for days: dinner, sandwiches, soup.",
  "Making pizza at home costs about $3 vs $15\u201320 for delivery.",
  // Cooking techniques (22)
  "Let meat rest 5\u201310 minutes after cooking. The juices redistribute and it stays moist.",
  "Salt your pasta water until it tastes like the sea. It\u2019s the only chance to season the pasta itself.",
  "Pat meat dry with paper towels before searing. Moisture prevents browning.",
  "Add a splash of pasta water to your sauce \u2014 the starch helps it cling to the noodles.",
  "Don\u2019t overcrowd the pan. Cook in batches for better browning.",
  "Preheat your pan before adding oil. Hot pan + cold oil = food won\u2019t stick.",
  "Taste as you go. The best cooks adjust seasoning throughout the process.",
  "A pinch of sugar can balance acidic tomato sauces without making them sweet.",
  "Rest your dough. Whether it\u2019s bread, pizza, or cookies, resting improves texture.",
  "Deglaze your pan with wine, broth, or even water to make an instant sauce.",
  "Use high heat for searing and stir-frying, low heat for sauces and braises.",
  "Toast your spices in a dry pan for 30 seconds to unlock deeper flavor.",
  "Add acid (lemon, vinegar) at the end of cooking to brighten flavors.",
  "Bloom garlic in oil for 30 seconds before adding other ingredients.",
  "Finish pasta in the sauce, not on the plate. It absorbs more flavor.",
  "Season every layer of your dish \u2014 not just at the end.",
  "Use a meat thermometer. It\u2019s the only way to know when meat is perfectly done.",
  "Caramelize onions low and slow for 30+ minutes. There are no shortcuts.",
  "Brine poultry in saltwater for juicier, more flavorful results.",
  "Add a bay leaf to soups, stews, and rice for subtle depth of flavor.",
  "Roast vegetables at 425\u00b0F for crispy edges. Lower temps make them soggy.",
  "Toss salad with dressing right before serving. Dressed too early = wilted greens.",
  // Food storage (16)
  "Store herbs like flowers \u2014 stems in a glass of water in the fridge.",
  "Wrap banana stems in plastic wrap to slow ripening by 3\u20135 days.",
  "Keep tomatoes on the counter, not in the fridge. Cold kills the flavor.",
  "Freeze leftover broth in ice cube trays for easy portioning.",
  "Store ginger root in the freezer \u2014 it grates easier when frozen.",
  "Keep bread in the freezer, not the fridge. The fridge actually dries it out faster.",
  "Store onions and potatoes separately. Together, they make each other spoil faster.",
  "Wrap celery in aluminum foil to keep it crisp for weeks.",
  "Store avocados with onions to slow browning after cutting.",
  "Keep brown sugar soft by adding a marshmallow or bread slice to the bag.",
  "Freeze fresh herbs in olive oil using ice cube trays for instant flavor bombs.",
  "Store mushrooms in a paper bag, not plastic. They need to breathe.",
  "Squeeze excess air out of freezer bags to prevent freezer burn.",
  "Cooked grains freeze beautifully. Make a big batch and freeze portions.",
  "Store nuts in the freezer to prevent them from going rancid.",
  "Ripe fruit going bad? Chop and freeze it for smoothies.",
  // Kitchen hacks (15)
  "Microwave lemons for 15 seconds before juicing \u2014 you\u2019ll get twice the juice.",
  "Use a damp paper towel under your cutting board to stop it from sliding.",
  "Freeze ginger root and grate it frozen \u2014 way easier than fresh.",
  "Put a wooden spoon across a boiling pot to prevent it from boiling over.",
  "Use dental floss to slice soft cheese, cake layers, or cookie dough logs.",
  "Warm plates in the oven at 200\u00b0F before serving. Food stays hot longer.",
  "Peel garlic fast: smash with the flat side of a knife, skin slides right off.",
  "Use a muffin tin to hold taco shells upright while you fill them.",
  "Freeze leftover wine in ice cube trays for cooking later.",
  "Roll citrus on the counter before cutting to release more juice.",
  "Soak stuck-on food with hot water and dish soap for 15 min before scrubbing.",
  "Use a fork to shred cooked chicken in seconds \u2014 two forks, pulling apart.",
  "Sprinkle salt on cutting boards after cutting garlic or onions to remove the smell.",
  "Wet your knife before cutting sticky foods like dates or dried fruit.",
  "Cook bacon in the oven at 400\u00b0F on a sheet pan. No splatter, perfectly even.",
  // Fun facts (10)
  "Honey never spoils. Archaeologists found 3,000-year-old honey that\u2019s still edible.",
  "Apples float because they\u2019re 25% air.",
  "Bananas are berries, but strawberries aren\u2019t \u2014 botanically speaking.",
  "The most expensive spice in the world is saffron \u2014 up to $5,000 per pound.",
  "Cranberries bounce when they\u2019re ripe. That\u2019s actually how farmers test quality.",
  "The average American eats about 23 pounds of pizza per year.",
  "Pound cake got its name because the original recipe used one pound each of butter, sugar, eggs, and flour.",
  "Peanuts aren\u2019t nuts \u2014 they\u2019re legumes that grow underground.",
  "A chef\u2019s hat traditionally has 100 pleats, representing 100 ways to cook an egg.",
  "Nutmeg is toxic in large quantities \u2014 but perfectly safe in the pinch your recipe calls for.",
];
// Shuffle on load, track shown tips
const shuffledTips = [...COOKING_TIPS].sort(() => Math.random() - 0.5);
let tipIdx = 0;
function getNextTip() { const tip = shuffledTips[tipIdx % shuffledTips.length]; tipIdx++; return tip; }

const COOKING_EMOJIS = [
  { emoji: "🍳", text: "Preheating the oven…" },
  { emoji: "🔪", text: "Chopping ingredients…" },
  { emoji: "🧈", text: "Melting the butter…" },
  { emoji: "🥘", text: "Simmering the sauce…" },
  { emoji: "🧂", text: "Adding seasoning…" },
  { emoji: "🍲", text: "Stirring the pot…" },
  { emoji: "👨‍🍳", text: "Taste-testing…" },
  { emoji: "🍽️", text: "Plating the dishes…" },
  { emoji: "✨", text: "Adding the finishing touches…" },
];
let emojiIdx = 0;

function showLoading(text, sub="") {
  document.getElementById("loadingText").textContent = text;
  document.getElementById("loadingSub").textContent = sub;
  const emojiEl = document.getElementById("loadingEmoji");
  if (emojiEl) emojiEl.style.display = "none";
  const spinner = document.getElementById("loadingSpinner");
  if (spinner) spinner.style.display = "";
  document.getElementById("loadingOverlay").classList.add("show");
  startTipRotation();
}
function showCookingLoading() {
  const spinner = document.getElementById("loadingSpinner");
  const emojiEl = document.getElementById("loadingEmoji");
  const textEl = document.getElementById("loadingText");
  const subEl = document.getElementById("loadingSub");
  if (spinner) spinner.style.display = "none";
  if (emojiEl) emojiEl.style.display = "block";
  subEl.textContent = "Our AI chef is crafting your recipes";
  emojiIdx = 0;
  const update = () => {
    const m = COOKING_EMOJIS[emojiIdx % COOKING_EMOJIS.length];
    if (emojiEl) emojiEl.textContent = m.emoji;
    textEl.textContent = m.text;
    emojiIdx++;
  };
  update();
  cookingInterval = setInterval(update, 3000);
  document.getElementById("loadingOverlay").classList.add("show");
  startTipRotation();
}
function startTipRotation() {
  const tipEl = document.getElementById("loadingTip");
  if (!tipEl) return;
  tipEl.style.opacity = "0";
  setTimeout(() => { tipEl.textContent = "💡 " + getNextTip(); tipEl.style.opacity = "1"; }, 200);
  if (tipInterval) clearInterval(tipInterval);
  tipInterval = setInterval(() => {
    tipEl.style.opacity = "0";
    setTimeout(() => { tipEl.textContent = "💡 " + getNextTip(); tipEl.style.opacity = "1"; }, 400);
  }, 4000);
}
function hideLoading() {
  document.getElementById("loadingOverlay").classList.remove("show");
  if (cookingInterval) { clearInterval(cookingInterval); cookingInterval = null; }
  if (tipInterval) { clearInterval(tipInterval); tipInterval = null; }
  const spinner = document.getElementById("loadingSpinner");
  const emojiEl = document.getElementById("loadingEmoji");
  const tipEl = document.getElementById("loadingTip");
  if (spinner) spinner.style.display = "";
  if (emojiEl) emojiEl.style.display = "none";
  if (tipEl) tipEl.textContent = "";
}
function showToast(msg, type="error") { const t=document.getElementById("toast"); t.textContent=msg; t.className=`toast show ${type}`; setTimeout(()=>t.classList.remove("show"),3500); }

// ── Screen 1 ──────────────────────────────────────────────────────────────────
document.getElementById("zipInput").addEventListener("input", function() { this.value=this.value.replace(/\D/g,"").slice(0,5); document.getElementById("zipBtn").disabled=this.value.length<5; });
document.getElementById("zipInput").addEventListener("keydown", e => { if(e.key==="Enter") document.getElementById("zipBtn").click(); });
document.getElementById("zipBtn").addEventListener("click", findStores);

const BANNER_INFO = {
  "kroger":{emoji:"🛒",color:"#003DA5"},"ralphs":{emoji:"🌴",color:"#E31837"},"fred meyer":{emoji:"🏔️",color:"#003DA5"},
  "king soopers":{emoji:"👑",color:"#E31837"},"harris teeter":{emoji:"🌿",color:"#007A33"},"smith's":{emoji:"🏜️",color:"#003DA5"},
  "fry's":{emoji:"☀️",color:"#E31837"},"qfc":{emoji:"🏪",color:"#003DA5"},"dillons":{emoji:"🌾",color:"#003DA5"},
  "mariano":{emoji:"🛒",color:"#003DA5"},"pick n save":{emoji:"🛒",color:"#003DA5"},
  "aldi":{emoji:"🟥",color:"#CC0000"},"walmart":{emoji:"🔵",color:"#0071CE"},
  "publix":{emoji:"🟢",color:"#3B8736"},"target":{emoji:"🎯",color:"#CC0000"},"meijer":{emoji:"🔴",color:"#D11242"},
  "giant eagle":{emoji:"🦅",color:"#003DA5"},"albertsons":{emoji:"🔷",color:"#0071CE"},"safeway":{emoji:"🔴",color:"#E21836"},
  "h-e-b":{emoji:"🌟",color:"#E21836"},"food lion":{emoji:"🦁",color:"#FF6600"},"sprouts":{emoji:"🌱",color:"#5B8C2A"},
  "fresh thyme":{emoji:"🌿",color:"#4A7C2E"},"grocery outlet":{emoji:"💰",color:"#E31837"},"dollar general":{emoji:"💵",color:"#FDB71A"},
  "costco":{emoji:"🏬",color:"#005DAA"},"marc's":{emoji:"🏷️",color:"#E31837"},"wegman":{emoji:"🏪",color:"#003DA5"},
  "lidl":{emoji:"🟡",color:"#0050AA"},"family dollar":{emoji:"💵",color:"#FF6600"},"save a lot":{emoji:"💰",color:"#E31837"},
  "hy-vee":{emoji:"🔴",color:"#E31837"},"hyvee":{emoji:"🔴",color:"#E31837"},"winn-dixie":{emoji:"🏪",color:"#D6001C"},
  "shoprite":{emoji:"🛒",color:"#D4001A"},"piggly wiggly":{emoji:"🐷",color:"#E31837"},"winco":{emoji:"💰",color:"#005A33"},
  "trader joe":{emoji:"🌺",color:"#CC0000"},"acme":{emoji:"🔴",color:"#E21836"},"jewel":{emoji:"💎",color:"#E31837"},
  "shaw":{emoji:"🏪",color:"#E31837"},"tom thumb":{emoji:"🏪",color:"#E31837"},"randall":{emoji:"🏪",color:"#E31837"},
  "vons":{emoji:"🔴",color:"#E21836"},"carrs":{emoji:"🏪",color:"#E21836"},
};
function getBanner(name) { const k=(name||"").toLowerCase(); for(const[b,info]of Object.entries(BANNER_INFO)){if(k.includes(b))return info;} return{emoji:"🏪",color:"#666"}; }

const KROGER_FAMILY_NORM=new Set(["kroger","ralphs","fredmeyer","frys","frysfood","harristeeter","kingsoopers","smiths","qfc","marianos","picksave","metromarket","dillons","bakers","payless","gerbes","jayc","food4less","foodsco","owens","citymarket"]);
function normBrand(n){return(n||"").toLowerCase().replace(/['\s\-]/g,"");}
function isKrogerFamily(name){return KROGER_FAMILY_NORM.has(normBrand(name));}

async function findStores() {
  const zip=document.getElementById("zipInput").value; if(zip.length<5)return;
  state.zip=zip; state.distance=parseInt(document.getElementById("radiusSelect").value)||15;
  showLoading("Finding all stores with deals near you…","Searching grocery stores in your area…");
  try {
    const [krogerRes,aldiRes,nearbyRes] = await Promise.allSettled([
      fetch(`/api/stores?zip=${zip}`).then(r=>r.json()).then(d=>(d.stores||[]).map(s=>({...s,source:"kroger"}))),
      fetch(`/api/aldi/stores?zip=${zip}`).then(r=>r.json()).then(d=>(d.stores||[]).map(s=>({...s,source:"aldi"}))),
      fetch(`/api/nearby-stores?zip=${zip}&radius=${state.distance}`).then(r=>r.json()),
    ]);
    const allStores=[];
    if(krogerRes.status==="fulfilled")allStores.push(...krogerRes.value);
    if(aldiRes.status==="fulfilled")allStores.push(...aldiRes.value);

    // Add nearby stores from Google Places (excluding Kroger/ALDI which are already handled)
    if(nearbyRes.status==="fulfilled" && nearbyRes.value.stores) {
      const nearbyStores = nearbyRes.value.stores
        .filter(s => s.name !== "Kroger" && s.name !== "ALDI")
        .filter(s => s.hasDeals || s.canExtract) // only show stores we can get ads for
        .map(s => ({
          name: s.name,
          address: s.count > 1 ? `${s.count} locations nearby` : (s.address || "Nearby"),
          source: "nearby",
          storeName: s.name,
          hasDeals: s.hasDeals,
        }));
      allStores.push(...nearbyStores);
    }

    const brandMap=new Map();
    for(const s of allStores){
      let brandName;
      if(s.name.toLowerCase().includes("aldi"))brandName="ALDI";
      else brandName=s.name.trim();
      if(!brandMap.has(brandName)){const info=getBanner(brandName);brandMap.set(brandName,{name:brandName,source:s.source,emoji:info.emoji,color:info.color,stores:[],hasDeals:s.hasDeals||s.source==="kroger"||s.source==="aldi",krogerFamily:isKrogerFamily(brandName)||s.krogerFamily||false});}
      const brand=brandMap.get(brandName);
      brand.stores.push(s);
      if(s.hasDeals)brand.hasDeals=true;
    }
    state.storeBrands=[...brandMap.values()].sort((a,b)=>{
      // Sort: stores with deals first, then alphabetical
      if(a.hasDeals && !b.hasDeals) return -1;
      if(!a.hasDeals && b.hasDeals) return 1;
      return a.name.localeCompare(b.name);
    });
    if(!state.storeBrands.length)throw new Error("No stores found near that zip code.");
    renderStoreBrands(); goTo(2);
  } catch(err){showToast(err.message);} finally{hideLoading();}
}

// ── Screen 2: Store Brands ────────────────────────────────────────────────────
function renderStoreBrands() {
  document.getElementById("storesTitle").textContent=`Stores near ${state.zip}`;
  document.getElementById("storesList").innerHTML=state.storeBrands.map(b=>`
    <div class="card clickable" id="brand-${b.name.replace(/[^a-zA-Z0-9]/g,'_')}" onclick="toggleBrand('${escapeHtml(b.name).replace(/'/g,"\\'")}')">
      <div class="store-row">
        <div style="width:44px;height:44px;border-radius:12px;background:${escapeHtml(b.color)};display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">${escapeHtml(b.emoji)}</div>
        <div style="flex:1"><div class="store-name">${escapeHtml(b.name)}</div><div class="store-addr" id="addr-${b.name.replace(/[^a-zA-Z0-9]/g,'_')}">${b.hasDeals?(b.stores.length>1?b.stores.length+" locations nearby":escapeHtml(b.stores[0]?.address)||"Deals available"):"<span style='color:var(--orange);font-size:11px;cursor:pointer'>⚡ Tap to find deals</span>"}</div></div>
        <div class="store-check">✓</div>
      </div>
    </div>`).join("");
}
async function toggleBrand(name) {
  const brand=state.storeBrands.find(b=>b.name===name);
  const elId=`brand-${name.replace(/[^a-zA-Z0-9]/g,'_')}`;
  const addrId=`addr-${name.replace(/[^a-zA-Z0-9]/g,'_')}`;

  // If store has no deals, trigger on-demand extraction
  if(brand && !brand.hasDeals) {
    const addrEl=document.getElementById(addrId);
    if(addrEl)addrEl.innerHTML=`<span style="color:var(--orange);font-size:11px">🔍 Searching for deals...</span>`;

    try {
      const res=await fetch("/api/extract-store",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({storeName:name})});
      const data=await res.json();

      if(data.status==="ready") {
        brand.hasDeals=true;
        if(addrEl)addrEl.innerHTML=`<span style="color:var(--green-dark);font-size:11px">✅ ${data.deals} deals found! Tap again to select</span>`;
      } else if(data.status==="extracting") {
        if(addrEl)addrEl.innerHTML=`<div style="display:flex;align-items:center;gap:8px;padding:8px 0">
          <span class="extract-spinner"></span>
          <div><div style="color:var(--orange);font-size:13px;font-weight:700">Extracting deals from weekly ad...</div>
          <div style="color:var(--muted);font-size:11px">This usually takes 1-2 minutes</div></div></div>`;
        // Poll for completion
        const poll=setInterval(async()=>{
          try {
            const s=await fetch(`/api/extract-status?store=${encodeURIComponent(name)}`).then(r=>r.json());
            if(s.status==="ready"){
              clearInterval(poll);
              brand.hasDeals=true;
              const el=document.getElementById(addrId);
              if(el)el.innerHTML=`<span style="color:var(--green-dark);font-size:11px">✅ ${s.deals} deals found! Tap to select</span>`;
            }
          } catch{}
        },10000); // check every 10 seconds
        // Stop polling after 5 minutes
        setTimeout(()=>{clearInterval(poll);const el=document.getElementById(addrId);if(el&&!brand.hasDeals)el.innerHTML=`<span style="color:var(--muted);font-size:11px">Extraction timed out — try again</span>`;},300000);
      } else if(data.status==="not-found") {
        if(addrEl)addrEl.innerHTML=`<span style="color:var(--muted);font-size:11px">No weekly ad found</span>`;
      }
    } catch(e) {
      const addrEl2=document.getElementById(addrId);
      if(addrEl2)addrEl2.innerHTML=`<span style="color:var(--muted);font-size:11px">Could not find deals</span>`;
    }
    return; // don't toggle selection yet — wait for deals
  }

  // Normal toggle for stores with deals
  const idx=state.selectedBrands.indexOf(name);
  if(idx>-1)state.selectedBrands.splice(idx,1); else state.selectedBrands.push(name);
  const el=document.getElementById(elId);
  if(el)el.classList.toggle("selected",state.selectedBrands.includes(name));
  const n=state.selectedBrands.length; const btn=document.getElementById("storesBtn");
  btn.disabled=n===0; btn.textContent=n>0?`View Deals from ${n} Store${n>1?"s":""} →`:"View Deals →";
}

// ── Screen 2 → 3 or 4 ────────────────────────────────────────────────────────
async function onStoresPicked() {
  // Check if any selected brand is Kroger-family
  const hasKrogerFamily = state.selectedBrands.some(b => isKrogerFamily(b));
  if (hasKrogerFamily) {
    // Check if stored locationId is for current zip
    const storedZip = localStorage.getItem("dishcount-kroger-zip") || "";
    const storedLoc = localStorage.getItem("dishcount-kroger-location") || "";
    if (storedLoc && storedZip === state.zip) {
      state.selectedKrogerId = storedLoc;
    } else {
      // Fetch Kroger locations for this zip
      showLoading("Finding Kroger stores near you...");
      try {
        const res = await fetch(`/api/stores?zip=${state.zip}`);
        const data = await res.json();
        state.krogerLocations = data.stores || [];
      } catch(e) { state.krogerLocations = []; }
      hideLoading();
      if (state.krogerLocations.length > 1) { renderKrogerLocations(); goTo(3); return; }
      if (state.krogerLocations.length === 1) {
        state.selectedKrogerId = state.krogerLocations[0].id;
        try { localStorage.setItem("dishcount-kroger-location", state.krogerLocations[0].id); localStorage.setItem("dishcount-kroger-zip", state.zip); } catch(e) {}
      }
    }
  }
  loadDealsAndShow();
}

// ── Screen 3: Kroger Location ─────────────────────────────────────────────────
function renderKrogerLocations() {
  document.getElementById("krogerLocationsList").innerHTML=state.krogerLocations.map(s=>{
    const info=getBanner(s.name);
    return `<div class="card clickable" id="kloc-${escapeHtml(s.id)}" onclick="pickKrogerLocation('${escapeHtml(s.id)}')">
      <div class="store-row">
        <div style="width:44px;height:44px;border-radius:12px;background:${escapeHtml(info.color)};display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">${escapeHtml(info.emoji)}</div>
        <div style="flex:1"><div class="store-name">${escapeHtml(s.name)}</div><div class="store-addr">${escapeHtml(s.address)}${s.hours?" · "+escapeHtml(s.hours):""}</div></div>
        <div class="store-check">✓</div>
      </div>
    </div>`;}).join("");
}
function pickKrogerLocation(id) {
  state.selectedKrogerId=id;
  try { localStorage.setItem("dishcount-kroger-location", id); localStorage.setItem("dishcount-kroger-zip", state.zip); } catch(e) {}
  document.querySelectorAll("[id^='kloc-']").forEach(el=>el.classList.remove("selected"));
  document.getElementById(`kloc-${id}`).classList.add("selected");
  document.getElementById("krogerBtn").disabled=false;
}
function onKrogerPicked(){loadDealsAndShow();}
function goBackFromDeals(){if(state.selectedBrands.includes("Kroger")&&state.krogerLocations.length>1)goTo(3);else goTo(2);}

// ── Kroger connection check ──────────────────────────────────────────────────
async function checkKrogerConnection() {
  if (state.krogerConnected) return; // already checked
  try {
    const { data } = await sb.auth.getSession();
    if (!data?.session?.access_token) { state.krogerConnected = false; return; }
    const res = await fetch("/api/profile", { headers: { Authorization: `Bearer ${data.session.access_token}` } });
    if (res.ok) {
      const profile = await res.json();
      state.krogerConnected = !!profile.kroger_connected;
      console.log("Kroger connection:", state.krogerConnected);
    }
  } catch(e) { console.error("checkKrogerConnection error:", e); }
}

// ── Load Deals → Screen 4 ────────────────────────────────────────────────────
async function loadDealsAndShow() {
  showLoading("Loading this week's deals…","Fetching sale items from your stores");
  try {
    // Use the regional deals endpoint — fetches Kroger + ALDI + ad-extracted deals
    const params = new URLSearchParams({ zip: state.zip });
    if (state.selectedKrogerId) params.set("locationId", state.selectedKrogerId);
    const res = await fetch(`/api/deals/regional?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to fetch deals");

    let allDeals = data.deals || [];

    // Filter to only selected brands
    const selectedLower = state.selectedBrands.map(b => b.toLowerCase());
    const hasKrogerFamilySelected = state.selectedBrands.some(b => isKrogerFamily(b));
    allDeals = allDeals.filter(d => {
      const store = (d.storeName || d.source || "").toLowerCase();
      // Kroger family: if user selected ANY Kroger-family brand, include all kroger-source deals
      if (d.source === "kroger" && hasKrogerFamilySelected) return true;
      // ALDI
      if (d.source === "aldi" && selectedLower.includes("aldi")) return true;
      // Ad-extracted deals: match by storeName
      if (d.source === "ad-extract") return selectedLower.some(b => store.includes(b) || b.includes(store));
      // Fallback
      return selectedLower.some(b => store.includes(b) || b.includes(store));
    });

    // Show deal freshness timestamp
    if (data.dealsUpdatedAt) {
      const d = new Date(data.dealsUpdatedAt);
      const formatted = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      document.getElementById("dealsUpdated").textContent = "Deals updated: " + formatted;
    } else {
      document.getElementById("dealsUpdated").textContent = "";
    }

    // Log sources for debugging
    console.log("Regional response:", { totalDeals: data.totalDeals, sources: data.sources, selectedBrands: state.selectedBrands });
    console.log("After brand filter:", allDeals.length, "deals from", data.totalDeals, "total");

    state.coupons=[];state.boostDeals=[];
    if(hasKrogerFamilySelected){
      await checkKrogerConnection();
      if(state.krogerConnected){try{const{data:{session}}=await sb.auth.getSession();if(session?.access_token){const r=await fetch("/api/coupons",{headers:{Authorization:`Bearer ${session.access_token}`}});if(r.ok){const d=await r.json();state.coupons=d.coupons||[];state.boostDeals=d.boostDeals||[];}}}catch(e){}}
    }
    const map=new Map();for(const d of allDeals){if(!map.has(d.id)||parseFloat(d.salePrice)<parseFloat(map.get(d.id).salePrice))map.set(d.id,d);}
    state.deals=[...map.values()].sort((a,b)=>b.pctOff-a.pctOff);
    state.dealStates={}; state.saleStoreFilter="all"; state.saleCategoryFilter="all";
    if(state.deals.length===0){
      hideLoading();
      const onlyAldi = state.selectedBrands.length === 1 && state.selectedBrands[0] === "ALDI";
      if (onlyAldi) {
        showToast("ALDI deals are being updated. Try adding another store or check back soon!");
      } else {
        showToast("No deals found for your selected stores. Try selecting different stores or expanding your search radius.");
      }
      return;
    }
    renderSaleItems(); goTo(4);
  }catch(err){showToast(err.message);}finally{hideLoading();}
}

// ── Coupon matching helper ────────────────────────────────────────────────────
function findMatchingCoupon(dealName) {
  const nameLower = (dealName || "").toLowerCase();
  const allCoupons = [...(state.coupons || []), ...(state.boostDeals || [])];
  return allCoupons.find(c => {
    const desc = ((c.description || "") + " " + (c.brand || "")).toLowerCase();
    const words = nameLower.split(/\s+/).filter(w => w.length > 3);
    return words.some(w => desc.includes(w)) || desc.split(/\s+/).filter(w => w.length > 3).some(w => nameLower.includes(w));
  });
}

// ── Screen 4: Sale Items Browser ──────────────────────────────────────────────
function renderSaleItems() {
  const CATEGORY_GROUPS = {
    "🥩 Meat":["chicken","beef","pork","ground beef","steak","salmon","shrimp","turkey","sausage","bacon","hot dogs","tilapia","tuna","lamb","ribs","roast","meatballs","chicken breast","chicken thighs","cod","seafood"],
    "🥬 Produce":["apples","bananas","oranges","strawberries","grapes","avocado","tomatoes","potatoes","onions","broccoli","carrots","lettuce","spinach","peppers","mushrooms","celery","corn","cucumber","lemons","limes","blueberries","fruit","vegetables"],
    "🧀 Dairy":["milk","eggs","cheese","butter","yogurt","cream cheese","sour cream","shredded cheese","cottage cheese","dairy"],
    "🥫 Pantry":["pasta","rice","bread","cereal","oatmeal","flour","sugar","canned tomatoes","beans","soup","broth","peanut butter","olive oil","salsa","tortillas","ketchup","mustard","mayonnaise","vegetable oil","vinegar","soy sauce","condiments","sauce","oil","dressing","spices","seasoning","noodles","grains","tortilla"],
    "🧊 Frozen":["frozen pizza","frozen vegetables","ice cream","frozen fruit","frozen meals","frozen chicken","frozen shrimp","frozen seafood"],
    "🍿 Snacks":["chips","crackers","nuts","juice","coffee","tea","snacks","popcorn","beverages","soda","water"],
  };
  function getCatGroup(cat){const c=(cat||"").toLowerCase();for(const[g,terms]of Object.entries(CATEGORY_GROUPS)){if(terms.some(t=>c.includes(t)||t.includes(c)))return g;}return"Other";}

  let deals=state.deals;
  if(state.saleStoreFilter!=="all")deals=deals.filter(d=>(d.storeName||d.source||"").toLowerCase().includes(state.saleStoreFilter.toLowerCase()));
  if(state.saleCategoryFilter!=="all")deals=deals.filter(d=>getCatGroup(d.category)===state.saleCategoryFilter);

  // Kroger connect banner — hide if coupons loaded (means connected) or explicitly connected
  const krogerBanner = document.getElementById("krogerConnectBanner");
  if (krogerBanner) {
    const hasCoupons = state.coupons.length > 0 || state.boostDeals.length > 0;
    const krogerBrandName = state.selectedBrands.find(b => isKrogerFamily(b)) || "Kroger";
    const hasKF = !!krogerBrandName && isKrogerFamily(krogerBrandName);
    const showBanner = hasKF && !hasCoupons && !state.krogerConnected;
    krogerBanner.style.display = showBanner ? "flex" : "none";
    if (showBanner) {
      const p = krogerBanner.querySelector("p");
      const a = krogerBanner.querySelector("a");
      if (p) p.innerHTML = `🔗 Connect your ${escapeHtml(krogerBrandName)} account to unlock digital coupons and save even more!`;
      if (a) a.textContent = `Connect ${krogerBrandName}`;
    }
  }

  const ic=Object.values(state.dealStates).filter(v=>v==="include").length;
  const ec=Object.values(state.dealStates).filter(v=>v==="exclude").length;
  document.getElementById("saleSummary").innerHTML=`
    <span style="background:var(--green-light);color:var(--green-dark)">✓ ${ic} must-include</span>
    <span style="background:#FFF0F0;color:var(--red)">✕ ${ec} excluded</span>
    <span style="background:#F5F0E8;color:#5A4A30">${state.deals.length} total</span>`;

  const storeNames=[...new Set(state.deals.map(d=>d.storeName||d.source||"Other"))].sort();
  document.getElementById("saleStoreFilters").innerHTML=`
    <button class="sale-filter-btn ${state.saleStoreFilter==='all'?'active':''}" onclick="filterSaleStore('all')">All</button>
    ${storeNames.map(s=>`<button class="sale-filter-btn ${state.saleStoreFilter===s?'active':''}" onclick="filterSaleStore('${escapeHtml(s).replace(/'/g,"&#039;")}')">${escapeHtml(s)}</button>`).join("")}`;

  const catGroups=[...new Set(state.deals.map(d=>getCatGroup(d.category)))].sort();
  document.getElementById("saleCategoryFilters").innerHTML=`
    <button class="sale-filter-btn ${state.saleCategoryFilter==='all'?'active':''}" onclick="filterSaleCategory('all')">All</button>
    ${catGroups.map(c=>`<button class="sale-filter-btn ${state.saleCategoryFilter===c?'active':''}" onclick="filterSaleCategory('${escapeHtml(c).replace(/'/g,"&#039;")}')">${escapeHtml(c)}</button>`).join("")}`;

  document.getElementById("dealsTitle").textContent=`This week's deals (${deals.length})`;
  document.getElementById("saleGrid").innerHTML=deals.map(d=>{
    const ds=state.dealStates[d.id]||"";
    const cls=ds==="include"?"include":ds==="exclude"?"exclude":"";
    const badge=ds==="include"?"✓":ds==="exclude"?"✕":"";
    const price=d.salePrice||""; const reg=d.regularPrice&&d.regularPrice!==d.salePrice?d.regularPrice:"";
    const store=d.storeName||d.source||""; const pct=d.pctOff>0?`${d.pctOff}%`:"";
    const unit=d.priceUnit||"";
    const hasCoupon = findMatchingCoupon(d.name);
    return `<div class="sale-card ${cls}" onclick="cycleDealState('${escapeHtml(d.id)}')">
      ${pct?`<div class="sale-card-pct">${escapeHtml(pct)} off</div>`:""}
      ${badge?`<div class="sale-card-badge">${badge}</div>`:""}
      ${hasCoupon?`<div class="sale-card-coupon">🎟️ Coupon</div>`:""}
      ${d.image?`<img class="sale-card-img" src="${escapeHtml(d.image)}" alt="${escapeHtml(d.name)}" onerror="this.className='sale-card-img-ph';this.innerHTML='🏷️';this.removeAttribute('src')" />`:`<div class="sale-card-img-ph">🏷️</div>`}
      <div class="sale-card-body">
        <div class="sale-card-name">${escapeHtml(d.name)}</div>
        <div class="sale-card-price">${price?`<span class="sale-card-sale">${escapeHtml(price.startsWith("$")?price:"$"+price)}${escapeHtml(unit)}</span>`:""} ${reg?`<span class="sale-card-reg">${escapeHtml(reg.startsWith("$")?reg:"$"+reg)}${escapeHtml(unit)}</span>`:""}</div>
        ${d.saleStory?`<div class="sale-card-store" style="color:var(--orange);font-weight:600">${escapeHtml(d.saleStory)}</div>`:""}
        <div class="sale-card-store">${escapeHtml(store)}${d.adSourceUrl?` · <a href="${escapeHtml(d.adSourceUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--green-mid);text-decoration:none;font-size:11px">📰 View Ad</a>`:""}</div>
        ${ds==="include"?`<button onclick="event.stopPropagation();addDealToList('${escapeHtml(d.id)}')" style="margin-top:4px;padding:3px 8px;border:1px solid var(--green-mid);border-radius:6px;background:var(--green-light);color:var(--green-dark);font-size:10px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif">🛒 Add to List</button>`:""}
      </div></div>`;}).join("");
}
function cycleDealState(id){const c=state.dealStates[id]||null;if(c===null)state.dealStates[id]="include";else if(c==="include")state.dealStates[id]="exclude";else delete state.dealStates[id];renderSaleItems();}
function addDealToList(id){const d=state.deals.find(x=>x.id===id);if(!d)return;const added=slAddItem({name:d.name,price:d.salePrice||"",store:d.storeName||d.source||"",source:"deal",recipeTitle:"",upc:d.upc||"",category:d.category||""});if(added)showToast("Added to list!","success");else showToast("Already in list","success");}
function filterSaleStore(s){state.saleStoreFilter=s;renderSaleItems();}
function filterSaleCategory(c){state.saleCategoryFilter=c;renderSaleItems();}

// ── Screen 5: Meal + Filters ──────────────────────────────────────────────────
function renderMealTypes(){
  document.getElementById("mealTypeGrid").innerHTML=MEAL_TYPES.map(m=>`<div class="meal-card${state.selectedMealType===m.id?' selected':''}" onclick="selectMealType('${m.id}')" style="text-align:center;padding:18px 8px"><div class="meal-icon" style="font-size:32px">${m.icon}</div><div class="meal-label" style="font-size:15px">${m.label}</div></div>`).join("");
}
function selectMealType(id){state.selectedMealType=id;renderMealTypes();document.getElementById("findRecipesBtn").disabled=false;}
function renderStyleGrid(){document.getElementById("styleGrid").innerHTML=RECIPE_STYLES.map(m=>`<div class="meal-card${state.selectedStyle===m.id?' selected':''}" id="style-${m.id.replace(/[^a-zA-Z]/g,'_')}" onclick="selectStyle('${escapeHtml(m.id).replace(/'/g,"&#039;")}')" style="text-align:center"><div class="meal-icon">${m.icon}</div><div class="meal-label">${escapeHtml(m.label)}</div><div style="font-size:11px;color:#999;margin-top:2px">${escapeHtml(m.sub)}</div></div>`).join("");}
function selectStyle(id){state.selectedStyle=id;document.querySelectorAll("[id^='style-']").forEach(c=>c.classList.remove("selected"));document.getElementById(`style-${id.replace(/[^a-zA-Z]/g,'_')}`).classList.add("selected");}
function renderFilterGrid(){document.getElementById("filterGrid").innerHTML=DIET_FILTERS.map(f=>`<div class="filter-chip ${state.selectedDiets.includes(f)?'selected':''}" onclick="toggleFilter(this,'${escapeHtml(f).replace(/'/g,"&#039;")}')">${escapeHtml(f)}</div>`).join("");}
function toggleFilter(el,f){el.classList.toggle("selected");const i=state.selectedDiets.indexOf(f);if(i>-1)state.selectedDiets.splice(i,1);else state.selectedDiets.push(f);}

// ── Screen 5 → 6: Search Recipes ─────────────────────────────────────────────
function getRecipePayload(offset) {
  const excluded=new Set(Object.entries(state.dealStates).filter(([,v])=>v==="exclude").map(([k])=>k));
  const mustInclude=new Set(Object.entries(state.dealStates).filter(([,v])=>v==="include").map(([k])=>k));
  const selectedDeals=state.deals.filter(d=>!excluded.has(d.id));
  if(!selectedDeals.length) return null;
  const mustFirst=[...selectedDeals.filter(d=>mustInclude.has(d.id)).map(d=>({...d,mustInclude:true})),...selectedDeals.filter(d=>!mustInclude.has(d.id))];
  const wantItems=(document.getElementById("wantItems")?.value||"").trim();
  const haveItems=(document.getElementById("haveItems")?.value||"").trim();
  return {
    ingredients:mustFirst.map(d=>({name:d.name,category:d.category,salePrice:d.salePrice,regularPrice:d.regularPrice,savings:d.savings,storeName:d.storeName||d.source||"",mustInclude:!!d.mustInclude,isPerLb:!!d.isPerLb,priceUnit:d.priceUnit||""})),
    style:state.selectedStyle || state.selectedMealType || "Dinner", mealType:state.selectedMealType, diets:state.selectedDiets, wantItems, haveItems, offset:offset||0
  };
}

async function searchRecipes() {
  const payload=getRecipePayload(0);
  if(!payload){showToast("All deals excluded — unmark some items");return;}
  state.recipeOffset=0;
  showCookingLoading();
  try {
    const res=await fetch("/api/recipes/ai",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"Could not generate recipes");
    if(!data.recipes?.length)throw new Error("No recipes generated. Try a different style or include more items.");
    state.recipes=data.recipes;
    state.recipeOffset=8;
    renderRecipeGrid(); goTo(6);
    if (data.badges) handleBadgeResponse(data.badges);
    if (data.dealHunterScore) showDealHunterScore(data.dealHunterScore);
    if (data.badges?.xp) { const total = parseFloat(prevTotalSavings) + state.recipes.reduce((s,r) => s + (r.totalSavings||0), 0); checkSavingsMilestone(total); }
  }catch(err){showToast(err.message);}finally{hideLoading();}
}

async function loadMoreRecipes() {
  const payload=getRecipePayload(state.recipeOffset);
  if(!payload){showToast("Error loading more recipes");return;}
  const btn=document.getElementById("moreRecipesBtn");
  btn.disabled=true; btn.textContent="🤖 Generating…";
  showCookingLoading();
  try {
    const res=await fetch("/api/recipes/ai",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"Could not generate recipes");
    if(data.recipes?.length){
      const existingTitles=new Set(state.recipes.map(r=>r.title));
      const newRecipes=data.recipes.filter(r=>!existingTitles.has(r.title));
      state.recipes.push(...newRecipes);
      state.recipeOffset+=8;
      renderRecipeGrid();
      showToast(`${data.recipes.length} more recipes added!`,"success");
    } else { showToast("No more recipes found. Try a different style."); }
  }catch(err){showToast(err.message);}finally{
    hideLoading(); btn.disabled=false; btn.textContent="🤖 Generate 8 More Recipes";
  }
}
function sortRecipes(by){document.querySelectorAll(".sort-btn").forEach(b=>b.classList.remove("active"));document.getElementById(`sort-${by}`).classList.add("active");if(by==="time")state.recipes.sort((a,b)=>a.readyInMinutes-b.readyInMinutes);if(by==="ingredients")state.recipes.sort((a,b)=>b.usedIngredientCount-a.usedIngredientCount);renderRecipeGrid();}

function renderRecipeGrid(){
  const styleInfo=RECIPE_STYLES.find(s=>s.id===state.selectedStyle)||{icon:"🍽️",label:"Recipes"};
  const diets=state.selectedDiets.length?` · ${state.selectedDiets.join(", ")}`:"";
  document.getElementById("recipesTitle").textContent=`${styleInfo.icon} ${styleInfo.label} Recipes`;
  document.getElementById("resultsCount").textContent=`${state.recipes.length} AI-generated recipes${diets}`;
  document.getElementById("recipeGrid").innerHTML=state.recipes.map((r,i)=>{
    const emoji=r.title.match(/chicken/i)?"🍗":r.title.match(/beef|steak|burger/i)?"🥩":r.title.match(/pasta|spaghetti|noodle/i)?"🍝":r.title.match(/soup|stew|chili/i)?"🍲":r.title.match(/taco|burrito|quesadilla/i)?"🌮":r.title.match(/salad/i)?"🥗":r.title.match(/rice|bowl/i)?"🍚":r.title.match(/pizza/i)?"🍕":r.title.match(/sandwich|sub|melt/i)?"🥪":r.title.match(/fish|salmon|shrimp|tilapia/i)?"🐟":r.title.match(/pork|ham/i)?"🥓":r.title.match(/breakfast|egg|pancake/i)?"🥞":"🍽️";
    return `<div class="recipe-card-tile" onclick="openModal(${i})">
      ${r.image?`<img class="recipe-card-img" src="${escapeHtml(r.image)}" alt="${escapeHtml(r.title)}" onerror="this.outerHTML='<div class=\\'recipe-card-img-placeholder\\' style=\\'font-size:48px;padding:30px 0\\'>${emoji}</div>'" />`:`<div class="recipe-card-img-placeholder lazy-img" data-title="${escapeHtml(r.title)}" data-idx="${i}" style="font-size:48px;padding:30px 0">${emoji}</div>`}
      <div class="recipe-card-body"><div class="recipe-card-title">${escapeHtml(r.title)}</div><div class="recipe-card-meta">
        ${r.time!=="N/A"?`<span class="meta-chip meta-time">⏱ ${escapeHtml(r.time)}</span>`:""}
        ${r.estimatedCost>0?`<span class="meta-chip meta-cost">💰 ${r.usedSaleItems?.some(i=>i.isPerLb)?"≈ ":""}$${r.estimatedCost.toFixed(2)}${r.servings?` · $${(r.estimatedCost/r.servings).toFixed(2)}/serving`:""}</span>`:""}
        <span class="meta-chip" style="background:var(--green-light);color:var(--green-dark)">🏷️ ${r.usedSaleItems?.length||0} sale items</span>
        ${r.couponsToClip?.length?`<span class="meta-chip meta-coupon">🎟️ ${r.couponsToClip.length} coupon${r.couponsToClip.length>1?"s":""}</span>`:""}
      </div></div></div>`;}).join("");
  // Lazy-load images for cards without them
  lazyLoadRecipeImages();
}

const lazyImageObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const el = entry.target;
    const title = el.dataset.title;
    const idx = parseInt(el.dataset.idx);
    lazyImageObserver.unobserve(el);
    fetch(`/api/recipe-image?title=${encodeURIComponent(title)}`).then(r=>r.json()).then(data => {
      if (data.url) {
        el.outerHTML = `<img class="recipe-card-img" src="${escapeHtml(data.url)}" alt="${escapeHtml(title)}" onerror="this.outerHTML='<div class=\\'recipe-card-img-placeholder\\' style=\\'font-size:48px;padding:30px 0\\'>🍽️</div>'" />`;
        if (state.recipes[idx]) { state.recipes[idx].image = data.url; state.recipes[idx].photoCredit = data.photographer; }
      }
    }).catch(() => {});
  });
}, { rootMargin: "200px" });

function lazyLoadRecipeImages() {
  document.querySelectorAll(".lazy-img").forEach(el => lazyImageObserver.observe(el));
}

// ── Recipe Modal ──────────────────────────────────────────────────────────────
function getCartLabel(){return"📋 Shopping List";}
let modalServings = 4;
let modalOrigServings = 4;

function formatAmount(n) {
  if (n <= 0) return "";
  const frac = n - Math.floor(n);
  const whole = Math.floor(n);
  let fracStr = "";
  if (frac >= 0.2 && frac <= 0.3) fracStr = "\u00BC";
  else if (frac >= 0.3 && frac <= 0.4) fracStr = "\u2153";
  else if (frac >= 0.45 && frac <= 0.55) fracStr = "\u00BD";
  else if (frac >= 0.6 && frac <= 0.7) fracStr = "\u2154";
  else if (frac >= 0.7 && frac <= 0.8) fracStr = "\u00BE";
  else if (frac > 0.05) fracStr = frac.toFixed(1).replace("0.", ".");
  if (whole > 0 && fracStr) return whole + " " + fracStr;
  if (whole > 0) return String(whole);
  if (fracStr) return fracStr;
  return n.toFixed(1).replace(/\.0$/, "");
}

function adjustServings(delta) {
  modalServings = Math.max(1, Math.min(20, modalServings + delta));
  document.getElementById("servingsCount").textContent = modalServings;
  // Rescale ingredients
  const ratio = modalServings / modalOrigServings;
  document.querySelectorAll("[data-orig-amount]").forEach(el => {
    const orig = parseFloat(el.dataset.origAmount);
    if (orig > 0) el.textContent = formatAmount(orig * ratio);
  });
}

function openModal(i){state.currentRecipe={...state.recipes[i],index:i};modalServings=state.currentRecipe.servings||4;modalOrigServings=modalServings;renderModal(state.currentRecipe);document.getElementById("modalOverlay").classList.add("show");document.body.style.overflow="hidden";}
function closeModal(){document.getElementById("modalOverlay").classList.remove("show");document.body.style.overflow="";}
function closeModalOnOverlay(e){if(e.target===document.getElementById("modalOverlay"))closeModal();}
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&document.getElementById("modalOverlay").classList.contains("show"))closeModal();});

function renderModal(r){
  const isSaved=state.savedRecipeIds.has(r.title);const cartLabel=getCartLabel();
  document.getElementById("modalContent").innerHTML=`
    ${r.image?`<img class="modal-img" src="${escapeHtml(r.image)}" alt="${escapeHtml(r.title)}" />${r.photoCredit?`<div style="text-align:center;font-size:10px;color:#999;padding:4px 0">Photo by ${escapeHtml(r.photoCredit)} on <a href="${escapeHtml(r.photoUrl||'https://pexels.com')}" target="_blank" style="color:#999">Pexels</a></div>`:""}`:`<div class="modal-img-placeholder">🍽️</div>`}
    <div class="modal-body">
      <div class="modal-header"><div class="modal-title">${escapeHtml(r.title)}</div><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-stats">
        ${r.time!=="N/A"?`<span class="stat-pill stat-time">⏱ ${escapeHtml(r.time)}</span>`:""}
        <span class="stat-pill stat-servings">👥 ${escapeHtml(r.servings)} servings</span>
        ${r.estimatedCost>0?`<span class="stat-pill stat-cost">💰 ${r.usedSaleItems?.some(i=>i.isPerLb)?"≈ ":""}$${r.estimatedCost.toFixed(2)}</span>`:""}
        ${r.estimatedCost>0&&r.servings?`<span class="stat-pill" style="background:#E8F0F8;color:#2D4A6A">👤 $${(r.estimatedCost/r.servings).toFixed(2)}/serving</span>`:""}
      </div>
      ${r.usedSaleItems?.length?`<div class="modal-section"><div class="modal-section-title">🏷️ On Sale — What You'll Pay</div><div class="ing-list">${r.usedSaleItems.map(ing=>{
        const costNum=ing.actualCost||String(ing.salePrice).replace(/[^0-9.]/g,"");
        const cost=ing.isPerLb?`≈ $${costNum}`:`$${costNum}`;
        const pkgNote=ing.packageNote?`<div style="font-size:10px;color:#666">${escapeHtml(ing.packageNote)}</div>`:"";
        const perLbLine=ing.isPerLb?`<div style="font-size:10px;color:#999">${escapeHtml(ing.salePrice)} <s style="opacity:0.5">${escapeHtml(ing.regularPrice)}</s></div>`:"";
        const regPrice=!ing.isPerLb&&ing.regularPrice&&ing.regularPrice!=="—"?`<span class="ing-reg-price">$${String(ing.regularPrice).replace(/[^0-9.]/g,"")}</span>`:"";
        return `<div class="ing-row on-sale"><span>✅ ${escapeHtml(ing.name)}${ing.storeName?` <span style="font-size:9px;color:#999">(${escapeHtml(ing.storeName)})</span>`:""}</span><div style="text-align:right"><span class="ing-sale-price">${escapeHtml(cost)}</span>${regPrice}${perLbLine}${pkgNote}</div></div>`;
      }).join("")}</div></div>`:""}
      ${r.couponsToClip?.length?`<div class="modal-section"><div class="modal-section-title">🎟️ Digital Coupons</div><div style="display:flex;flex-direction:column;gap:8px">${r.couponsToClip.map(c=>`<div class="coupon-card"><div><span style="font-size:13px">${c.clipped?"✅":"🎟️"} ${escapeHtml(c.description)}</span></div><div style="font-size:11px;color:var(--muted);margin-top:4px">${c.clipped?"Already clipped":"Clip in Kroger app to save"}</div></div>`).join("")}</div></div>`:""}
      <div class="modal-section">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div class="modal-section-title" style="margin-bottom:0">📋 All Ingredients</div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:13px;color:var(--muted)">Servings:</span>
            <button onclick="adjustServings(-1)" style="width:32px;height:32px;border-radius:50%;border:2px solid var(--green-mid);background:white;color:var(--green-dark);font-size:18px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center">&minus;</button>
            <span id="servingsCount" style="font-size:20px;font-weight:800;color:var(--green-dark);min-width:24px;text-align:center">${r.servings||4}</span>
            <button onclick="adjustServings(1)" style="width:32px;height:32px;border-radius:50%;border:2px solid var(--green-mid);background:white;color:var(--green-dark);font-size:18px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center">+</button>
          </div>
        </div>
        <div class="ing-list">${(r.allIngredients||[]).map((ing,idx)=>{
        const type=ing.type||"PANTRY";
        const isOnSale=type==="SALE"&&ing.onSale;
        const isOnHand=type==="ON_HAND";
        const isAdditional=type==="ADDITIONAL";
        const icon=isOnSale?"🏷️":isOnHand?"🏠":isAdditional?"🛒":"🫙";
        const label=isOnSale?"ON SALE":isOnHand?"ON HAND":isAdditional?"TO BUY":"PANTRY";
        const bg=isOnSale?"var(--green-light)":isOnHand?"#E8F0F8":isAdditional?"#FFF8E8":"#F5F0E8";
        const color=isOnSale?"var(--green-dark)":isOnHand?"#2D4A6A":isAdditional?"#8B6914":"#5A4A30";
        const priceTag=ing.matchedDeal?` · ${ing.matchedDeal.isPerLb?"≈ ":""}$${ing.matchedDeal.actualCost||String(ing.matchedDeal.salePrice).replace(/[^0-9.]/g,"")}${ing.matchedDeal.isPerLb?" ("+String(ing.matchedDeal.salePrice).replace(/[^0-9.]/g,"")+"/lb)":""}${ing.matchedDeal.regularPrice&&ing.matchedDeal.regularPrice!=="—"&&!ing.matchedDeal.isPerLb?` <s style="opacity:0.5;font-size:9px">$${String(ing.matchedDeal.regularPrice).replace(/[^0-9.]/g,"")}</s>`:""}`:"";
        // Parse leading amount for scaling
        const amtMatch = ing.name.match(/^([\d.\/]+)\s/);
        const origAmt = amtMatch ? parseFraction(amtMatch[1]) : 0;
        const rest = amtMatch ? ing.name.slice(amtMatch[0].length) : ing.name;
        return `<div class="ing-row" style="background:${bg}"><span>${icon} ${origAmt > 0 ? `<span data-orig-amount="${origAmt}">${formatAmount(origAmt)}</span> ` : ""}${escapeHtml(rest)}</span><span style="font-size:10px;font-weight:700;color:${color}">${label}${priceTag}</span></div>`;
      }).join("")}</div></div>
      ${r.instructions?.length?`<div class="modal-section"><div class="modal-section-title">📋 Instructions</div><div class="steps-list">${r.instructions.map((step,i)=>`<div class="step-row"><div class="step-num">${i+1}</div><div class="step-text">${escapeHtml(step)}</div></div>`).join("")}</div></div>`:""}
      <div class="modal-actions">
        <button class="modal-btn modal-btn-save ${isSaved?"saved":""}" id="saveBtn" onclick="saveRecipe()">${isSaved?"❤️ Saved!":"🤍 Save Recipe"}</button>
        <button class="modal-btn modal-btn-list" onclick="showShoppingList()">📋 Shopping List</button>
        <button class="modal-btn" onclick="shareRecipe('${escapeHtml(r.title).replace(/'/g,"\\'")}')" style="background:#E8F0F8;color:#2D4A6A;border:2px solid #90CAF9">🔗 Share</button>
      </div></div>`;
}

function savePendingState(action) {
  try {
    sessionStorage.setItem("dishcount_pending_state", JSON.stringify({
      zip: state.zip, distance: state.distance, selectedBrands: state.selectedBrands,
      selectedKrogerId: state.selectedKrogerId, deals: state.deals, dealStates: state.dealStates,
      selectedMealType: state.selectedMealType, selectedStyle: state.selectedStyle,
      selectedDiets: state.selectedDiets, recipes: state.recipes,
      currentRecipeIndex: state.recipes.indexOf(state.currentRecipe),
      pendingAction: action
    }));
  } catch(e) { console.error("savePendingState:", e); }
}

function restorePendingState() {
  try {
    const raw = sessionStorage.getItem("dishcount_pending_state");
    if (!raw) return null;
    sessionStorage.removeItem("dishcount_pending_state");
    return JSON.parse(raw);
  } catch(e) { sessionStorage.removeItem("dishcount_pending_state"); return null; }
}

async function saveRecipe(){
  let session;try{const r=await sb.auth.getSession();session=r.data?.session;}catch(e){console.error("saveRecipe auth error:",e);showToast("Could not check login status");return;}
  if(!session){savePendingState("save_recipe");showToast("Sign in to save recipes");window.location.href="/profile.html";return;}
  const r=state.currentRecipe;if(state.savedRecipeIds.has(r.title)){showToast("Already saved!","success");return;}
  try{
    const body={title:r.title,emoji:"🍽️",time:r.time,servings:String(r.servings||4),difficulty:"",ingredients:r.allIngredients?.map(i=>i.name)||[],steps:r.instructions||[],store_name:state.selectedBrands.slice(0,2).join(" & "),image:r.image||""};
    console.log("saveRecipe: sending",body);
    const res=await fetch("/api/recipes/saved",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.access_token}`},body:JSON.stringify(body)});
    if(res.ok){state.savedRecipeIds.add(r.title);document.getElementById("saveBtn").textContent="❤️ Saved!";document.getElementById("saveBtn").classList.add("saved");showToast("Recipe saved!","success");}
    else{const err=await res.json().catch(()=>({}));console.error("saveRecipe API error:",res.status,err);showToast(err.error||"Could not save recipe — try signing in again");}
  }catch(e){console.error("saveRecipe error:",e);showToast("Could not save recipe. Please try again.");}
}

// ── Shopping List — Slide-out Panel ──────────────────────────────────────────
function loadShoppingList() { try { const s = localStorage.getItem("dishcount-shopping-list"); if (s) state.shoppingList = JSON.parse(s); } catch(e) {} updateShoppingBadge(); }
function saveShoppingListToStorage() { try { localStorage.setItem("dishcount-shopping-list", JSON.stringify(state.shoppingList)); } catch(e) {} }
function slAddItem(item) {
  if (state.shoppingList.some(i => i.name === item.name && i.recipeTitle === item.recipeTitle)) return false;
  state.shoppingList.push({ id: Date.now() + Math.random(), ...item });
  saveShoppingListToStorage(); updateShoppingBadge(); return true;
}
function slRemoveItem(id) { state.shoppingList = state.shoppingList.filter(i => i.id !== id); saveShoppingListToStorage(); updateShoppingBadge(); renderSlideoutList(); }
function slClear() { state.shoppingList = []; saveShoppingListToStorage(); updateShoppingBadge(); renderSlideoutList(); showToast("Shopping list cleared!", "success"); }
function updateShoppingBadge() {
  const count = state.shoppingList.length;
  const text = "🛒 " + count;
  const badge = document.getElementById("shoppingBadge");
  if (badge) badge.textContent = text;
  const badge2 = document.getElementById("shoppingBadgeLanding");
  if (badge2) badge2.textContent = text;
}
function toggleSlideout() {
  const panel = document.getElementById("slideoutPanel");
  const overlay = document.getElementById("slideoutOverlay");
  if (!panel) return;
  const open = panel.classList.toggle("open");
  overlay.classList.toggle("open", open);
  document.body.style.overflow = open ? "hidden" : "";
  if (open) renderSlideoutList();
}
function closeSlideout() {
  document.getElementById("slideoutPanel")?.classList.remove("open");
  document.getElementById("slideoutOverlay")?.classList.remove("open");
  document.body.style.overflow = "";
}
const CATEGORY_EMOJI = {"meat":"🥩","chicken":"🥩","beef":"🥩","pork":"🥩","seafood":"🐟","produce":"🥬","vegetables":"🥬","fruit":"🍎","dairy":"🧀","cheese":"🧀","eggs":"🧀","frozen":"🧊","pantry":"🥫","snacks":"🍿","beverages":"☕","bakery":"🍞","deli":"🥪"};
function getCatEmoji(cat) { const c=(cat||"").toLowerCase(); for(const[k,e]of Object.entries(CATEGORY_EMOJI)){if(c.includes(k))return e;} return "🏷️"; }

// isKrogerFamily defined above with KROGER_FAMILY_NORM

function updateKrogerCartButton() {
  const btn = document.getElementById("krogerCartBtn");
  if (!btn) return;
  const list = state.shoppingList;
  const hasRecipeIngredients = list.some(i => i.source === "recipe-ingredient");
  const krogerStores = [...new Set(list.filter(i => i.store && isKrogerFamily(i.store)).map(i => i.store))];
  const showButton = hasRecipeIngredients || krogerStores.length > 0;
  btn.style.display = showButton ? "" : "none";
  if (krogerStores.length === 1) {
    btn.textContent = "🛒 Add to " + krogerStores[0] + " Cart";
  } else {
    btn.textContent = "🛒 Add to Kroger Cart";
  }
}

function renderSlideoutList() {
  const list = state.shoppingList;
  const body = document.getElementById("slideoutBody");
  if (!body) return;
  updateKrogerCartButton();
  if (!list.length) { body.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--muted)"><div style="font-size:48px;margin-bottom:12px">🛒</div><p>Your shopping list is empty</p><p style="font-size:13px;margin-top:8px">Add items from the deals screen or recipe ingredients</p></div>'; return; }

  let html = "";

  // RECIPES section
  const recipeMap = {};
  list.filter(i => i.source === "recipe-ingredient" && i.recipeTitle).forEach(item => {
    if (!recipeMap[item.recipeTitle]) recipeMap[item.recipeTitle] = [];
    recipeMap[item.recipeTitle].push(item);
  });
  if (Object.keys(recipeMap).length) {
    html += `<div style="padding:0 16px 8px"><div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 6px">Recipes</div>`;
    for (const [title, items] of Object.entries(recipeMap)) {
      html += `<div style="border:2px solid var(--sand);border-radius:12px;margin-bottom:8px;overflow:hidden">
        <div onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'" style="display:flex;align-items:center;justify-content:space-between;padding:12px;cursor:pointer;background:white;min-height:44px">
          <div style="font-weight:700;font-size:14px">${escapeHtml(title)}</div>
          <span style="font-size:11px;color:var(--muted);background:var(--green-light);padding:2px 8px;border-radius:8px">${items.length} items</span>
        </div>
        <div style="display:none;padding:0 12px 12px;background:var(--cream)">`;
      items.forEach(item => {
        html += `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f0ede6;min-height:40px">
          <div style="flex:1;font-size:13px">${escapeHtml(item.name)}</div>
          ${item.price?`<span style="font-weight:700;color:var(--orange);font-size:12px">$${escapeHtml(String(item.price).replace(/^\$/,""))}</span>`:""}
          <button onclick="slRemoveItem(${item.id})" style="background:none;border:none;cursor:pointer;font-size:14px;color:#ccc;padding:2px">✕</button></div>`;
      });
      html += `</div></div>`;
    }
    html += `</div>`;
  }

  // STORE sections (deal items grouped by store then category)
  const dealItems = list.filter(i => i.source === "deal");
  const storeMap = {};
  dealItems.forEach(item => {
    const store = item.store || "Other";
    if (!storeMap[store]) storeMap[store] = {};
    const cat = item.category || "Other";
    if (!storeMap[store][cat]) storeMap[store][cat] = [];
    storeMap[store][cat].push(item);
  });
  for (const [store, cats] of Object.entries(storeMap)) {
    const count = Object.values(cats).flat().length;
    html += `<div style="padding:0 16px 8px">
      <div onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;cursor:pointer;border-bottom:2px solid var(--sand);min-height:44px">
        <div style="font-weight:700;font-size:15px">${escapeHtml(store)}</div>
        <span style="font-size:11px;color:var(--muted)">${count} items</span>
      </div>
      <div>`;
    for (const [cat, items] of Object.entries(cats)) {
      html += `<div style="font-size:11px;font-weight:700;color:var(--muted);margin:10px 0 4px">${getCatEmoji(cat)} ${escapeHtml(cat)}</div>`;
      items.forEach(item => {
        html += `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f0ede6;min-height:40px">
          <div style="flex:1;font-size:13px">${escapeHtml(item.name)}</div>
          ${item.price?`<span style="font-weight:700;color:var(--orange);font-size:12px">$${escapeHtml(String(item.price).replace(/^\$/,""))}</span>`:""}
          <button onclick="slRemoveItem(${item.id})" style="background:none;border:none;cursor:pointer;font-size:14px;color:#ccc;padding:2px">✕</button></div>`;
      });
    }
    html += `</div></div>`;
  }

  // OTHER items
  const otherItems = list.filter(i => i.source !== "deal" && i.source !== "recipe-ingredient");
  if (otherItems.length) {
    html += `<div style="padding:0 16px 8px"><div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;margin:12px 0 6px">Other Items</div>`;
    otherItems.forEach(item => {
      html += `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f0ede6;min-height:40px">
        <div style="flex:1;font-size:13px">${escapeHtml(item.name)}</div>
        ${item.price?`<span style="font-weight:700;color:var(--orange);font-size:12px">$${escapeHtml(String(item.price).replace(/^\$/,""))}</span>`:""}
        <button onclick="slRemoveItem(${item.id})" style="background:none;border:none;cursor:pointer;font-size:14px;color:#ccc;padding:2px">✕</button></div>`;
    });
    html += `</div>`;
  }

  body.innerHTML = html;
}
function getListAsText() {
  const list = state.shoppingList;
  let text = "🛒 My Dishcount Shopping List\n" + "=".repeat(30) + "\n\n";

  // Recipes — collapsed, title + count only
  const recipeMap = {};
  list.filter(i => i.source === "recipe-ingredient" && i.recipeTitle).forEach(i => {
    if (!recipeMap[i.recipeTitle]) recipeMap[i.recipeTitle] = 0;
    recipeMap[i.recipeTitle]++;
  });
  if (Object.keys(recipeMap).length) {
    text += "RECIPES INCLUDED:\n";
    for (const [title, count] of Object.entries(recipeMap)) {
      text += `- ${title} (${count} ingredients)\n`;
    }
    text += "\n";
  }

  // Store sections — deals grouped by store then category
  const dealItems = list.filter(i => i.source === "deal");
  const storeMap = {};
  dealItems.forEach(i => {
    const store = i.store || "Other";
    if (!storeMap[store]) storeMap[store] = {};
    const cat = i.category || "Other";
    if (!storeMap[store][cat]) storeMap[store][cat] = [];
    storeMap[store][cat].push(i);
  });
  for (const [store, cats] of Object.entries(storeMap)) {
    text += `${store.toUpperCase()}:\n`;
    for (const [cat, items] of Object.entries(cats)) {
      text += `  ${cat}: ${items.map(i => `${i.name}${i.price ? " $" + String(i.price).replace(/^\$/,"") : ""}`).join(", ")}\n`;
    }
    text += "\n";
  }

  // Recipe ingredients as flat list
  const recipeItems = list.filter(i => i.source === "recipe-ingredient");
  if (recipeItems.length) {
    text += "INGREDIENTS:\n";
    recipeItems.forEach(i => { text += `[ ] ${i.name}${i.price ? " $" + String(i.price).replace(/^\$/,"") : ""}\n`; });
    text += "\n";
  }

  // Other items
  const otherItems = list.filter(i => i.source !== "deal" && i.source !== "recipe-ingredient");
  if (otherItems.length) {
    text += "OTHER:\n  " + otherItems.map(i => i.name).join(", ") + "\n";
  }

  return text;
}
function copySlideoutList() {
  navigator.clipboard.writeText(getListAsText()).then(() => showToast("Copied!", "success")).catch(() => showToast("Could not copy"));
}
function goToLists() {
  sb.auth.getSession().then(({data}) => {
    if (data?.session) window.location.href = "/profile.html#lists";
    else showToast("Sign in to save lists");
  });
}
function emailSlideoutList() {
  if (!state.shoppingList.length) { showToast("Shopping list is empty"); return; }
  const subject = encodeURIComponent("My Dishcount Shopping List");
  const body = encodeURIComponent(getListAsText());
  window.open(`mailto:?subject=${subject}&body=${body}`);
}
async function saveSlideoutList() {
  if (!state.shoppingList.length) { showToast("Shopping list is empty"); return; }
  let session; try { const r = await sb.auth.getSession(); session = r.data?.session; } catch(e) {}
  if (!session) { showToast("Sign in to save lists"); return; }
  const name = prompt("Name this list:", "Week of " + new Date().toLocaleDateString());
  if (!name) return;
  try {
    const res = await fetch("/api/lists", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ name, items: state.shoppingList }) });
    if (res.ok) showToast("List saved!", "success");
    else { const d = await res.json().catch(()=>({})); showToast(d.error || "Could not save list"); }
  } catch(e) { showToast("Could not save list"); }
}
function connectKrogerFromList() {
  // Save state before redirecting to Kroger OAuth
  try {
    localStorage.setItem("dishcount-restore-state", JSON.stringify({
      zip: state.zip, selectedBrands: state.selectedBrands, selectedKrogerId: state.selectedKrogerId
    }));
  } catch(e) {}
  sb.auth.getSession().then(({data}) => {
    const userId = data?.session?.user?.id || "anonymous";
    window.location.href = `/auth/kroger?userId=${userId}`;
  });
}

async function addListToKrogerCart() {
  let session; try { const r = await sb.auth.getSession(); session = r.data?.session; } catch(e) {}
  if (!session) { savePendingState("add_to_cart"); showToast("Sign in to add to cart"); window.location.href="/profile.html"; return; }

  // Check Kroger connection
  await checkKrogerConnection();
  if (!state.krogerConnected) {
    // Show connect prompt instead of silently redirecting
    const body = document.getElementById("slideoutBody");
    if (body) {
      body.innerHTML = `<div style="text-align:center;padding:40px 20px">
        <div style="font-size:48px;margin-bottom:16px">🔗</div>
        <div style="font-weight:700;font-size:16px;color:var(--green-dark);margin-bottom:8px">Connect your Kroger account</div>
        <p style="font-size:14px;color:var(--muted);margin-bottom:20px">Link your Kroger account to add items directly to your cart for pickup or delivery.</p>
        <button onclick="connectKrogerFromList()" style="padding:14px 28px;border:none;border-radius:12px;background:var(--orange);color:white;font-size:15px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;min-height:48px">Connect Kroger Account</button>
        <div style="margin-top:12px"><button onclick="renderSlideoutList()" style="background:none;border:none;color:var(--muted);font-size:13px;cursor:pointer">← Back to list</button></div>
      </div>`;
    }
    return;
  }

  const locationId = state.selectedKrogerId || localStorage.getItem("dishcount-kroger-location") || "";
  if (!locationId) { showToast("Select a Kroger store first (go back to store selection)"); return; }

  const cartBtn = document.querySelector(".slideout-footer .btn-primary");
  if (cartBtn) { cartBtn.disabled = true; cartBtn.textContent = "Adding items..."; }

  const PANTRY_SKIP = new Set(["salt","pepper","salt and pepper","salt and pepper to taste","olive oil","vegetable oil","cooking oil","canola oil","butter","sugar","flour","water","garlic","onion powder","garlic powder","paprika","cumin","chili powder","oregano","basil","thyme","cinnamon","baking powder","baking soda","cornstarch","vanilla extract","soy sauce","vinegar","hot sauce","ketchup","mustard","honey"]);

  function cleanIngredientForSearch(name) {
    let s = name.replace(/®/g, "").replace(/\([^)]*\)/g, "").trim();
    s = s.replace(/^[\d\/\.\s]+(lb|lbs|oz|cup|cups|tbsp|tsp|tablespoon|teaspoon|slices?|pieces?|bags?|cans?|cloves?|bunch|bunches|heads?|stalks?|sprigs?|pinch|dash|large|medium|small|to taste)\b\s*/i, "");
    s = s.replace(/^[\d\/\.\-\s]+/, "").trim();
    s = s.replace(/,?\s*to taste$/i, "").trim();
    s = s.replace(/^of\s+/i, "").trim();
    return s;
  }

  function isGoodMatch(searchTerm, resultName) {
    const searchWords = searchTerm.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    const resultLower = (resultName || "").toLowerCase();
    if (!searchWords.length) return true; // short search, accept any result
    return searchWords.some(w => resultLower.includes(w));
  }

  const upcSet = new Set();
  const added = []; // { name, upc, productName, searched }
  const notFound = []; // { name, searched }
  const skipped = []; // item names

  const shoppableItems = state.shoppingList.filter(i => i.name && i.source !== "recipe");
  for (const item of shoppableItems) {
    const cleaned = cleanIngredientForSearch(item.name);
    console.log(`Kroger cart: "${item.name}" → cleaned: "${cleaned}"`);

    // Only skip pantry items from recipe ingredients, NEVER from user-added deals
    if (item.source === "recipe-ingredient" && PANTRY_SKIP.has(cleaned.toLowerCase())) {
      console.log(`  Skipped (recipe pantry): ${cleaned}`);
      skipped.push(item.name);
      continue;
    }

    // 1. Direct UPC from deal data
    if (item.upc && !upcSet.has(item.upc)) {
      upcSet.add(item.upc);
      added.push({ name: item.name, upc: item.upc, productName: item.name, searched: "(had UPC)" });
      console.log(`  Found UPC directly: ${item.upc}`);
      continue;
    }

    // 2. Search Kroger API by cleaned name
    let found = false;
    try {
      console.log(`  Searching Kroger for: "${cleaned}"`);
      const searchRes = await fetch(`/api/kroger/search?query=${encodeURIComponent(cleaned)}&locationId=${locationId}`);
      if (searchRes.ok) {
        const { product } = await searchRes.json();
        if (product?.upc && !upcSet.has(product.upc)) {
          // Validate: does the result actually match what we searched for?
          if (isGoodMatch(cleaned, product.name)) {
            upcSet.add(product.upc);
            added.push({ name: item.name, upc: product.upc, productName: product.name, searched: cleaned });
            console.log(`  Found: "${product.name}" UPC: ${product.upc} ✓ good match`);
            found = true;
          } else {
            console.log(`  Rejected bad match: searched "${cleaned}" got "${product.name}"`);
          }
        }
      }
    } catch(e) { console.error(`  Search error for "${cleaned}":`, e.message); }

    if (!found) {
      console.log(`  Not found: ${cleaned}`);
      notFound.push({ name: item.name, searched: cleaned });
    }
  }

  // Send to Kroger cart
  if (added.length) {
    try {
      const cartItems = added.map(a => ({ upc: a.upc, quantity: 1 }));
      const res = await fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ items: cartItems }) });
      if (!res.ok) {
        const err = await res.json().catch(()=>({}));
        if (err.error?.includes("expired") || err.error?.includes("token")) {
          showToast("Kroger session expired. Please reconnect.");
        } else { showToast("Could not add to cart — try reconnecting Kroger"); }
        if (cartBtn) { cartBtn.disabled = false; cartBtn.textContent = "🛒 Add to Kroger Cart"; }
        return;
      }
    } catch(e) { showToast("Could not add to cart"); if (cartBtn) { cartBtn.disabled = false; cartBtn.textContent = "🛒 Add to Kroger Cart"; } return; }
  }

  // Show detailed results modal
  const body = document.getElementById("slideoutBody");
  if (body) {
    let html = `<div style="padding:16px">`;
    if (added.length) {
      html += `<div style="margin-bottom:16px"><div style="font-weight:700;color:var(--green-dark);margin-bottom:8px">✅ Added (${added.length} items)</div>`;
      added.forEach(a => { html += `<div style="font-size:13px;padding:6px 0;border-bottom:1px solid #f0ede6"><div>${escapeHtml(a.searched || "")} → <strong>${escapeHtml(a.productName)}</strong></div></div>`; });
      html += `</div>`;
    }
    if (notFound.length) {
      html += `<div style="margin-bottom:16px"><div style="font-weight:700;color:var(--red);margin-bottom:8px">❌ Not found (${notFound.length} items)</div>`;
      notFound.forEach(n => { html += `<div style="font-size:13px;padding:6px 0;border-bottom:1px solid #f0ede6;color:var(--muted)">${escapeHtml(n.searched || n.name || n)} → No good match found</div>`; });
      html += `</div>`;
    }
    if (skipped.length) {
      html += `<div style="margin-bottom:16px"><div style="font-weight:700;color:var(--muted);margin-bottom:8px">⏭️ Skipped pantry items (${skipped.length})</div>`;
      skipped.forEach(s => { html += `<div style="font-size:13px;padding:4px 0;color:var(--muted)">${escapeHtml(s)}</div>`; });
      html += `</div>`;
    }
    if (!added.length && !notFound.length) html += `<p style="color:var(--muted);text-align:center;padding:20px">No items to add</p>`;
    html += `<button onclick="renderSlideoutList()" style="width:100%;margin-top:12px;padding:12px;border:none;border-radius:10px;background:var(--green-dark);color:white;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;min-height:44px">← Back to List</button></div>`;
    body.innerHTML = html;
  }

  if (cartBtn) { cartBtn.disabled = false; cartBtn.textContent = "🛒 Add to Kroger Cart"; }
}

// Shopping list tab in recipe modal
function showShoppingList() {
  const r = state.currentRecipe;
  const ings = (r.allIngredients||[]).filter(i => i.type !== "ON_HAND");
  document.getElementById("modalContent").innerHTML = `<div class="modal-body">
    <div class="modal-header"><div class="modal-title">📋 Add to Shopping List</div><button class="modal-close" onclick="renderModal(state.currentRecipe)">✕</button></div>
    <p style="font-style:italic;color:var(--muted);font-size:14px;margin-bottom:16px">Select items from ${escapeHtml(r.title)}</p>
    <div class="ing-list">${ings.map((ing, idx) => {
      const inList = state.shoppingList.some(i => i.name === ing.name && i.recipeTitle === r.title);
      const bg = inList ? "var(--green-light)" : (ing.type==="PANTRY" ? "#F5F0E8" : "white");
      return `<div class="ing-row" style="background:${bg};margin-bottom:4px;cursor:pointer" onclick="toggleShoppingCheck(${idx})">
        <div style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" ${inList?"checked":""} style="width:16px;height:16px;accent-color:var(--green-mid);pointer-events:none" />
          <span>${escapeHtml(ing.name)}</span>
        </div>
        <span style="font-size:10px;color:var(--muted)">${ing.type||"PANTRY"}</span></div>`;
    }).join("")}</div>
    <div class="modal-actions" style="margin-top:16px">
      <button class="modal-btn modal-btn-list" onclick="renderModal(state.currentRecipe)">&#8592; Back</button>
      <button class="modal-btn modal-btn-save" onclick="addCheckedToList()" style="background:var(--green-mid);color:white;border:none">Add Selected to List</button>
    </div></div>`;
}
function toggleShoppingCheck(idx) {
  const r = state.currentRecipe;
  const ings = (r.allIngredients||[]).filter(i => i.type !== "ON_HAND");
  const checkboxes = document.querySelectorAll('.ing-list input[type=checkbox]');
  if (checkboxes[idx]) checkboxes[idx].checked = !checkboxes[idx].checked;
}
function addCheckedToList() {
  const r = state.currentRecipe;
  const ings = (r.allIngredients||[]).filter(i => i.type !== "ON_HAND");
  const checkboxes = document.querySelectorAll('.ing-list input[type=checkbox]');
  let count = 0;
  ings.forEach((ing, idx) => {
    if (checkboxes[idx]?.checked) {
      const price = ing.matchedDeal ? (ing.matchedDeal.actualCost || String(ing.matchedDeal.salePrice).replace(/[^0-9.]/g,"")) : "";
      const upc = ing.matchedDeal?.upc || "";
      const added = slAddItem({ name: ing.name, price, store: ing.matchedDeal?.storeName || "", source: "recipe-ingredient", recipeTitle: r.title, upc });
      if (added) count++;
    }
  });
  if (count > 0) showToast(`Added ${count} items to shopping list`, "success");
  else showToast("Items already in list", "success");
  renderModal(r);
}
loadShoppingList();

// ── Badge Popup ─────────────────────────────────────────────────────────────
function showBadgePopup(badge, levelUp) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:500;display:flex;align-items:center;justify-content:center;padding:20px";
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  const isSavings = badge.id?.startsWith("saver_");
  overlay.innerHTML = `<div style="background:white;border-radius:24px;padding:36px;max-width:340px;width:100%;text-align:center;animation:slideUp 0.3s ease;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
    <div style="font-size:64px;margin-bottom:12px;animation:cookBounce 0.6s ease-in-out infinite alternate">${escapeHtml(badge.emoji)}</div>
    <div style="font-family:'Outfit',sans-serif;font-size:22px;font-weight:800;color:var(--green-dark);margin-bottom:6px">${escapeHtml(badge.name)}</div>
    <div style="font-size:14px;color:var(--muted);margin-bottom:12px">${escapeHtml(badge.desc)}</div>
    <div style="font-size:18px;font-weight:800;color:var(--orange);margin-bottom:12px">+${badge.xp} XP!</div>
    ${levelUp ? `<div style="font-size:16px;font-weight:700;color:var(--green-dark);margin-bottom:12px">Level Up! You're now a ${escapeHtml(levelUp.name)} 🎉</div>` : ""}
    <button onclick="this.closest('[style*=fixed]').remove()" style="padding:12px 32px;border:none;border-radius:50px;background:var(--orange);color:white;font-size:16px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;min-height:48px">Nice!</button>
  </div>`;
  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 6000);
}

function handleBadgeResponse(result) {
  if (!result?.newBadges?.length) return;
  result.newBadges.forEach((b, i) => {
    setTimeout(() => showBadgePopup(b, i === 0 ? result.newLevel : null), i * 1500);
  });
}

// ── Social Share ────────────────────────────────────────────────────────────
function shareRecipe(title) {
  const text = `Check out this recipe from Dishcount — ${title}! Made from this week's grocery deals. 🛒`;
  const url = "https://dishcount.co";
  if (navigator.share) {
    navigator.share({ title, text, url }).catch(() => {});
  } else {
    const encoded = encodeURIComponent(text + " " + url);
    const modal = document.createElement("div");
    modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:500;display:flex;align-items:center;justify-content:center;padding:20px";
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `<div style="background:white;border-radius:20px;padding:28px;max-width:320px;width:100%;text-align:center">
      <div style="font-weight:700;font-size:18px;color:var(--green-dark);margin-bottom:16px">Share Recipe</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button onclick="navigator.clipboard.writeText('${escapeHtml(text)} ${url}');showToast('Copied!','success');this.closest('[style*=fixed]').remove()" style="padding:12px;border:2px solid var(--sand);border-radius:12px;background:white;font-size:14px;font-weight:600;cursor:pointer;min-height:44px">📋 Copy Link</button>
        <a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encoded}" target="_blank" style="padding:12px;border:2px solid #1877F2;border-radius:12px;background:#E7F3FF;color:#1877F2;font-size:14px;font-weight:600;text-decoration:none;min-height:44px;display:flex;align-items:center;justify-content:center">Facebook</a>
        <a href="https://twitter.com/intent/tweet?text=${encoded}" target="_blank" style="padding:12px;border:2px solid #1DA1F2;border-radius:12px;background:#E8F5FD;color:#1DA1F2;font-size:14px;font-weight:600;text-decoration:none;min-height:44px;display:flex;align-items:center;justify-content:center">X / Twitter</a>
        <a href="https://pinterest.com/pin/create/button/?url=${encodeURIComponent(url)}&description=${encoded}" target="_blank" style="padding:12px;border:2px solid #E60023;border-radius:12px;background:#FFF0F0;color:#E60023;font-size:14px;font-weight:600;text-decoration:none;min-height:44px;display:flex;align-items:center;justify-content:center">Pinterest</a>
      </div>
      <button onclick="this.closest('[style*=fixed]').remove()" style="margin-top:12px;background:none;border:none;color:var(--muted);font-size:13px;cursor:pointer">Close</button>
    </div>`;
    document.body.appendChild(modal);
  }
}

// ── Confetti ────────────────────────────────────────────────────────────────
function fireConfetti(big) {
  if (typeof confetti !== "function") return;
  if (big) {
    confetti({ particleCount: 150, spread: 90, origin: { y: 0.6 } });
    setTimeout(() => confetti({ particleCount: 80, angle: 60, spread: 55, origin: { x: 0 } }), 250);
    setTimeout(() => confetti({ particleCount: 80, angle: 120, spread: 55, origin: { x: 1 } }), 400);
  } else {
    confetti({ particleCount: 40, spread: 60, origin: { y: 0.7 } });
  }
}

// ── Savings Milestone Check ─────────────────────────────────────────────────
const SAVINGS_MILESTONES = [25, 50, 100, 250, 500];
let prevTotalSavings = 0;
function checkSavingsMilestone(newTotal) {
  for (const m of SAVINGS_MILESTONES) {
    if (prevTotalSavings < m && newTotal >= m) {
      fireConfetti(true);
      showBadgePopup({ emoji: "🎉", name: `$${m} Saved!`, desc: `You've saved $${m} on groceries with Dishcount!`, xp: 0 });
      break;
    }
  }
  prevTotalSavings = newTotal;
}

// Update handleBadgeResponse to fire mini confetti
const _origHandleBadge = handleBadgeResponse;
function handleBadgeResponse(result) {
  if (result?.newBadges?.length) fireConfetti(false);
  _origHandleBadge(result);
  if (result?.newBadges?.some(b => b.id?.startsWith("saver_"))) fireConfetti(true);
}

// ── Deal Hunter Score Display ───────────────────────────────────────────────
function showDealHunterScore(score) {
  if (!score || !score.percent) return;
  const color = score.percent > 50 ? "var(--green-mid)" : score.percent > 25 ? "var(--orange)" : "var(--red)";
  const el = document.createElement("div");
  el.style.cssText = "text-align:center;padding:16px;margin-bottom:16px;background:white;border:2px solid var(--sand);border-radius:14px";
  el.innerHTML = `<div style="font-size:13px;color:var(--muted);margin-bottom:4px">Deal Hunter Score</div>
    <div style="font-family:'Outfit',sans-serif;font-size:32px;font-weight:800;color:${color}">${score.percent}%</div>
    <div style="font-size:13px;color:var(--muted)">You used ${score.used} of ${score.total} selected deals!</div>`;
  const grid = document.getElementById("recipeGrid");
  if (grid) grid.parentNode.insertBefore(el, grid);
}

// ── Homepage Personalization ────────────────────────────────────────────────
async function loadPersonalDashboard() {
  try {
    const { data: authData } = await sb.auth.getSession();
    if (!authData?.session) return;
    const token = authData.session.access_token;
    const [statsRes, challengesRes, leaderboardRes, badgesRes] = await Promise.all([
      fetch("/api/stats", { headers: { Authorization: "Bearer " + token } }),
      fetch("/api/challenges", { headers: { Authorization: "Bearer " + token } }),
      fetch("/api/leaderboard"),
      fetch("/api/badges", { headers: { Authorization: "Bearer " + token } }),
    ]);
    const stats = statsRes.ok ? await statsRes.json() : {};
    const challenges = challengesRes.ok ? (await challengesRes.json()).challenges || [] : [];
    const board = leaderboardRes.ok ? (await leaderboardRes.json()).leaderboard || [] : [];
    const badges = badgesRes.ok ? await badgesRes.json() : {};
    prevTotalSavings = parseFloat(stats.total_savings || 0);

    const streak = stats.streak_weeks || 0;
    const fires = streak >= 8 ? "🔥🔥🔥🔥" : streak >= 5 ? "🔥🔥🔥" : streak >= 3 ? "🔥🔥" : streak >= 1 ? "🔥" : "";
    const name = stats.full_name?.split(" ")[0] || "Chef";
    const level = stats.levelName || "Newbie";
    const xp = stats.xp || 0;
    const nextXp = stats.nextLevel?.xpNeeded || 1100;
    const xpPct = Math.min(100, Math.round((xp / nextXp) * 100));
    const lastBadge = (badges.badges || []).filter(b => b.earned).pop();

    let html = `<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
      <div style="font-family:'Outfit',sans-serif;font-size:20px;font-weight:700;color:var(--green-dark)">Welcome back, ${escapeHtml(name)}!</div>
      ${streak ? `<span style="font-size:14px">${fires} ${streak} week streak!</span>` : `<span style="font-size:13px;color:var(--muted)">Start your streak! Come back next week.</span>`}
    </div>
    <div style="background:white;border:2px solid var(--sand);border-radius:12px;padding:12px 16px;margin-bottom:12px;display:flex;align-items:center;gap:12px">
      <div style="font-size:12px;color:var(--muted)">Lv ${stats.level || 1}</div>
      <div style="font-weight:700;font-size:14px;color:var(--green-dark)">${escapeHtml(level)}</div>
      <div style="flex:1;background:var(--sand);border-radius:6px;height:8px;overflow:hidden"><div style="height:100%;width:${xpPct}%;background:var(--green-mid);border-radius:6px"></div></div>
      <div style="font-size:11px;color:var(--muted)">${xp}/${nextXp} XP</div>
    </div>`;

    // Weekly Quests
    if (challenges.length) {
      html += `<div style="font-size:13px;font-weight:700;color:var(--green-dark);margin-bottom:6px">⚔️ Weekly Quests</div>`;
      html += `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">`;
      challenges.forEach(c => {
        const pct = Math.min(100, Math.round((c.progress / c.target) * 100));
        const tipText = `${escapeHtml(c.desc)}<br>${c.progress} of ${c.target} completed<br><strong>+${c.xp} XP on completion</strong>`;
        html += `<div class="has-tooltip" onclick="this.classList.toggle('tap-active')" style="background:white;border:2px solid ${c.completed?"var(--green-mid)":"var(--sand)"};border-radius:10px;padding:10px;text-align:center">
          <div class="tooltip">${tipText}</div>
          <div style="font-size:20px">${c.completed?"✅":c.icon}</div>
          <div style="font-size:11px;font-weight:700;color:var(--green-dark);margin:4px 0">${escapeHtml(c.title)}</div>
          <div style="background:var(--sand);border-radius:4px;height:6px;overflow:hidden;margin:4px 0"><div style="height:100%;width:${pct}%;background:${c.completed?"var(--green-mid)":"var(--orange)"}"></div></div>
          <div style="font-size:10px;color:var(--muted)">${c.progress}/${c.target} · ${c.completed?"Done!":"+"+c.xp+" XP"}</div>
        </div>`;
      });
      html += `</div>`;
    }

    // Leaderboard snippet + last badge
    html += `<div style="display:flex;gap:8px">`;
    if (board.length) {
      html += `<div style="flex:1;background:white;border:2px solid var(--sand);border-radius:10px;padding:10px;font-size:13px">
        <div style="font-weight:700;color:var(--green-dark);margin-bottom:6px">🏆 Top Savers</div>
        ${board.slice(0,3).map((r,i) => `<div style="display:flex;justify-content:space-between;padding:2px 0"><span>${["🥇","🥈","🥉"][i]} ${escapeHtml(r.city)}</span><span style="font-weight:700;color:var(--orange)">$${r.savings}</span></div>`).join("")}
      </div>`;
    }
    if (lastBadge) {
      html += `<div style="flex:1;background:white;border:2px solid var(--sand);border-radius:10px;padding:10px;text-align:center">
        <div style="font-size:11px;color:var(--muted)">Latest Badge</div>
        <div style="font-size:28px;margin:4px 0">${escapeHtml(lastBadge.emoji)}</div>
        <div style="font-size:12px;font-weight:700;color:var(--green-dark)">${escapeHtml(lastBadge.name)}</div>
      </div>`;
    }
    html += `</div>`;

    const dashboard = document.getElementById("personalDashboard");
    const content = document.getElementById("dashboardContent");
    if (dashboard && content) { content.innerHTML = html; dashboard.style.display = ""; }
  } catch (e) { console.error("loadPersonalDashboard:", e); }
}

// Load dashboard on auth state change for signed-in users
sb.auth.onAuthStateChange((event, session) => {
  if (session?.user) setTimeout(loadPersonalDashboard, 500);
});
