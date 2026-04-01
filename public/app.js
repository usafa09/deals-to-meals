function escapeHtml(str) {
  if (str == null) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
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
  if (!session?.user) {
    // Reset to signed-out state
    const icon = document.getElementById("profileBtnIcon");
    const text = document.getElementById("profileBtnText");
    const btn = document.getElementById("profileBtn");
    if (icon) icon.innerHTML = "&#128100;";
    if (text) text.textContent = "Sign In";
    if (btn) btn.classList.remove("logged-in");
    const savedBtn = document.getElementById("savedRecipesBtn");
    if (savedBtn) savedBtn.style.display = "none";
    const listsBtn = document.getElementById("listsBtn");
    if (listsBtn) listsBtn.style.display = "none";
    const landingSavedBtn = document.getElementById("landingSavedBtn");
    if (landingSavedBtn) landingSavedBtn.style.display = "none";
    const landingSignin = document.getElementById("landingSigninBtn");
    if (landingSignin) { landingSignin.textContent = "Sign In"; landingSignin.href = "/profile.html"; }
    return;
  }
  // Signed in — update UI
  const user = session.user;
  sb.from("profiles").select("full_name").eq("id", user.id).single().then(({ data: profile }) => {
    const name = profile?.full_name || user.email?.split("@")[0] || "Profile";
    const firstName = name.split(" ")[0];
    const icon = document.getElementById("profileBtnIcon");
    const text = document.getElementById("profileBtnText");
    const btn = document.getElementById("profileBtn");
    if (icon) icon.innerHTML = `<span class="profile-avatar">${firstName[0].toUpperCase()}</span>`;
    if (text) text.textContent = firstName;
    if (btn) btn.classList.add("logged-in");
    const savedBtn = document.getElementById("savedRecipesBtn");
    if (savedBtn) savedBtn.style.display = "flex";
    const listsBtn = document.getElementById("listsBtn");
    if (listsBtn) listsBtn.style.display = "flex";
    const landingSavedBtn = document.getElementById("landingSavedBtn");
    if (landingSavedBtn) landingSavedBtn.style.display = "flex";
    const landingSignin = document.getElementById("landingSigninBtn");
    if (landingSignin) { landingSignin.textContent = firstName; landingSignin.href = "/profile.html"; }
  });
}

// Listen for auth state changes (handles OAuth redirects, sign-in, sign-out)
sb.auth.onAuthStateChange((event, session) => {
  console.log("auth state change:", event, !!session);
  updateAuthUI(session);
});

// Also check on page load
sb.auth.getSession().then(({ data }) => updateAuthUI(data?.session));

const RECIPE_STYLES = [
  { id:"Quick Weeknight", icon:"🏃", label:"Quick Weeknight", sub:"30 min or less" },
  { id:"Family-Friendly", icon:"👨‍👩‍👧‍👦", label:"Family-Friendly", sub:"Kids will eat it" },
  { id:"Comfort Food", icon:"🍲", label:"Comfort Food", sub:"Casseroles, soups, one-pot" },
  { id:"Meal Prep", icon:"📦", label:"Meal Prep", sub:"Great leftovers" },
  { id:"Healthy & Light", icon:"🥗", label:"Healthy & Light", sub:"Under 500 cal/serving" },
  { id:"Slow Cooker", icon:"🫕", label:"Slow Cooker", sub:"Set it and forget it" },
];
const DIET_FILTERS = ["Vegetarian","Vegan","Gluten-Free","Dairy-Free","Keto","Paleo","Low Calorie","High Fiber","Pescetarian","Mediterranean","Halal","Kosher"];

