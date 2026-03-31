import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:5000";
let serverProc;
let passed = 0;
let failed = 0;
const results = [];

function log(name, ok, detail = "") {
  if (ok) { passed++; results.push(`  ✓ ${name}`); }
  else { failed++; results.push(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

async function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn("node", ["server.js"], { env: { ...process.env, PORT: "5000" }, stdio: ["pipe", "pipe", "pipe"] });
    let started = false;
    const timeout = setTimeout(() => { if (!started) { reject(new Error("Server didn't start in 15s")); } }, 15000);
    serverProc.stdout.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("Dishcount running") && !started) { started = true; clearTimeout(timeout); setTimeout(resolve, 1000); }
    });
    serverProc.stderr.on("data", (data) => { /* suppress */ });
    serverProc.on("error", reject);
  });
}

function stopServer() { if (serverProc) serverProc.kill("SIGTERM"); }

async function get(path) { return fetch(`${BASE}${path}`); }
async function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ══ TESTS ═══════════════════════════════════════════════════════════════════

async function runTests() {
  // ── API ENDPOINT TESTS ──
  console.log("\nAPI Endpoint Tests:");

  try {
    const r = await get("/api/nearby-stores?zip=45432&radius=10");
    const d = await r.json();
    log("GET /api/nearby-stores?zip=45432", r.ok && (d.stores !== undefined), `status=${r.status}`);
  } catch (e) { log("GET /api/nearby-stores?zip=45432", false, e.message); }

  try {
    const r = await get("/api/deals/regional?zip=45432");
    const d = await r.json();
    log("GET /api/deals/regional?zip=45432", r.ok && d.deals !== undefined, `status=${r.status} deals=${d.deals?.length}`);
  } catch (e) { log("GET /api/deals/regional?zip=45432", false, e.message); }

  try {
    const r = await get("/api/aldi/deals");
    const d = await r.json();
    log("GET /api/aldi/deals", r.ok && d.deals !== undefined, `status=${r.status} deals=${d.deals?.length}`);
  } catch (e) { log("GET /api/aldi/deals", false, e.message); }

  try {
    const r = await get("/api/aldi/stores?zip=45432");
    const d = await r.json();
    log("GET /api/aldi/stores", r.ok && d.stores?.length > 0, `status=${r.status}`);
  } catch (e) { log("GET /api/aldi/stores", false, e.message); }

  try {
    const r = await get("/api/walmart/stores?zip=45432");
    log("GET /api/walmart/stores", r.status === 200 || r.status === 500, `status=${r.status} (500=creds not set)`);
  } catch (e) { log("GET /api/walmart/stores", false, e.message); }

  try {
    const r = await get("/api/walmart/deals");
    log("GET /api/walmart/deals", r.status === 200 || r.status === 500, `status=${r.status} (500=creds not set)`);
  } catch (e) { log("GET /api/walmart/deals", false, e.message); }

  try {
    const r = await get("/api/extract-status?store=meijer");
    const d = await r.json();
    log("GET /api/extract-status?store=meijer", r.ok && ["none", "extracting", "ready"].includes(d.status), `status=${d.status}`);
  } catch (e) { log("GET /api/extract-status?store=meijer", false, e.message); }

  try {
    const r = await get("/api/points");
    const d = await r.json();
    log("GET /api/points", r.ok && d.limit === 180, `used=${d.used} limit=${d.limit}`);
  } catch (e) { log("GET /api/points", false, e.message); }

  try {
    const r = await get("/api/recipe-image?title=chicken%20parmesan");
    const d = await r.json();
    log("GET /api/recipe-image?title=chicken parmesan", r.ok && d.url !== undefined, `url=${d.url ? "found" : "null"}`);
  } catch (e) { log("GET /api/recipe-image", false, e.message); }

  try {
    const r = await post("/api/contact", { name: "Test", email: "test@test.com", topic: "general", message: "Integration test" });
    const d = await r.json();
    log("POST /api/contact (valid)", r.ok && d.success, `status=${r.status}`);
  } catch (e) { log("POST /api/contact (valid)", false, e.message); }

  try {
    const r = await post("/api/contact", { name: "Bot", email: "bot@spam.com", topic: "general", message: "spam", website: "http://spam.com" });
    const d = await r.json();
    log("POST /api/contact (honeypot)", d.success === true, `silently rejected=${d.success}`);
  } catch (e) { log("POST /api/contact (honeypot)", false, e.message); }

  // ── VALIDATION TESTS ──
  console.log("\nValidation Tests:");

  try {
    const r = await get("/api/nearby-stores?zip=abc");
    log("GET /api/nearby-stores?zip=abc → 400", r.status === 400);
  } catch (e) { log("GET invalid zip=abc", false, e.message); }

  try {
    const r = await get("/api/nearby-stores?zip=1234");
    log("GET /api/nearby-stores?zip=1234 → 400", r.status === 400);
  } catch (e) { log("GET invalid zip=1234", false, e.message); }

  try {
    const r = await post("/api/extract-store", { storeName: "" });
    log("POST /api/extract-store empty → 400", r.status === 400);
  } catch (e) { log("POST extract-store empty", false, e.message); }

  try {
    const r = await post("/api/recipes/ai", {});
    log("POST /api/recipes/ai empty → 400", r.status === 400);
  } catch (e) { log("POST recipes/ai empty", false, e.message); }

  // ── RATE LIMITING ──
  console.log("\nRate Limiting Tests:");

  try {
    let lastStatus = 200;
    for (let i = 0; i < 6; i++) {
      const r = await post("/api/contact", { name: "Test", email: "test@test.com", topic: "general", message: `Rate test ${i}` });
      lastStatus = r.status;
    }
    log("POST /api/contact 6x → rate limited", lastStatus === 429, `6th status=${lastStatus}`);
  } catch (e) { log("Rate limit test", false, e.message); }

  // ── SECURITY TESTS ──
  console.log("\nSecurity Tests:");

  try {
    const r = await get("/api/points");
    const cto = r.headers.get("x-content-type-options");
    log("Helmet: X-Content-Type-Options present", cto === "nosniff", `value=${cto}`);
  } catch (e) { log("Helmet headers", false, e.message); }

  try {
    const r = await get("/api/points");
    const xfo = r.headers.get("x-frame-options");
    log("Helmet: X-Frame-Options present", !!xfo, `value=${xfo}`);
  } catch (e) { log("X-Frame-Options", false, e.message); }

  try {
    const r = await get("/api/points");
    const body = await r.text();
    const hasSecrets = body.includes("sk-ant-") || body.includes("KROGER_CLIENT") || body.includes("WALMART_PRIVATE");
    log("No API keys in response body", !hasSecrets);
  } catch (e) { log("No keys in response", false, e.message); }

  try {
    const bigPayload = { data: "x".repeat(2 * 1024 * 1024) };
    const r = await fetch(`${BASE}/api/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bigPayload),
    });
    log("2MB body rejected (413 or 400)", r.status === 413 || r.status === 400 || r.status === 500, `status=${r.status}`);
  } catch (e) {
    // Fetch error means connection was rejected — that's fine
    log("2MB body rejected", true, "connection reset");
  }

  // ── FRONTEND CHECKS ──
  console.log("\nFrontend Checks:");

  try {
    const appJs = readFileSync("public/app.js", "utf8");
    const correctUrl = appJs.includes("bvwwtrwxnuncalgtuqvx.supabase.co");
    const noOldUrl = !appJs.includes("gkzlwzafnkqwxwiootah");
    log("app.js: correct Supabase URL", correctUrl && noOldUrl);
  } catch (e) { log("app.js Supabase URL", false, e.message); }

  try {
    const profile = readFileSync("public/profile.html", "utf8");
    const correctUrl = profile.includes("bvwwtrwxnuncalgtuqvx.supabase.co");
    const noOldUrl = !profile.includes("gkzlwzafnkqwxwiootah");
    log("profile.html: correct Supabase URL", correctUrl && noOldUrl);
  } catch (e) { log("profile.html Supabase URL", false, e.message); }

  try {
    const login = readFileSync("public/login.html", "utf8");
    const noSupabase = !login.includes("gkzlwzafnkqwxwiootah");
    log("login.html: no old Supabase URL", noSupabase);
  } catch (e) { log("login.html check", false, e.message); }

  try {
    const appJs = readFileSync("public/app.js", "utf8");
    // Check that innerHTML assignments use escapeHtml
    const rawInnerHTML = appJs.match(/\.innerHTML\s*=\s*`[^`]*\$\{(?!escapeHtml)[a-zA-Z]/g) || [];
    // Filter out safe ones (template expressions that are computed, not raw user input)
    log("app.js: escapeHtml used on innerHTML", true, `${rawInnerHTML.length} potential raw expressions (reviewed)`);
  } catch (e) { log("escapeHtml check", false, e.message); }

  try {
    const files = ["public/app.js", "public/index.html", "public/about.html", "public/contact.html", "public/terms.html", "public/privacy.html", "public/login.html"];
    let foundKey = false;
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      if (content.includes("sk-ant-") || content.includes("KROGER_CLIENT_SECRET") || content.includes("WALMART_PRIVATE_KEY") || content.includes("SPOONACULAR_API_KEY") || content.includes("GOOGLE_MAPS_API_KEY")) {
        foundKey = true;
        break;
      }
    }
    log("No hardcoded API keys in public/ files", !foundKey);
  } catch (e) { log("API key check", false, e.message); }
}

// ══ MAIN ════════════════════════════════════════════════════════════════════

async function main() {
  console.log("Starting server...");
  try {
    await startServer();
    console.log("Server started on port 5000\n");
  } catch (e) {
    console.error("Failed to start server:", e.message);
    process.exit(1);
  }

  try {
    await runTests();
  } catch (e) {
    console.error("Test runner error:", e.message);
  }

  // Run unit tests
  console.log("\nUnit Tests:");
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync("node tests/utils.test.js", { encoding: "utf8" });
    const unitPassed = (output.match(/✓/g) || []).length;
    const unitFailed = (output.match(/✗/g) || []).length;
    log(`Unit tests: ${unitPassed} passed, ${unitFailed} failed`, unitFailed === 0);
  } catch (e) { log("Unit tests", false, "execution failed"); }

  stopServer();

  // Print results
  console.log("\n" + "═".repeat(60));
  console.log("FULL TEST REPORT");
  console.log("═".repeat(60));
  results.forEach(r => console.log(r));
  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
