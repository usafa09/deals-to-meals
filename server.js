import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { initStoresWithDealsCache } from "./lib/utils.js";

import authRoutes from "./routes/auth.js";
import krogerRoutes from "./routes/kroger.js";
import walmartRoutes from "./routes/walmart.js";
import aldiRoutes from "./routes/aldi.js";
import recipesRoutes from "./routes/recipes.js";
import storesRoutes from "./routes/stores.js";
import adminRoutes from "./routes/admin.js";
import gamificationRoutes from "./routes/gamification.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  contentSecurityPolicy: false, // CSP would break inline scripts on other pages
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://www.googletagmanager.com https://www.google-analytics.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' https: data: blob:",
    "connect-src 'self' https://bvwwtrwxnuncalgtuqvx.supabase.co https://api.kroger.com https://www.google-analytics.com https://analytics.google.com",
    "frame-src 'none'",
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
app.use("/api/badges", gamificationLimiter);
app.use("/api/leaderboard", gamificationLimiter);
app.use("/api/challenges", gamificationLimiter);

// ── Static files ────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(join(__dirname, 'public', 'sitemap.xml'));
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
app.get('*.map', (req, res) => { res.status(404).end(); });
app.use(express.static(join(__dirname, "public")));

// ── Mount route modules ─────────────────────────────────────────────────────
app.use(authRoutes);
app.use(krogerRoutes);
app.use(walmartRoutes);
app.use(aldiRoutes);
app.use(recipesRoutes);
app.use(storesRoutes);
app.use(adminRoutes);
app.use(gamificationRoutes);

// ── 404 catch-all ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    res.status(404).sendFile(join(__dirname, "public", "404.html"));
  } else {
    next();
  }
});

// ── Start server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Dishcount running on port ${PORT}`);
  await initStoresWithDealsCache();
});
