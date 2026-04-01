import dotenv from "dotenv";
dotenv.config();
import { spawn } from "node:child_process";

const BASE = "http://localhost:5000";
let serverProc;

async function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn("node", ["server.js"], { env: { ...process.env, PORT: "5000" }, stdio: ["pipe", "pipe", "pipe"] });
    let started = false;
    const timeout = setTimeout(() => { if (!started) reject(new Error("timeout")); }, 20000);
    serverProc.stdout.on("data", d => { if (d.toString().includes("Dishcount running") && !started) { started = true; clearTimeout(timeout); setTimeout(resolve, 1500); } });
    serverProc.on("error", reject);
  });
}

async function get(path) { return fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(30000) }); }

const ZIPS = [
  { zip: "45432", city: "Dayton, OH", expect: "Kroger" },
  { zip: "80841", city: "Colorado Springs, CO", expect: "King Soopers" },
  { zip: "10001", city: "New York, NY", expect: "diverse" },
  { zip: "90210", city: "Beverly Hills, CA", expect: "Ralphs" },
  { zip: "60601", city: "Chicago, IL", expect: "Mariano's" },
  { zip: "77001", city: "Houston, TX", expect: "Kroger/H-E-B" },
  { zip: "30301", city: "Atlanta, GA", expect: "Kroger/Publix" },
  { zip: "98101", city: "Seattle, WA", expect: "Fred Meyer/QFC" },
  { zip: "48201", city: "Detroit, MI", expect: "Kroger/Meijer" },
  { zip: "33101", city: "Miami, FL", expect: "Publix" },
  { zip: "85001", city: "Phoenix, AZ", expect: "Fry's" },
  { zip: "97201", city: "Portland, OR", expect: "Fred Meyer" },
  { zip: "55401", city: "Minneapolis, MN", expect: "Hy-Vee" },
  { zip: "27601", city: "Raleigh, NC", expect: "Harris Teeter" },
  { zip: "84101", city: "Salt Lake City, UT", expect: "Smith's" },
  { zip: "53201", city: "Milwaukee, WI", expect: "Pick 'n Save" },
  { zip: "66101", city: "Kansas City, KS", expect: "Dillons" },
  { zip: "32801", city: "Orlando, FL", expect: "Publix" },
  { zip: "15201", city: "Pittsburgh, PA", expect: "Giant Eagle" },
  { zip: "23220", city: "Richmond, VA", expect: "Food Lion" },
];

