import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

import { initStoresWithDealsCache, getCachedDeals } from "./lib/utils.js";

import authRoutes from "./routes/auth.js";
import krogerRoutes from "./routes/kroger.js";
import walmartRoutes from "./routes/walmart.js";
import aldiRoutes from "./routes/aldi.js";
import recipesRoutes from "./routes/recipes.js";
import storesRoutes, { SSR_CHAINS } from "./routes/stores.js";
import adminRoutes from "./routes/admin.js";
import gamificationRoutes from "./routes/gamification.js";
import newsletterRoutes from "./routes/newsletter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Asset version for cache busting (captured once at startup) ─────────────
const ASSET_VERSION = (() => {
  if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT.slice(0, 8);
  if (process.env.GIT_SHA) return process.env.GIT_SHA.slice(0, 8);
  try {
    const head = readFileSync(join(__dirname, ".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref: ")) {
      const sha = readFileSync(join(__dirname, ".git", head.slice(5)), "utf8").trim();
      return sha.slice(0, 8);
    }
    return head.slice(0, 8);
  } catch {
    return String(Date.now()).slice(-8);
  }
})();
console.log(`[asset-version] ASSET_VERSION=${ASSET_VERSION}`);

const app = express();
app.set('trust proxy', 1);

// ── Domain redirect: dealstomeals.co → dishcount.co ────────────────────────
app.use((req, res, next) => {
  const host = req.get('host') || '';
  if (host.includes('dealstomeals.co')) {
    return res.redirect(301, 'https://dishcount.co' + req.originalUrl);
  }
  next();
});

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // CSP set manually below
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' },
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://www.googletagmanager.com https://www.google-analytics.com https://connect.facebook.net https://us-assets.i.posthog.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' https: data: blob: https://www.facebook.com",
    "connect-src 'self' https://bvwwtrwxnuncalgtuqvx.supabase.co https://cdn.jsdelivr.net https://api.kroger.com https://www.google-analytics.com https://*.google-analytics.com https://analytics.google.com https://connect.facebook.net https://www.facebook.com https://fonts.googleapis.com https://fonts.gstatic.com https://www.google.com https://us.i.posthog.com https://us-assets.i.posthog.com",
    "frame-src https://www.facebook.com",
    "object-src 'none'",
    "base-uri 'self'"
  ].join('; '));
  next();
});

// ── CORS — restrict to known origins ────────────────────────────────────────
const allowedOrigins = [
  "https://dishcount.co",
  "https://www.dishcount.co",
  "https://dealstomeals.co",
  "https://www.dealstomeals.co",
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, mobile apps)
    if (!origin || allowedOrigins.includes(origin) || origin.includes("localhost")) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
}));

// ── Body parsing with size limits ───────────────────────────────────────────
// Larger limit for image scan endpoints (pantry photos, receipts)
app.use("/api/scan-pantry", express.json({ limit: "20mb" }));
app.use("/api/scan-receipt", express.json({ limit: "20mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ── Rate limiting ───────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in a few minutes." },
});

const expensiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit reached for this action. Please wait before trying again." },
  skip: (req) => {
    // Internal jobs (the weekly GitHub Actions deal refresh) carry a shared secret and
    // bypass the limit. Require BOTH the env var to be set AND the header to match, so a
    // missing env var can never accidentally skip for everyone.
    const internal = req.headers["x-internal-token"];
    if (internal && process.env.INTERNAL_API_TOKEN && internal === process.env.INTERNAL_API_TOKEN) {
      return true;
    }
    // Authenticated users have their own per-user limits in routes/recipes.js
    const auth = req.headers.authorization;
    return !!(auth && auth.startsWith("Bearer ") && auth.length > 20);
  },
});

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many messages sent. Please try again later." },
});

const storeSearchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many store searches. Please try again in a few minutes." },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts. Please try again later." },
});

const subscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many subscribe attempts. Please try again later." },
});

const gamificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Apply rate limits to API routes
app.use("/api/", generalLimiter);
app.use("/api/recipes/ai", expensiveLimiter);
app.use("/api/extract-store", expensiveLimiter);
app.use("/api/extract-ad", expensiveLimiter);
app.use("/api/contact", contactLimiter);
app.use("/api/store-requests", contactLimiter);
app.use("/api/admin/login", authLimiter);
app.use("/api/kroger/search", storeSearchLimiter);
app.use("/api/nearby-stores", storeSearchLimiter);
app.use("/auth/", authLimiter);
app.use("/api/subscribe", subscribeLimiter);
app.use("/api/stats/track", gamificationLimiter);
app.use("/api/plans/share", contactLimiter); // 3/hour — prevent plan spam
app.use("/api/community/recipes", contactLimiter); // 3/hour — prevent submission spam
app.use("/api/recipes/interact", gamificationLimiter); // 30/15min — behavior tracking
app.use("/api/recipes/rate", gamificationLimiter); // 30/15min — rating limit
app.use("/api/scan-pantry", expensiveLimiter); // 10/15min — AI calls
app.use("/api/scan-receipt", expensiveLimiter); // 10/15min — AI calls
app.use("/api/badges", gamificationLimiter);
app.use("/api/leaderboard", gamificationLimiter);
app.use("/api/challenges", gamificationLimiter);

