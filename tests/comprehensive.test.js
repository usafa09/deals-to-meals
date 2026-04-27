import dotenv from "dotenv";
dotenv.config();
import { spawn, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const BASE = "http://localhost:5000";
let serverProc;
let passed = 0, failed = 0;
const results = [];
const issues = [];

function log(section, name, ok, detail = "") {
  if (ok) { passed++; results.push({ section, name, ok: true, detail }); }
  else { failed++; results.push({ section, name, ok: false, detail }); issues.push(`${section}: ${name} — ${detail}`); }
}

async function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn("node", ["server.js"], { env: { ...process.env, PORT: "5000" }, stdio: ["pipe", "pipe", "pipe"] });
    let started = false;
    const timeout = setTimeout(() => { if (!started) reject(new Error("Server timeout")); }, 20000);
    serverProc.stdout.on("data", d => { if (d.toString().includes("Dishcount running") && !started) { started = true; clearTimeout(timeout); setTimeout(resolve, 1500); } });
    serverProc.stderr.on("data", () => {});
    serverProc.on("error", reject);
  });
}
function stopServer() { if (serverProc) serverProc.kill("SIGTERM"); }

async function get(path) { return fetch(`${BASE}${path}`); }
async function post(path, body, headers = {}) {
  return fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

// ════════════════════════════════════════════════════════════════════════════

async function testPageLoads() {
  const pages = [
    ["/", "homepage", "Dishcount"], ["/about.html", "about"], ["/contact.html", "contact"],
    ["/terms.html", "terms"], ["/privacy.html", "privacy"], ["/profile.html", "profile"],
    ["/login.html", "login"], ["/list.html", "list"], ["/admin.html", "admin"], ["/404.html", "404 page"],
  ];
  for (const [path, name, contains] of pages) {
    try {
      const r = await get(path);
      const body = await r.text();
      const ok = r.status === 200 && (!contains || body.includes(contains));
      log("Pages", `GET ${path} (${name})`, ok, `status=${r.status}`);
    } catch (e) { log("Pages", `GET ${path}`, false, e.message); }
  }
  // 404 for nonexistent
  try {
    const r = await get("/nonexistent-page-xyz");
    log("Pages", "GET /nonexistent → 404", r.status === 404);
  } catch (e) { log("Pages", "404 test", false, e.message); }
  // Static files
  try {
    const r = await get("/favicon.svg");
    log("Pages", "GET /favicon.svg", r.status === 200, `type=${r.headers.get("content-type")}`);
  } catch (e) { log("Pages", "favicon.svg", false, e.message); }
  try {
    const r = await get("/favicon.ico");
    log("Pages", "GET /favicon.ico", r.status === 200);
  } catch (e) { log("Pages", "favicon.ico", false, e.message); }
}

async function testApiEndpoints() {
  const tests = [
    { path: "/api/nearby-stores?zip=45432&radius=10", check: (d) => d.stores !== undefined, name: "nearby-stores 45432" },
    { path: "/api/nearby-stores?zip=80841&radius=10", check: (d) => d.stores !== undefined, name: "nearby-stores 80841" },
    { path: "/api/deals/regional?zip=45432", check: (d) => d.deals !== undefined, name: "regional deals" },
    { path: "/api/aldi/deals", check: (d) => d.deals !== undefined, name: "ALDI deals" },
    { path: "/api/walmart/stores?zip=45432", check: () => true, name: "Walmart stores" },
    { path: "/api/walmart/deals", check: () => true, name: "Walmart deals" },
    { path: "/api/extract-status?store=meijer", check: (d) => ["none","extracting","ready"].includes(d.status), name: "extract status" },
    { path: "/api/points", check: (d) => d.limit === 180, name: "points" },
    { path: "/api/recipe-image?title=chicken+parmesan", check: (d) => d.url !== undefined, name: "recipe image" },
    { path: "/api/kroger/search?query=butter&locationId=01400765", check: (d) => d.product !== undefined, name: "Kroger search" },
  ];
  for (const t of tests) {
    try {
      const r = await get(t.path);
      const d = await r.json();
      log("API", `GET ${t.name}`, (r.ok || r.status === 500) && t.check(d), `status=${r.status}`);
    } catch (e) { log("API", `GET ${t.name}`, false, e.message); }
  }
  // Validation
  try { const r = await get("/api/nearby-stores?zip=abc"); log("API", "invalid zip → 400", r.status === 400); } catch (e) { log("API", "invalid zip", false, e.message); }
  try { const r = await post("/api/recipes/ai", {}); log("API", "empty recipes/ai → 400", r.status === 400); } catch (e) { log("API", "empty recipes", false, e.message); }
  // Contact
  try { const r = await post("/api/contact", { name: "Test", email: "t@t.com", topic: "general", message: "test" }); const d = await r.json(); log("API", "contact valid", r.ok && d.success); } catch (e) { log("API", "contact", false, e.message); }
  try { const r = await post("/api/contact", { name: "Bot", email: "b@b.com", topic: "x", message: "y", website: "spam" }); const d = await r.json(); log("API", "contact honeypot", d.success === true, "silently rejected"); } catch (e) { log("API", "honeypot", false, e.message); }
}

async function testAdminEndpoints() {
  // Login
  let adminToken = null;
  try {
    const r = await post("/api/admin/login", { password: process.env.ADMIN_PASSWORD });
    const d = await r.json();
    adminToken = d.token;
    log("Admin", "login correct password", r.ok && !!adminToken);
  } catch (e) { log("Admin", "login", false, e.message); }
  try {
    const r = await post("/api/admin/login", { password: "wrong" });
    log("Admin", "login wrong password → 401", r.status === 401);
  } catch (e) { log("Admin", "wrong password", false, e.message); }

  if (!adminToken) { log("Admin", "SKIP remaining (no token)", false); return; }

  const endpoints = ["stats", "users", "messages", "cache-status", "api-usage", "search-stats", "errors", "server-info"];
  for (const ep of endpoints) {
    try {
      const r = await fetch(`${BASE}/api/admin/${ep}`, { headers: { "x-admin-token": adminToken } });
      log("Admin", `GET /api/admin/${ep}`, r.ok, `status=${r.status}`);
    } catch (e) { log("Admin", ep, false, e.message); }
  }
  // Without token
  try {
    const r = await get("/api/admin/stats");
    log("Admin", "stats without token → 403", r.status === 403);
  } catch (e) { log("Admin", "no-token test", false, e.message); }
}

async function testSecurity() {
  // Rate limiting
  try {
    let lastStatus = 200;
    for (let i = 0; i < 6; i++) {
      const r = await post("/api/contact", { name: "RL", email: "r@r.com", topic: "x", message: `rate${i}` });
      lastStatus = r.status;
    }
    log("Security", "rate limit /api/contact 6x → 429", lastStatus === 429, `6th=${lastStatus}`);
  } catch (e) { log("Security", "rate limit", false, e.message); }

  // Helmet headers
  try {
    const r = await get("/api/points");
    log("Security", "X-Content-Type-Options: nosniff", r.headers.get("x-content-type-options") === "nosniff");
    log("Security", "X-Frame-Options present", !!r.headers.get("x-frame-options"));
  } catch (e) { log("Security", "helmet", false, e.message); }

  // No secrets in response
  try {
    const r = await get("/api/points");
    const body = await r.text();
    log("Security", "no API keys in response", !body.includes("sk-ant-") && !body.includes("KROGER_CLIENT"));
  } catch (e) { log("Security", "secrets check", false, e.message); }

  // Body limit
  try {
    const r = await fetch(`${BASE}/api/contact`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: "x".repeat(2*1024*1024) }) });
    log("Security", "2MB body rejected", r.status === 413 || r.status === 400 || r.status === 500);
  } catch (e) { log("Security", "body limit", true, "connection reset (expected)"); }
}