const KROGER_FAMILY_NORM = new Set(["kroger","ralphs","fredmeyer","frys","frysfood","harristeeter","kingsoopers","smiths","qfc","marianos","picksave","metromarket","dillons","bakers","payless","gerbes","jayc","food4less","foodsco","owens","citymarket"]);
function isKF(name) { return KROGER_FAMILY_NORM.has((name||"").toLowerCase().replace(/['\s\-]/g,"")); }

async function main() {
  console.log("Starting server...");
  try { await startServer(); } catch(e) { console.error("Server failed:", e.message); process.exit(1); }
  console.log("Server ready\n");

  const results = [];
  const allStoreNames = new Set();
  const krogerLocationIds = {};
  let totalDeals = 0;

  // ═══ ZIP CODE TESTS ═══
  console.log("═".repeat(80));
  console.log("STORE SEARCH & DEAL COVERAGE TEST");
  console.log("═".repeat(80));

  for (const z of ZIPS) {
    process.stdout.write(`\n${z.zip} ${z.city}... `);
    const row = { zip: z.zip, city: z.city, expect: z.expect, storeCount: 0, stores: [], krogerFamily: [], deals: 0, status: "OK" };
    try {
      const r = await get(`/api/nearby-stores?zip=${z.zip}&radius=10`);
      const d = await r.json();
      const stores = d.stores || [];
      row.storeCount = stores.length;
      row.stores = stores.map(s => s.name);
      row.krogerFamily = stores.filter(s => isKF(s.name)).map(s => s.name);
      stores.forEach(s => allStoreNames.add(s.name));

      // Find a Kroger location for deals test
      if (row.krogerFamily.length > 0) {
        try {
          const kr = await get(`/api/stores?zip=${z.zip}`);
          const kd = await kr.json();
          if (kd.stores?.[0]?.id) {
            krogerLocationIds[z.zip] = kd.stores[0].id;
          }
        } catch(e) {}
      }

      // Fetch regional deals
      const locId = krogerLocationIds[z.zip] || "";
      try {
        const dr = await get(`/api/deals/regional?zip=${z.zip}${locId ? "&locationId=" + locId : ""}`);
        const dd = await dr.json();
        row.deals = dd.totalDeals || 0;
        totalDeals += row.deals;
      } catch(e) { row.deals = -1; }

      console.log(`${stores.length} stores, ${row.krogerFamily.length} Kroger-family, ${row.deals} deals`);
    } catch(e) {
      row.status = "ERROR: " + e.message;
      console.log("ERROR: " + e.message);
    }
    results.push(row);
  }

  // ═══ ALDI & WALMART ═══
  console.log("\n─── ALDI ───");
  try {
    const r = await get("/api/aldi/deals");
    const d = await r.json();
    console.log(`ALDI deals: ${d.deals?.length || 0}`);
  } catch(e) { console.log("ALDI error:", e.message); }

  console.log("\n─── Walmart ───");
  try {
    const r = await get("/api/walmart/deals");
    const d = await r.json();
    console.log(`Walmart deals: ${d.deals?.length || 0}`);
  } catch(e) { console.log("Walmart error:", e.message); }

  // ═══ EDGE CASES ═══
  console.log("\n─── Edge Cases ───");
  const edges = [
    { path: "/api/nearby-stores?zip=00000&radius=10", expect: "400 or empty" },
    { path: "/api/nearby-stores?zip=99999&radius=10", expect: "200 maybe empty" },
    { path: "/api/nearby-stores?zip=4 5 4 3 2&radius=10", expect: "400" },
    { path: "/api/nearby-stores?zip=&radius=10", expect: "400" },
    { path: "/api/nearby-stores?zip=45432&radius=100", expect: "200" },
    { path: "/api/nearby-stores?zip=45432&radius=1", expect: "200 maybe few" },
  ];
  for (const e of edges) {
    try {
      const r = await get(e.path);
      const d = await r.json();
      console.log(`  ${e.path.split("?")[1]}: status=${r.status} stores=${d.stores?.length ?? "N/A"} (expected: ${e.expect})`);
    } catch(er) { console.log(`  ${e.path}: ERROR ${er.message}`); }
  }

  // ═══ DEAL QUALITY ═══
  console.log("\n─── Deal Quality Check (45432) ───");
  try {
    const locId = krogerLocationIds["45432"] || "";
    const r = await get(`/api/deals/regional?zip=45432${locId ? "&locationId=" + locId : ""}`);
    const d = await r.json();
    const deals = d.deals || [];
    const names = deals.map(d => d.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    const prices = deals.map(d => parseFloat(String(d.salePrice).replace(/[^0-9.]/g, ""))).filter(p => p > 0);
    const cats = {};
    deals.forEach(d => { const c = d.category || "Other"; cats[c] = (cats[c]||0)+1; });
    const noName = deals.filter(d => !d.name || d.name.trim() === "").length;
    const noPrice = deals.filter(d => !d.salePrice).length;
    const badPrice = deals.filter(d => { const p = parseFloat(String(d.salePrice).replace(/[^0-9.]/g,"")); return p === 0 || p > 500; }).length;

    console.log(`  Total deals: ${deals.length}`);
    console.log(`  Sources: ${(d.sources||[]).map(s => `${s.store}(${s.deals})`).join(", ")}`);
    console.log(`  Duplicates: ${dupes.length}`);
    console.log(`  Missing name: ${noName}`);
    console.log(`  Missing price: ${noPrice}`);
    console.log(`  Bad price ($0 or >$500): ${badPrice}`);
    if (prices.length) console.log(`  Price range: $${Math.min(...prices).toFixed(2)} – $${Math.max(...prices).toFixed(2)}`);
    console.log(`  Categories: ${Object.entries(cats).sort((a,b) => b[1]-a[1]).slice(0,8).map(([k,v]) => `${k}(${v})`).join(", ")}`);
  } catch(e) { console.log("  Error:", e.message); }

  // ═══ SUMMARY ═══
  console.log("\n" + "═".repeat(80));
  console.log("SUMMARY REPORT");
  console.log("═".repeat(80));

  console.log("\n┌─────────┬──────────────────────────┬────────┬─────────────┬───────┬────────┐");
  console.log("│ ZIP     │ City                     │ Stores │ Kroger Fam  │ Deals │ Status │");
  console.log("├─────────┼──────────────────────────┼────────┼─────────────┼───────┼────────┤");
  for (const r of results) {
    const city = r.city.padEnd(24).slice(0,24);
    const kf = (r.krogerFamily[0] || "—").padEnd(11).slice(0,11);
    console.log(`│ ${r.zip}   │ ${city} │ ${String(r.storeCount).padStart(6)} │ ${kf} │ ${String(r.deals).padStart(5)} │ ${r.status.slice(0,6).padEnd(6)} │`);
  }
  console.log("└─────────┴──────────────────────────┴────────┴─────────────┴───────┴────────┘");

  console.log(`\nTotal unique store brands discovered: ${allStoreNames.size}`);
  console.log(`All store brands: ${[...allStoreNames].sort().join(", ")}`);
  console.log(`Total deals across all zips: ${totalDeals}`);

  const withDeals = results.filter(r => r.deals > 0).length;
  const withKroger = results.filter(r => r.krogerFamily.length > 0).length;
  console.log(`\nZips with deals: ${withDeals}/${results.length}`);
  console.log(`Zips with Kroger-family stores: ${withKroger}/${results.length}`);

  if (serverProc) serverProc.kill("SIGTERM");
}

main().catch(e => { console.error(e); if (serverProc) serverProc.kill("SIGTERM"); });
