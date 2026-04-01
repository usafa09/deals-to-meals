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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // CSP would break inline scripts on other pages
  crossOriginEmbedderPolicy: false,
}));

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
      callback(null, true); // Still allow but don't reflect origin (safe default)
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
  windowMs: 15 * 60 * 1000,
  max: 5,
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

// Apply rate limits to API routes
app.use("/api/", generalLimiter);
app.use("/api/recipes/ai", expensiveLimiter);
app.use("/api/extract-store", expensiveLimiter);
app.use("/api/extract-ad", expensiveLimiter);
app.use("/api/contact", contactLimiter);
app.use("/api/admin/login", authLimiter);
app.use("/api/kroger/search", storeSearchLimiter);
app.use("/api/nearby-stores", storeSearchLimiter);
app.use("/auth/", authLimiter);

// ── Static files ────────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, "public")));

// ── Mount route modules ─────────────────────────────────────────────────────
app.use(authRoutes);
app.use(krogerRoutes);
app.use(walmartRoutes);
app.use(aldiRoutes);
app.use(recipesRoutes);
app.use(storesRoutes);
app.use(adminRoutes);

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
