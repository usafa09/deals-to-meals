import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const KROGER_TOKEN_URL = "https://api.kroger.com/v1/connect/oauth2/token";
const KROGER_AUTH_URL = "https://api.kroger.com/v1/connect/oauth2/authorize";
const KROGER_API_BASE = "https://api.kroger.com/v1";
const REDIRECT_URI = "https://deals-to-meals.onrender.com/auth/callback";

// Store user tokens in memory (in production you'd use a database)
const userTokens = new Map();

// ── Helper: get app-level access token ───────────────────────────────────────
async function getAppToken() {
  const clientId = process.env.KROGER_CLIENT_ID;
  const clientSecret = process.env.KROGER_CLIENT_SECRET;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(KROGER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: "grant_type=client_credentials&scope=product.compact",
  });

  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return data.access_token;
}

// ── Helper: refresh a user's access token ────────────────────────────────────
async function refreshUserToken(refreshToken) {
  const clientId = process.env.KROGER_CLIENT_ID;
  const clientSecret = process.env.KROGER_CLIENT_SECRET;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(KROGER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
  });

  if (!response.ok) throw new Error(await response.text());
  return await response.json();
}

// ── Route: start Kroger OAuth login ──────────────────────────────────────────
app.get("/auth/login", (req, res) => {
  const clientId = process.env.KROGER_CLIENT_ID;
  const scope = encodeURIComponent("openid profile email cart.basic:write product.compact");
  const authUrl = `${KROGER_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}`;
  res.redirect(authUrl);
});

// ── Route: Kroger OAuth callback ──────────────────────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect("/?auth=error");

  try {
    const clientId = process.env.KROGER_CLIENT_ID;
    const clientSecret = process.env.KROGER_CLIENT_SECRET;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const tokenResponse = await fetch(KROGER_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    });

    if (!tokenResponse.ok) throw new Error(await tokenResponse.text());
    const tokens = await tokenResponse.json();

    // Get user profile
    const profileResponse = await fetch(`${KROGER_API_BASE}/identity/profile`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    let profile = {};
    if (profileResponse.ok) {
      const profileData = await profileResponse.json();
      profile = profileData.data || {};
    }

    // Store tokens with session key
    const sessionId = Math.random().toString(36).substring(2, 15);
    userTokens.set(sessionId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000),
      profile,
    });

    res.redirect(`/?session=${sessionId}&auth=success`);
  } catch (err) {
    console.error("Auth callback error:", err.message);
    res.redirect("/?auth=error");
  }
});

// ── Route: get user profile ───────────────────────────────────────────────────
app.get("/api/user", async (req, res) => {
  const { session } = req.query;
  if (!session || !userTokens.has(session)) {
    return res.status(401).json({ error: "Not logged in" });
  }
  const userData = userTokens.get(session);
  res.json({ profile: userData.profile, loggedIn: true });
});

