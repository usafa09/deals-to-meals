const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const KROGER_TOKEN_URL = "https://api.kroger.com/v1/connect/oauth2/token";
const KROGER_API_BASE = "https://api.kroger.com/v1";

// ── Helper: get a fresh OAuth token ──────────────────────────────────────────
async function getAccessToken() {
  const clientId = process.env.KROGER_CLIENT_ID;
  const clientSecret = process.env.KROGER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing KROGER_CLIENT_ID or KROGER_CLIENT_SECRET in Secrets");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(KROGER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: "grant_type=client_credentials&scope=product.compact",
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Kroger auth failed: ${err}`);
  }

  const data = await response.json();
  return data.access_token;
}

// ── Route: find Kroger-family stores near a zip code ─────────────────────────
app.get("/api/stores", async (req, res) => {
  const { zip } = req.query;
  if (!zip) return res.status(400).json({ error: "zip is required" });

  try {
    const token = await getAccessToken();

    const response = await fetch(
      `${KROGER_API_BASE}/locations?filter.zipCode.near=${zip}&filter.radiusInMiles=15&filter.limit=8`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Locations API error: ${err}`);
    }

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
    const token = await getAccessToken();

    // Search across common grocery categories to find promoted items
    const categories = ["chicken", "beef", "vegetables", "fruit", "pasta", "dairy", "seafood", "pork"];
    const allProducts = [];

    for (const category of categories) {
      const response = await fetch(
        `${KROGER_API_BASE}/products?filter.locationId=${locationId}&filter.term=${category}&filter.limit=8`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) continue;

      const data = await response.json();

      const products = (data.data || [])
        .filter((p) => {
          const item = p.items?.[0];
          // Only include items that have a promo price (on sale)
          return item?.price?.promo > 0;
        })
        .map((p) => {
          const item = p.items?.[0];
          const savings = (item.price.regular - item.price.promo).toFixed(2);
          const pctOff = Math.round(((item.price.regular - item.price.promo) / item.price.regular) * 100);
          return {
            id: p.productId,
            name: p.description,
            brand: p.brand || "",
            category,
            regularPrice: item.price.regular.toFixed(2),
            salePrice: item.price.promo.toFixed(2),
            savings,
            pctOff,
            size: item.size || "",
            image: p.images?.find((i) => i.perspective === "front")
              ?.sizes?.find((s) => s.size === "thumbnail")?.url || null,
          };
        });

      allProducts.push(...products);
    }

    // Deduplicate by product id and sort by biggest savings first
    const seen = new Set();
    const unique = allProducts
      .filter((p) => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      })
      .sort((a, b) => b.pctOff - a.pctOff);

    res.json({ deals: unique });
  } catch (err) {
    console.error("Deals error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Deals to Meals server running on port ${PORT}`);
});
