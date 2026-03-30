import dotenv from 'dotenv';
dotenv.config();
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { isValidSession, initStoresWithDealsCache } from "./lib/utils.js";

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
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// ══ PASSWORD GATE — blocks all pages until password entered ══════════════════

app.get("/login.html", (req, res) => {
  res.sendFile(join(__dirname, "public", "login.html"));
});

app.use((req, res, next) => {
  // Always allow login endpoint, OAuth callbacks, and static assets
  if (req.path === "/api/site-login" || req.path === "/login.html" ||
      req.path.startsWith("/auth/kroger") ||
      req.path.endsWith(".css") || req.path.endsWith(".woff") ||
      req.path.endsWith(".woff2") || req.path.endsWith(".js")) {
    return next();
  }
  if (isValidSession(req.cookies?.site_auth)) {
    return next();
  }
  // API routes get a 401 JSON response; pages get redirected
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Login required" });
  }
  res.redirect("/login.html");
});

// ═════════════════════════════════════════════════════════════════════════════

app.use(express.static(join(__dirname, "public")));

// ── Mount route modules ─────────────────────────────────────────────────────
app.use(authRoutes);
app.use(krogerRoutes);
app.use(walmartRoutes);
app.use(aldiRoutes);
app.use(recipesRoutes);
app.use(storesRoutes);
app.use(adminRoutes);

// ── Start server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Dishcount running on port ${PORT}`);
  // Populate in-memory stores cache on startup
  await initStoresWithDealsCache();
});