// ── Route: get user's clipped digital coupons ─────────────────────────────────
app.get("/api/coupons", async (req, res) => {
  const { session } = req.query;
  if (!session || !userTokens.has(session)) {
    return res.status(401).json({ error: "Not logged in" });
  }

  try {
    let userData = userTokens.get(session);

    if (Date.now() >= userData.expiresAt) {
      const refreshed = await refreshUserToken(userData.refreshToken);
      userData = { ...userData, accessToken: refreshed.access_token, expiresAt: Date.now() + (refreshed.expires_in * 1000) };
      userTokens.set(session, userData);
    }

    const response = await fetch(`${KROGER_API_BASE}/loyalty/profiles/coupons`, {
      headers: { Authorization: `Bearer ${userData.accessToken}`, Accept: "application/json" },
    });

    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();

    const coupons = (data.data || []).map((c) => ({
      id: c.offerId,
      description: c.description,
      brand: c.brandName || "",
      savings: c.customerSavings || 0,
      expiryDate: c.expirationDate || "",
      category: c.categories?.[0] || "",
      clipped: c.offerState === "Clipped",
    }));

    res.json({ coupons });
  } catch (err) {
    console.error("Coupons error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: add items to Kroger cart ──────────────────────────────────────────
app.post("/api/cart", async (req, res) => {
  const { session, items } = req.body;
  if (!session || !userTokens.has(session)) {
    return res.status(401).json({ error: "Not logged in" });
  }

  try {
    let userData = userTokens.get(session);

    if (Date.now() >= userData.expiresAt) {
      const refreshed = await refreshUserToken(userData.refreshToken);
      userData = { ...userData, accessToken: refreshed.access_token, expiresAt: Date.now() + (refreshed.expires_in * 1000) };
      userTokens.set(session, userData);
    }

    const response = await fetch(`${KROGER_API_BASE}/cart/add`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${userData.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: items.map((i) => ({ upc: i.upc, quantity: i.quantity || 1, modality: "PICKUP" })),
      }),
    });

    if (!response.ok) throw new Error(await response.text());
    res.json({ success: true });
  } catch (err) {
    console.error("Cart error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: logout ─────────────────────────────────────────────────────────────
app.get("/auth/logout", (req, res) => {
  const { session } = req.query;
  if (session) userTokens.delete(session);
  res.json({ success: true });
});

// ── Route: find stores near zip ───────────────────────────────────────────────
app.get("/api/stores", async (req, res) => {
  const { zip } = req.query;
  if (!zip) return res.status(400).json({ error: "zip is required" });

  try {
    const token = await getAppToken();
    const response = await fetch(
      `${KROGER_API_BASE}/locations?filter.zipCode.near=${zip}&filter.radiusInMiles=15&filter.limit=8`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
    );

    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();

    const stores = (data.data || []).map((loc) => ({
      id: loc.locationId,
      name: loc.chain || loc.name || "Kroger",
      address: `${loc.address?.addressLine1}, ${loc.address?.city}, ${loc.address?.state}`,
      phone: loc.phone || "",
      hours: loc.hours?.open24 ? "Open 24 hrs" : "",
    }));

    res.json({ stores });
  } catch (err) {
    console.error("Stores error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: get sale products for a store ─────────────────────────────────────
app.get("/api/deals", async (req, res) => {
  const { locationId } = req.query;
  if (!locationId) return res.status(400).json({ error: "locationId is required" });

  try {
    const token = await getAppToken();
    const categories = ["chicken", "beef", "vegetables", "fruit", "pasta", "dairy", "seafood", "pork"];
    const allProducts = [];

    for (const category of categories) {
      const response = await fetch(
        `${KROGER_API_BASE}/products?filter.locationId=${locationId}&filter.term=${category}&filter.limit=8`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
      );

      if (!response.ok) continue;
      const data = await response.json();

      const products = (data.data || [])
        .filter((p) => p.items?.[0]?.price?.promo > 0)
        .map((p) => {
          const item = p.items[0];
          const pctOff = Math.round(((item.price.regular - item.price.promo) / item.price.regular) * 100);
          return {
            id: p.productId,
            upc: item.upc || "",
            name: p.description,
            brand: p.brand || "",
            category,
            regularPrice: item.price.regular.toFixed(2),
            salePrice: item.price.promo.toFixed(2),
            savings: (item.price.regular - item.price.promo).toFixed(2),
            pctOff,
            size: item.size || "",
            image: p.images?.find((i) => i.perspective === "front")
              ?.sizes?.find((s) => s.size === "thumbnail")?.url || null,
          };
        });

      allProducts.push(...products);
    }

    const seen = new Set();
    const unique = allProducts
      .filter((p) => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
      .sort((a, b) => b.pctOff - a.pctOff);

    res.json({ deals: unique });
  } catch (err) {
    console.error("Deals error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Deals to Meals running on port ${PORT}`));