// ── Static files ────────────────────────────────────────────────────────────
// Dynamic sitemap. Non-deal URLs are copied verbatim from public/sitemap.xml
// (kept in the repo as reference — this route no longer reads it). Deal pages
// get a truthful lastmod pulled from the live SSR bundle cache so we never claim
// a fresher date than the deals actually are.
const SITEMAP_STATIC_URLS = [
  { loc: "https://dishcount.co/",                                            lastmod: "2026-04-19", changefreq: "weekly",  priority: "1.0" },
  { loc: "https://dishcount.co/about.html",                                  lastmod: "2026-04-19", changefreq: "monthly", priority: "0.8" },
  { loc: "https://dishcount.co/features.html",                               lastmod: "2026-04-19", changefreq: "monthly", priority: "0.8" },
  { loc: "https://dishcount.co/contact.html",                                lastmod: "2026-04-19", changefreq: "monthly", priority: "0.6" },
  { loc: "https://dishcount.co/terms.html",                                  lastmod: "2026-04-19", changefreq: "monthly", priority: "0.5" },
  { loc: "https://dishcount.co/privacy.html",                                lastmod: "2026-04-19", changefreq: "monthly", priority: "0.5" },
  { loc: "https://dishcount.co/disclosures.html",                            lastmod: "2026-05-07", changefreq: "monthly", priority: "0.5" },
  { loc: "https://dishcount.co/blog/",                                       lastmod: "2026-04-19", changefreq: "weekly",  priority: "0.8" },
  { loc: "https://dishcount.co/blog/why-i-built-dishcount.html",             lastmod: "2026-04-19", changefreq: "monthly", priority: "0.7" },
  { loc: "https://dishcount.co/blog/meal-plan-around-deals.html",            lastmod: "2026-04-19", changefreq: "monthly", priority: "0.7" },
  { loc: "https://dishcount.co/blog/what-to-make-when-chicken-is-on-sale.html", lastmod: "2026-05-05", changefreq: "monthly", priority: "0.7" },
  { loc: "https://dishcount.co/blog/dishcount-vs-flipp.html",                lastmod: "2026-05-05", changefreq: "monthly", priority: "0.7" },
  { loc: "https://dishcount.co/blog/memorial-day-cookout-deals.html",        lastmod: "2026-07-09", changefreq: "monthly", priority: "0.7" },
  { loc: "https://dishcount.co/blog/kroger-weekly-ad-meal-plan.html",        lastmod: "2026-07-17", changefreq: "monthly", priority: "0.8" },
];
app.get('/sitemap.xml', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const chainUrls = [];
  const chainDates = [];
  // Deal URLs are derived from SSR_CHAINS keys so future chains appear automatically.
  for (const slug of Object.keys(SSR_CHAINS)) {
    let lastmod = today;
    try {
      const bundle = await getCachedDeals(`ssr:bundle:${slug}`);
      if (bundle && bundle.generatedAt) lastmod = String(bundle.generatedAt).slice(0, 10);
    } catch { /* bundle missing → fall back to today */ }
    chainDates.push(lastmod);
    chainUrls.push({ loc: `https://dishcount.co/deals/${slug}`, lastmod, changefreq: "weekly", priority: "0.9" });
  }
  // /deals lastmod = the freshest chain date (ISO YYYY-MM-DD sorts lexically).
  const dealsLastmod = chainDates.length ? chainDates.slice().sort().pop() : today;
  const urls = [
    ...SITEMAP_STATIC_URLS,
    { loc: "https://dishcount.co/deals", lastmod: dealsLastmod, changefreq: "weekly", priority: "0.9" },
    ...chainUrls,
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map(u =>
        `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
      ).join("\n")
    + `\n</urlset>\n`;
  res.type('application/xml');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(body);
});
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(join(__dirname, 'public', 'robots.txt'));
});
app.get('/.well-known/security.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(join(__dirname, 'public', '.well-known', 'security.txt'));
});
app.get(['/profile.html', '/admin.html'], (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});
app.get('/login.html', (req, res) => { res.redirect(301, '/profile.html'); });
app.get('/login', (req, res) => { res.redirect(301, '/profile.html'); });
app.get('/tips.html', (req, res) => { res.redirect(301, '/features.html'); });
app.get('/tips-and-features.html', (req, res) => { res.redirect(301, '/features.html'); });
app.get('*.map', (req, res) => { res.status(404).end(); });

// ── HTML version injector — rewrites versioned asset URLs + meta tag ───────
// Must come BEFORE express.static so it intercepts HTML requests.
const PUBLIC_DIR = join(__dirname, "public");
const FRAGMENT_PATHS = new Set(["/app-screens.html", "/header.html"]);
app.get(["/", /\.html$/], (req, res, next) => {
  const reqPath = req.path === "/" ? "/index.html" : req.path;
  const filePath = join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) return next(); // path traversal guard
  let html;
  try {
    html = readFileSync(filePath, "utf8");
  } catch {
    return next(); // file not found → fall through to 404 catch-all
  }
  html = html
    .replace(/(\/app\.min\.js)(?!\?)/g, `$1?v=${ASSET_VERSION}`)
    .replace(/(\/styles\.min\.css)(?!\?)/g, `$1?v=${ASSET_VERSION}`)
    .replace(/<head([^>]*)>/i, `<head$1>\n  <meta name="asset-version" content="${ASSET_VERSION}">`);
  if (!res.getHeader("Cache-Control")) {
    if (FRAGMENT_PATHS.has(req.path)) {
      res.set("Cache-Control", "public, max-age=300, must-revalidate");
    } else {
      res.set("Cache-Control", "no-cache, must-revalidate");
    }
  }
  res.type("html").send(html);
});

app.use(express.static(join(__dirname, "public"), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const ext = filePath.split(".").pop().toLowerCase();
    // Service worker — short cache (browsers also enforce this)
    if (filePath.endsWith("sw.js")) {
      res.setHeader("Cache-Control", "public, max-age=3600, must-revalidate");
    }
    // Versioned bundles — long cache + immutable (URL changes per deploy via ?v=)
    else if (filePath.endsWith("app.min.js") || filePath.endsWith("styles.min.css")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
    // Images, fonts, favicons — long cache (1 year)
    else if (["jpg","jpeg","png","webp","avif","svg","ico","gif","woff","woff2","ttf"].includes(ext)) {
      // Helmet's default Cross-Origin-Resource-Policy is same-origin, which BLOCKS
      // browsers on any other origin from loading these files. Email clients render
      // from their own origin (mail.google.com etc), so the newsletter logo was being
      // blocked outright. Public images are meant to be embeddable; scope this to
      // image/font assets only so API responses keep the safe same-origin default.
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cache-Control", "public, max-age=31536000");
    }
    // Other JS/CSS — 1 hour with revalidation
    else if (["js","css"].includes(ext)) {
      res.setHeader("Cache-Control", "public, max-age=3600, must-revalidate");
    }
    // HTML — defensive fallback (injector handles HTML normally)
    else if (ext === "html") {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    }
    // Manifest, sitemap, robots — 5 minutes
    else if (["json","xml","txt"].includes(ext)) {
      res.setHeader("Cache-Control", "public, max-age=300");
    }
  }
}));

// ── Mount route modules ─────────────────────────────────────────────────────
app.use(authRoutes);
app.use(krogerRoutes);
app.use(walmartRoutes);
app.use(aldiRoutes);
app.use(recipesRoutes);
app.use(storesRoutes);
app.use(adminRoutes);
app.use(gamificationRoutes);
app.use(newsletterRoutes);

// ── 404 catch-all ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    res.status(404).sendFile(join(__dirname, "public", "404.html"));
  } else {
    next();
  }
});

// ── JSON error handler — catch body-parser and other errors, return JSON ────
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON in request body" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  if (req.path.startsWith("/api/")) {
    console.error(`[api error] ${req.method} ${req.path}:`, err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Internal server error" });
  }
  next(err);
});

// ── Start server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Dishcount running on port ${PORT}`);
  await initStoresWithDealsCache();
});