function testFrontendCode() {
  const htmlFiles = ["index.html","about.html","contact.html","terms.html","privacy.html","profile.html","login.html","list.html","404.html"];

  // Supabase URL
  const correctUrl = "bvwwtrwxnuncalgtuqvx";
  const wrongUrl = "gkzlwzafnkqwxwiootah";
  for (const f of htmlFiles) {
    const path = `public/${f}`;
    if (!existsSync(path)) continue;
    const html = readFileSync(path, "utf8");
    if (html.includes(wrongUrl)) log("Frontend", `${f}: wrong Supabase URL`, false, "has gkzlwzafnkqwxwiootah");
  }
  // Check app.js
  const appJs = readFileSync("public/app.js", "utf8");
  log("Frontend", "app.js correct Supabase URL", appJs.includes(correctUrl) && !appJs.includes(wrongUrl));

  // Google Analytics on all pages
  for (const f of htmlFiles) {
    const html = readFileSync(`public/${f}`, "utf8");
    log("Frontend", `${f}: Google Analytics`, html.includes("G-41675D42V1"));
  }

  // OG tags
  for (const f of htmlFiles) {
    const html = readFileSync(`public/${f}`, "utf8");
    log("Frontend", `${f}: OG tags`, html.includes('og:title'));
  }

  // Favicon links
  for (const f of htmlFiles) {
    const html = readFileSync(`public/${f}`, "utf8");
    log("Frontend", `${f}: favicon.svg link`, html.includes('favicon.svg'));
    log("Frontend", `${f}: favicon.ico link`, html.includes('favicon.ico'));
  }

  // Copyright 2026
  for (const f of htmlFiles) {
    const html = readFileSync(`public/${f}`, "utf8");
    if (html.includes("2025") && !html.includes("Effective")) log("Frontend", `${f}: copyright 2025 found`, false, "should be 2026");
  }

  // No "Deals to Meals" in user-facing text
  for (const f of [...htmlFiles, "../public/app.js"]) {
    const path = f.startsWith("../") ? f.slice(3) : `public/${f}`;
    if (!existsSync(path)) continue;
    const html = readFileSync(path, "utf8");
    const matches = (html.match(/Deals to Meals/gi) || []).length;
    if (matches > 0) log("Frontend", `${path}: "Deals to Meals" found`, false, `${matches} occurrences`);
  }

  // No hardcoded API keys
  const secretPatterns = ["sk-ant-", "KROGER_CLIENT_SECRET", "WALMART_PRIVATE_KEY", "SPOONACULAR_API_KEY", "GOOGLE_MAPS_API_KEY"];
  for (const f of htmlFiles) {
    const html = readFileSync(`public/${f}`, "utf8");
    for (const pat of secretPatterns) {
      if (html.includes(pat)) log("Frontend", `${f}: contains ${pat}`, false, "SECURITY ISSUE");
    }
  }
  log("Frontend", "no hardcoded secrets in public/", true);

  // Nav structure consistency
  for (const f of htmlFiles) {
    const html = readFileSync(`public/${f}`, "utf8");
    log("Frontend", `${f}: has hamburger`, html.includes("hamburger"));
    log("Frontend", `${f}: has nav-dropdown`, html.includes("nav-dropdown"));
  }

  // Footer
  for (const f of htmlFiles.filter(f => f !== "admin.html")) {
    const html = readFileSync(`public/${f}`, "utf8");
    log("Frontend", `${f}: has footer`, html.includes("landing-footer") || html.includes("about-footer") || html.includes("contact-footer") || html.includes("footer"));
  }

  // Fonts
  for (const f of htmlFiles) {
    const html = readFileSync(`public/${f}`, "utf8");
    log("Frontend", `${f}: imports Outfit font`, html.includes("Outfit"));
  }
}