let state = {
  zip:"", distance:15, storeBrands:[], selectedBrands:[], krogerLocations:[], selectedKrogerId:null,
  deals:[], dealStates:{}, coupons:[], boostDeals:[], saleStoreFilter:"all", saleCategoryFilter:"all",
  selectedStyle:null, selectedDiets:[], recipeOffset:0, recipes:[], currentRecipe:null, savedRecipeIds:new Set(), shoppingList:[],
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
  if (step === 5) { renderStyleGrid(); renderFilterGrid(); }
}
function renderProgress(step) {
  document.getElementById("progressBar").innerHTML = Array.from({length:6},(_,i) => {
    const a = i < step;
    return `<div class="pip" style="width:${a?20:8}px;background:${a?"var(--green-mid)":"#D5D5D5"}"></div>`;
  }).join("");
}
function resetApp() {
  state = { zip:"", distance:15, storeBrands:[], selectedBrands:[], krogerLocations:[], selectedKrogerId:null, deals:[], dealStates:{}, coupons:[], boostDeals:[], saleStoreFilter:"all", saleCategoryFilter:"all", selectedStyle:null, selectedDiets:[], recipeOffset:0, recipes:[], currentRecipe:null, savedRecipeIds:new Set(), shoppingList:[] };
  document.getElementById("zipInput").value = "";
  document.getElementById("zipBtn").disabled = true;
}
let cookingInterval = null;
const COOKING_MESSAGES = [
  { emoji: "🍳", text: "Preheating the oven..." },
  { emoji: "🔪", text: "Chopping ingredients..." },
  { emoji: "🧈", text: "Melting the butter..." },
  { emoji: "🥘", text: "Simmering the sauce..." },
  { emoji: "🧂", text: "Adding seasoning..." },
  { emoji: "🍲", text: "Stirring the pot..." },
  { emoji: "👨‍🍳", text: "Taste-testing..." },
  { emoji: "🍽️", text: "Plating the dishes..." },
  { emoji: "✨", text: "Adding the finishing touches..." },
];
function showLoading(text, sub="") {
  document.getElementById("loadingText").textContent=text;
  document.getElementById("loadingSub").textContent=sub;
  document.getElementById("loadingOverlay").classList.add("show");
}
function showCookingLoading() {
  const overlay = document.getElementById("loadingOverlay");
  const spinner = overlay.querySelector(".spinner");
  const textEl = document.getElementById("loadingText");
  const subEl = document.getElementById("loadingSub");
  // Replace spinner with cooking emoji
  spinner.style.display = "none";
  let emojiEl = overlay.querySelector(".cooking-emoji");
  if (!emojiEl) { emojiEl = document.createElement("div"); emojiEl.className = "cooking-emoji"; spinner.parentNode.insertBefore(emojiEl, spinner); }
  emojiEl.style.display = "block";
  let idx = 0;
  const update = () => { const m = COOKING_MESSAGES[idx % COOKING_MESSAGES.length]; emojiEl.textContent = m.emoji; textEl.textContent = m.text; idx++; };
  update();
  subEl.textContent = "Our AI chef is crafting your recipes";
  cookingInterval = setInterval(update, 2500);
  overlay.classList.add("show");
}
function hideLoading() {
  document.getElementById("loadingOverlay").classList.remove("show");
  if (cookingInterval) { clearInterval(cookingInterval); cookingInterval = null; }
  const overlay = document.getElementById("loadingOverlay");
  const spinner = overlay.querySelector(".spinner");
  const emojiEl = overlay.querySelector(".cooking-emoji");
  if (spinner) spinner.style.display = "";
  if (emojiEl) emojiEl.style.display = "none";
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

const KROGER_BANNERS=["kroger","ralphs","fred meyer","king soopers","harris teeter","smith's","fry's","qfc","mariano's","dillons","pick n save","city market","baker's"];
function isKrogerFamily(name){const k=(name||"").toLowerCase();return KROGER_BANNERS.some(b=>k.includes(b));}

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
      if(isKrogerFamily(s.name))brandName="Kroger";
      else if(s.name.toLowerCase().includes("aldi"))brandName="ALDI";
      else brandName=s.name.trim();
      if(!brandMap.has(brandName)){const info=getBanner(brandName);brandMap.set(brandName,{name:brandName,source:s.source,emoji:info.emoji,color:info.color,stores:[],hasDeals:s.hasDeals||s.source==="kroger"||s.source==="aldi"});}
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
function onStoresPicked() {
  if(state.selectedBrands.includes("Kroger")){
    const kb=state.storeBrands.find(b=>b.name==="Kroger");
    state.krogerLocations=kb?kb.stores:[];
    if(state.krogerLocations.length>1){renderKrogerLocations();goTo(3);return;}
    else if(state.krogerLocations.length===1)state.selectedKrogerId=state.krogerLocations[0].id;
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
  document.querySelectorAll("[id^='kloc-']").forEach(el=>el.classList.remove("selected"));
  document.getElementById(`kloc-${id}`).classList.add("selected");
  document.getElementById("krogerBtn").disabled=false;
}
function onKrogerPicked(){loadDealsAndShow();}
function goBackFromDeals(){if(state.selectedBrands.includes("Kroger")&&state.krogerLocations.length>1)goTo(3);else goTo(2);}

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
    allDeals = allDeals.filter(d => {
      const store = (d.storeName || d.source || "").toLowerCase();
      // Kroger family: if user selected "Kroger", include all kroger-source deals
      if (d.source === "kroger" && selectedLower.some(b => b === "kroger" || store.includes(b))) return true;
      // ALDI
      if (d.source === "aldi" && selectedLower.includes("aldi")) return true;
      // Ad-extracted deals: match by storeName
      if (d.source === "ad-extract") return selectedLower.some(b => store.includes(b) || b.includes(store));
      // Fallback
      return selectedLower.some(b => store.includes(b) || b.includes(store));
    });

    // Log sources for debugging
    console.log("Regional response:", { totalDeals: data.totalDeals, sources: data.sources, selectedBrands: state.selectedBrands });
    console.log("After brand filter:", allDeals.length, "deals from", data.totalDeals, "total");

    state.coupons=[];state.boostDeals=[];state.krogerConnected=false;
    if(state.selectedBrands.includes("Kroger")){try{const{data:{session}}=await sb.auth.getSession();if(session?.access_token){const r=await fetch("/api/coupons",{headers:{Authorization:`Bearer ${session.access_token}`}});if(r.ok){const d=await r.json();state.coupons=d.coupons||[];state.boostDeals=d.boostDeals||[];state.krogerConnected=true;}}}catch(e){}}
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
    const showBanner = state.selectedBrands.includes("Kroger") && !hasCoupons && !state.krogerConnected;
    krogerBanner.style.display = showBanner ? "flex" : "none";
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
    ${storeNames.map(s=>`<button class="sale-filter-btn ${state.saleStoreFilter===s?'active':''}" onclick="filterSaleStore('${s.replace(/'/g,"\\'")}')">${s}</button>`).join("")}`;

  const catGroups=[...new Set(state.deals.map(d=>getCatGroup(d.category)))].sort();
  document.getElementById("saleCategoryFilters").innerHTML=`
    <button class="sale-filter-btn ${state.saleCategoryFilter==='all'?'active':''}" onclick="filterSaleCategory('all')">All</button>
    ${catGroups.map(c=>`<button class="sale-filter-btn ${state.saleCategoryFilter===c?'active':''}" onclick="filterSaleCategory('${c}')">${c}</button>`).join("")}`;

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
function addDealToList(id){const d=state.deals.find(x=>x.id===id);if(!d)return;const added=slAddItem({name:d.name,price:d.salePrice||"",store:d.storeName||d.source||"",source:"deal",recipeTitle:"",upc:d.upc||""});if(added)showToast("Added to list!","success");else showToast("Already in list","success");}
function filterSaleStore(s){state.saleStoreFilter=s;renderSaleItems();}
function filterSaleCategory(c){state.saleCategoryFilter=c;renderSaleItems();}

// ── Screen 5: Meal + Filters ──────────────────────────────────────────────────
function renderStyleGrid(){document.getElementById("styleGrid").innerHTML=RECIPE_STYLES.map(m=>`<div class="meal-card${state.selectedStyle===m.id?' selected':''}" id="style-${m.id.replace(/[^a-zA-Z]/g,'_')}" onclick="selectStyle('${m.id.replace(/'/g,"\\'")}')" style="text-align:center"><div class="meal-icon">${m.icon}</div><div class="meal-label">${m.label}</div><div style="font-size:11px;color:#999;margin-top:2px">${m.sub}</div></div>`).join("");document.getElementById("findRecipesBtn").disabled=!state.selectedStyle;}
function selectStyle(id){state.selectedStyle=id;document.querySelectorAll(".meal-card").forEach(c=>c.classList.remove("selected"));document.getElementById(`style-${id.replace(/[^a-zA-Z]/g,'_')}`).classList.add("selected");document.getElementById("findRecipesBtn").disabled=false;}
function renderFilterGrid(){document.getElementById("filterGrid").innerHTML=DIET_FILTERS.map(f=>`<div class="filter-chip ${state.selectedDiets.includes(f)?'selected':''}" onclick="toggleFilter(this,'${f}')">${f}</div>`).join("");}
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
    style:state.selectedStyle, diets:state.selectedDiets, wantItems, haveItems, offset:offset||0
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
function sortRecipes(by){document.querySelectorAll(".sort-btn").forEach(b=>b.classList.remove("active"));document.getElementById(`sort-${by}`).classList.add("active");if(by==="savings")state.recipes.sort((a,b)=>b.totalSavings-a.totalSavings);if(by==="time")state.recipes.sort((a,b)=>a.readyInMinutes-b.readyInMinutes);if(by==="ingredients")state.recipes.sort((a,b)=>b.usedIngredientCount-a.usedIngredientCount);renderRecipeGrid();}

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
        ${r.totalSavings>0?`<span class="meta-chip meta-savings">🔥 Save $${r.totalSavings.toFixed(2)}</span>`:""}
        <span class="meta-chip" style="background:var(--green-light);color:var(--green-dark)">🏷️ ${r.usedSaleItems?.length||0} sale items</span>
        ${r.couponsToClip?.length?`<span class="meta-chip meta-coupon">🎟️ ${r.couponsToClip.length} coupon${r.couponsToClip.length>1?"s":""} — save $${r.couponsToClip.reduce((s,c)=>s+parseFloat(c.savings||0),0).toFixed(2)} more</span>`:""}
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
function openModal(i){state.currentRecipe={...state.recipes[i],index:i};renderModal(state.currentRecipe);document.getElementById("modalOverlay").classList.add("show");document.body.style.overflow="hidden";}
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
        ${r.estimatedCost>0?`<span class="stat-pill stat-cost">💰 ${r.usedSaleItems?.some(i=>i.isPerLb)?"≈ ":""}$${r.estimatedCost.toFixed(2)}${r.regularPriceTotal>r.estimatedCost?` <s style="opacity:0.5">$${r.regularPriceTotal.toFixed(2)}</s>`:""}</span>`:""}
        ${(()=>{
          const couponSavings=r.couponsToClip?.reduce((s,c)=>s+parseFloat(c.savings||0),0)||0;
          const saleSavings=r.totalSavings||0;
          const totalSavings=saleSavings+couponSavings;
          if(totalSavings<=0)return"";
          if(couponSavings>0)return`<span class="stat-pill stat-savings">🔥 Save $${totalSavings.toFixed(2)}</span><span class="stat-pill" style="background:var(--orange-light);color:var(--orange);font-size:11px">Sales $${saleSavings.toFixed(2)} + Coupons $${couponSavings.toFixed(2)}</span>`;
          return`<span class="stat-pill stat-savings">🔥 Save $${saleSavings.toFixed(2)}</span>`;
        })()}
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
      ${r.couponsToClip?.length?`<div class="modal-section"><div class="modal-section-title">🎟️ Digital Coupons</div><div style="display:flex;flex-direction:column;gap:8px">${r.couponsToClip.map(c=>`<div class="coupon-card"><div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:13px">${c.clipped?"✅":"🎟️"} ${escapeHtml(c.description)}</span><span style="font-weight:800;color:var(--orange);white-space:nowrap">-$${parseFloat(c.savings).toFixed(2)}</span></div><div style="font-size:11px;color:var(--muted);margin-top:4px">${c.clipped?"Already clipped":"Clip in Kroger app to save"}</div></div>`).join("")}</div></div>`:""}
      <div class="modal-section"><div class="modal-section-title">📋 All Ingredients</div><div class="ing-list">${(r.allIngredients||[]).map((ing,idx)=>{
        const type=ing.type||"PANTRY";
        const isOnSale=type==="SALE"&&ing.onSale;
        const isOnHand=type==="ON_HAND";
        const isAdditional=type==="ADDITIONAL";
        const icon=isOnSale?"🏷️":isOnHand?"🏠":isAdditional?"🛒":"🫙";
        const label=isOnSale?"ON SALE":isOnHand?"ON HAND":isAdditional?"TO BUY":"PANTRY";
        const bg=isOnSale?"var(--green-light)":isOnHand?"#E8F0F8":isAdditional?"#FFF8E8":"#F5F0E8";
        const color=isOnSale?"var(--green-dark)":isOnHand?"#2D4A6A":isAdditional?"#8B6914":"#5A4A30";
        const priceTag=ing.matchedDeal?` · ${ing.matchedDeal.isPerLb?"≈ ":""}$${ing.matchedDeal.actualCost||String(ing.matchedDeal.salePrice).replace(/[^0-9.]/g,"")}${ing.matchedDeal.isPerLb?" ("+String(ing.matchedDeal.salePrice).replace(/[^0-9.]/g,"")+"/lb)":""}${ing.matchedDeal.regularPrice&&ing.matchedDeal.regularPrice!=="—"&&!ing.matchedDeal.isPerLb?` <s style="opacity:0.5;font-size:9px">$${String(ing.matchedDeal.regularPrice).replace(/[^0-9.]/g,"")}</s>`:""}`:"";
        return `<div class="ing-row" style="background:${bg}"><span>${icon} ${escapeHtml(ing.name)}</span><span style="font-size:10px;font-weight:700;color:${color}">${label}${priceTag}</span></div>`;
      }).join("")}</div></div>
      ${r.instructions?.length?`<div class="modal-section"><div class="modal-section-title">📋 Instructions</div><div class="steps-list">${r.instructions.map((step,i)=>`<div class="step-row"><div class="step-num">${i+1}</div><div class="step-text">${escapeHtml(step)}</div></div>`).join("")}</div></div>`:""}
      <div class="modal-actions">
        <button class="modal-btn modal-btn-save ${isSaved?"saved":""}" id="saveBtn" onclick="saveRecipe()">${isSaved?"❤️ Saved!":"🤍 Save Recipe"}</button>
        <button class="modal-btn modal-btn-list" onclick="showShoppingList()">📋 Shopping List</button>
      </div></div>`;
}

async function saveRecipe(){
  let session;try{const r=await sb.auth.getSession();session=r.data?.session;}catch(e){console.error("saveRecipe auth error:",e);showToast("Could not check login status");return;}
  if(!session){showToast("Sign in to save recipes");window.location.href="/profile.html";return;}
  const r=state.currentRecipe;if(state.savedRecipeIds.has(r.title)){showToast("Already saved!","success");return;}
  try{
    const body={title:r.title,emoji:"🍽️",time:r.time,servings:String(r.servings||4),difficulty:"",ingredients:r.allIngredients?.map(i=>i.name)||[],steps:r.instructions||[],store_name:state.selectedBrands.slice(0,2).join(" & "),image:r.image||""};
    console.log("saveRecipe: sending",body);
    const res=await fetch("/api/recipes/saved",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.access_token}`},body:JSON.stringify(body)});
    if(res.ok){state.savedRecipeIds.add(r.title);document.getElementById("saveBtn").textContent="❤️ Saved!";document.getElementById("saveBtn").classList.add("saved");showToast("Recipe saved!","success");}
    else{const err=await res.json().catch(()=>({}));console.error("saveRecipe API error:",res.status,err);showToast(err.error||"Could not save recipe — try signing in again");}
  }catch(e){console.error("saveRecipe error:",e);showToast("Could not save recipe: "+e.message);}
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
function slClear() { state.shoppingList = []; saveShoppingListToStorage(); updateShoppingBadge(); renderSlideoutList(); showToast("Shopping list cleared", "success"); }
function updateShoppingBadge() {
  const badge = document.getElementById("shoppingBadge");
  if (badge) { badge.textContent = "🛒 " + state.shoppingList.length; badge.style.display = state.shoppingList.length > 0 ? "inline-block" : "none"; }
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
function renderSlideoutList() {
  const list = state.shoppingList;
  const body = document.getElementById("slideoutBody");
  if (!body) return;
  if (!list.length) { body.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--muted)"><div style="font-size:48px;margin-bottom:12px">🛒</div><p>Your shopping list is empty</p><p style="font-size:13px;margin-top:8px">Add items from the deals screen or recipe ingredients</p></div>'; return; }
  const groups = { "Sale Items": [], "Recipe Ingredients": [], "Other Items": [] };
  list.forEach(item => {
    if (item.source === "deal") groups["Sale Items"].push(item);
    else if (item.source === "recipe-ingredient") groups["Recipe Ingredients"].push(item);
    else groups["Other Items"].push(item);
  });
  let html = "";
  for (const [group, items] of Object.entries(groups)) {
    if (!items.length) continue;
    html += `<div style="padding:0 16px;margin-bottom:12px"><div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">${group}</div>`;
    items.forEach(item => {
      html += `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--sand)">
        <div style="flex:1"><div style="font-size:14px;font-weight:600">${escapeHtml(item.name)}</div>
        ${item.store?`<div style="font-size:11px;color:var(--muted)">${escapeHtml(item.store)}</div>`:""}
        ${item.recipeTitle?`<div style="font-size:10px;color:var(--muted);font-style:italic">${escapeHtml(item.recipeTitle)}</div>`:""}</div>
        ${item.price?`<span style="font-weight:700;color:var(--orange);font-size:13px;white-space:nowrap">$${escapeHtml(String(item.price).replace(/^\$/,""))}</span>`:""}
        <button onclick="slRemoveItem(${item.id})" style="background:none;border:none;cursor:pointer;font-size:16px;color:#ccc;padding:4px">✕</button></div>`;
    });
    html += `</div>`;
  }
  body.innerHTML = html;
}
function getListAsText() {
  let text = "Shopping List\n" + "=".repeat(30) + "\n";
  state.shoppingList.forEach(i => { text += `[ ] ${i.name}${i.price ? " - $" + String(i.price).replace(/^\$/,"") : ""}${i.store ? " (" + i.store + ")" : ""}\n`; });
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
async function addListToKrogerCart() {
  if (!state.selectedBrands.includes("Kroger")) { window.location.href = "/auth/kroger"; return; }
  let session; try { const r = await sb.auth.getSession(); session = r.data?.session; } catch(e) { showToast("Sign in first"); return; }
  if (!session) { showToast("Sign in to add to cart"); window.location.href = "/profile.html"; return; }
  const upcSet = new Set(); const items = [];
  for (const item of state.shoppingList) {
    if (item.upc && !upcSet.has(item.upc)) { upcSet.add(item.upc); items.push({ upc: item.upc, quantity: 1 }); continue; }
    const match = state.deals.find(d => d.upc && d.source === "kroger" && d.name.toLowerCase().includes((item.name||"").toLowerCase().split(" ").filter(w=>w.length>3)[0]||"NOMATCH"));
    if (match?.upc && !upcSet.has(match.upc)) { upcSet.add(match.upc); items.push({ upc: match.upc, quantity: 1 }); }
  }
  if (!items.length) { showToast("No matching Kroger products found for these items"); return; }
  try {
    const res = await fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ items }) });
    if (res.ok) showToast(`Added ${items.length} of ${state.shoppingList.length} items to Kroger cart!`, "success");
    else throw new Error("Cart error");
  } catch(e) { showToast("Could not add to cart — connect Kroger in profile"); }
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