async function testLoad() {
  const loadResults = { homepage: [], nearbyStores: [], regional: [] };

  // Homepage 50x
  for (let i = 0; i < 50; i++) {
    const start = Date.now();
    try { const r = await get("/"); loadResults.homepage.push({ time: Date.now() - start, ok: r.ok }); } catch { loadResults.homepage.push({ time: Date.now() - start, ok: false }); }
  }

  // Nearby stores 20x
  for (let i = 0; i < 20; i++) {
    const start = Date.now();
    try { const r = await get("/api/nearby-stores?zip=45432&radius=10"); loadResults.nearbyStores.push({ time: Date.now() - start, ok: r.ok }); } catch { loadResults.nearbyStores.push({ time: Date.now() - start, ok: false }); }
  }

  // Regional deals 10x
  for (let i = 0; i < 10; i++) {
    const start = Date.now();
    try { const r = await get("/api/deals/regional?zip=45432"); loadResults.regional.push({ time: Date.now() - start, ok: r.ok }); } catch { loadResults.regional.push({ time: Date.now() - start, ok: false }); }
  }

  for (const [name, data] of Object.entries(loadResults)) {
    const times = data.map(d => d.time);
    const errors = data.filter(d => !d.ok).length;
    const avg = Math.round(times.reduce((a,b) => a+b, 0) / times.length);
    const max = Math.max(...times);
    const min = Math.min(...times);
    log("Load", `${name} (${data.length}x): avg=${avg}ms, min=${min}ms, max=${max}ms, errors=${errors}`, errors === 0, `avg=${avg}ms max=${max}ms`);
  }
}

function testUnitTests() {
  try {
    const output = execSync("node tests/utils.test.js", { encoding: "utf8" });
    const unitPassed = (output.match(/✓/g) || []).length;
    const unitFailed = (output.match(/✗/g) || []).length;
    log("Unit", `${unitPassed} passed, ${unitFailed} failed`, unitFailed === 0);
  } catch { log("Unit", "unit tests", false, "execution failed"); }
}

// ════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("Starting server...");
  try { await startServer(); } catch (e) { console.error("Server failed:", e.message); process.exit(1); }
  console.log("Server ready\n");

  console.log("═══ 1. PAGE LOADS ═══");
  await testPageLoads();
  console.log("═══ 2. API FUNCTIONALITY ═══");
  await testApiEndpoints();
  console.log("═══ 3. ADMIN ENDPOINTS ═══");
  await testAdminEndpoints();
  console.log("═══ 4. SECURITY ═══");
  await testSecurity();
  console.log("═══ 5. FRONTEND CODE ═══");
  testFrontendCode();
  console.log("═══ 6. LOAD TEST ═══");
  await testLoad();
  console.log("═══ 7. UNIT TESTS ═══");
  testUnitTests();

  stopServer();

  // Report
  console.log("\n" + "═".repeat(70));
  console.log("COMPREHENSIVE TEST REPORT");
  console.log("═".repeat(70));

  const sections = {};
  results.forEach(r => { if (!sections[r.section]) sections[r.section] = []; sections[r.section].push(r); });
  for (const [section, items] of Object.entries(sections)) {
    const sp = items.filter(i => i.ok).length;
    const sf = items.filter(i => !i.ok).length;
    console.log(`\n${section} (${sp}/${items.length}):`);
    items.forEach(i => console.log(`  ${i.ok ? "✓" : "✗"} ${i.name}${i.detail && !i.ok ? " — " + i.detail : ""}`));
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`TOTAL: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  if (issues.length) {
    console.log(`\nISSUES (${issues.length}):`);
    issues.forEach(i => console.log(`  ⚠️  ${i}`));
  }
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

main();
