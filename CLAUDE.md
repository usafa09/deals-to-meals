# CLAUDE.md — Dishcount

## What this app does

Dishcount (dishcount.co) helps grocery shoppers save money by finding recipes based on what's currently on sale at their local stores. The user enters a zip code, selects nearby stores, browses this week's deals, picks items they want, chooses a recipe style, and gets AI-generated recipes that maximize savings.

**Branding:** The app name is "Dishcount" with tagline "Meals from Deals". The primary domain is dishcount.co (dealstomeals.co also works as a secondary domain). The codebase repo is named `deals-to-meals`.

## Tech stack

- **Frontend:** Single-page app in `public/index.html` (~900 lines). Vanilla JS, no framework. DM Sans font. Supabase JS SDK loaded via CDN for auth.
- **Backend:** `server.js` (~2,500 lines). Node.js + Express. ESM modules (import/export).
- **Database:** Supabase (PostgreSQL). Project URL: `https://gkzlwzafnkqwxwiootah.supabase.co`
- **Hosting:** Render (auto-deploys from GitHub on push). Port 10000 in production.
- **Domain:** dishcount.co (primary), dealstomeals.co (secondary)

## Environment variables (all set in Render)

```
SUPABASE_URL                # Supabase project URL
SUPABASE_SERVICE_KEY        # Supabase service role key (server-side only)
KROGER_CLIENT_ID            # Kroger developer API
KROGER_CLIENT_SECRET        # Kroger developer API
WALMART_CONSUMER_ID         # Walmart affiliate API
WALMART_PRIVATE_KEY         # Walmart affiliate API (PKCS8 PEM format)
ANTHROPIC_API_KEY           # Claude API for AI recipe generation & OCR deal extraction
GOOGLE_MAPS_API_KEY         # Google Places API for nearby store discovery
PEXELS_API_KEY              # Pexels API for recipe images
SITE_PASSWORD               # Password gate for beta access
PORT                        # Set by Render (10000), defaults to 5000 locally
```

## Supabase tables

- **`deal_cache`** — Key-value cache for deals. Columns: `cache_key` (text PK), `data` (jsonb), `fetched_at` (timestamptz). TTL: 24 hours. Keys follow patterns like `kroger:{locationId}`, `ad-extract:aldi`, `ad-extract:{store-slug}`, `ad-extract:{store-slug}:{zip3}`, `nearby-stores:{zip}:{miles}mi`.
- **`aldi_deals`** — Legacy ALDI weekly deals table. Retired May 2026 when the bespoke scraper broke after ALDI's site redesign. ALDI now flows through the OCR pipeline like every other chain. Table may still exist in Supabase but is no longer read or written.
- **`ad_regions`** — Maps zip3 prefixes to which store chains/banners/divisions serve that area. Columns: `zip3`, `store`, `banner`, `division`, `division_code`, `ad_cycle`, `notes`.
- **`profiles`** — User profiles. Columns: `id`, `full_name`, `household_size`, `dietary_preferences`, `favorite_recipe_types`, `preferred_store`, `kroger_connected`, `updated_at`.
- **`saved_recipes`** — User-saved recipes. Columns: `id`, `user_id`, `title`, `emoji`, `time`, `servings`, `difficulty`, `ingredients`, `steps`, `store_name`, `image`, `created_at`.

## User flow (6 screens)

1. **Screen 1 — Zip code entry.** User enters zip, selects search radius (5-30 miles).
2. **Screen 2 — Store selection.** Google Places discovers nearby grocery stores. Brands are deduped and shown as cards. Stores with available deals show a green checkmark. Users select 1+ stores.
3. **Screen 3 — Kroger location picker** (only if Kroger selected). Pick specific Kroger store for location-specific deals.
4. **Screen 4 — Deal browser.** Shows all sale items across selected stores in a card grid. Users tap to cycle: neutral → green ✓ (must include) → red ✕ (exclude). Filter by store and category.
5. **Screen 5 — Recipe style & diet filters.** Pick a style (Quick Weeknight, Family-Friendly, Comfort Food, Meal Prep, Healthy & Light, Slow Cooker) and optional diet filters (Vegetarian, Vegan, Gluten-Free, Keto, Halal, etc.).
6. **Screen 6 — Recipe results.** AI-generated recipe cards with images, cook time, savings, and sale items used. Click for full recipe modal with ingredients and step-by-step instructions. Save recipes, add ingredients to Kroger cart.

## How deals are sourced (3 methods)

### 1. Kroger API (live, location-specific)
- Official API at `api.kroger.com`. OAuth2 client credentials flow.
- Searches ~50 product categories, filters for items with promo pricing.
- Covers all Kroger banners: Kroger, Ralphs, Fred Meyer, King Soopers, Harris Teeter, Smith's, Fry's, QFC, Mariano's, Dillons, Pick 'n Save.
- Smart per-lb detection for meat/produce pricing.

### 2. Walmart Affiliate API
- Signed requests with RSA-SHA256 using PKCS8 private key.
- Searches 10 grocery categories filtered by `specialOffer=rollback`.
- Returns national rollback deals, not location-specific.

### 3. On-demand ad extraction (OCR pipeline)
- For 80+ other chains (Publix, Meijer, Sprouts, H-E-B, Safeway, etc.).
- Flow: user clicks store → `POST /api/extract-store` → fetches weekly ad images from igroceryads.com, iweeklyads.com, ladysavings.com, or weeklyad.us.com → sends each page to Claude Haiku Vision for deal extraction → caches results in `deal_cache`.
- Text fallback: if vision extracts <10 deals, strips HTML from the ad page and sends text to Claude for extraction.
- Deals get category-based placeholder images from Unsplash/Pexels (see `CATEGORY_IMAGES` map).
- Store URL lookup table: `IGROCERYADS_STORES` (~80 entries mapping store names to ad page URLs).

### 4. Chains using weeklyad.us.com OCR (ALDI, Lidl)

Some chains' coverage on igroceryads/ladysavings is **merchandise-only** — those aggregators mirror only the non-food "Finds"-style pages of the flyer, not the actual grocery deals. For these chains we use the `weeklyad.us.com` sister-domain network instead, which carries the full in-store food pages.

**Pattern:** `https://{slug}.weeklyad.us.com/images/{slug}/view/{N}.webp` (sequential page numbering, probe N=1 upward until first 404, max 20 pages per the pipeline cap). The extract-store handler in `routes/stores.js` detects the `weeklyad.us.com` domain and uses sequential probing instead of the regex-based image discovery used for igroceryads/ladysavings.

**Currently using weeklyad.us.com:**
- **ALDI** — `aldi.weeklyad.us.com` (3 pages, ~2 food + 1 Finds). Cutover May 2026 from `aldi.us` (broke after Instacart redesign).
- **Lidl** — `lidl.weeklyad.us.com` (20 pages, ~100-200+ food items). Cutover May 2026 from `igroceryads.com/lidl-promotions/` which only mirrored Lidl Finds.

**Sister domains verified to work** (same URL pattern, all return HTTP 200): `foodlion.weeklyad.us.com`, `fredmeyer.weeklyad.us.com`, `jewel.weeklyad.us.com`, others. If another chain's igroceryads coverage drops to merchandise-only or its existing source breaks, this network is a viable fallback — just swap the `IGROCERYADS_STORES` URL.

**ALDI history:** previously had a bespoke Playwright scraper (`Aldi.js` / `Aldi-v2.js`) that scraped `aldi.us` directly. Retired May 2026 after ALDI redesigned to an Instacart-powered storefront and the scraper URLs broke. We tried `igroceryads.com` and `ladysavings.com` first — both turned out to mirror only the ALDI Finds (non-food merch) pages. ALDI deals are national; dummy store endpoint returns a single "ALDI - Near {zip}" entry.

**Lidl history:** triage in May 2026 surfaced Lidl had dropped from 70 deals to 10 on its previous source (igroceryads), with the remaining items being CRIVIT-branded sporting goods (Lidl's house brand for Finds). Same pattern as ALDI — moved to weeklyad.us.com for food coverage.

## How recipes are generated

`POST /api/recipes/ai` is the single recipe path. Claude Haiku 4.5 generates recipes from current deal data with prompt engineering for budget-friendly meals, dietary compliance, and proper handling of raw vs. processed ingredients. Pexels fetches a food photo for each recipe by title. Diet rules filter incompatible sale items before the prompt is sent. Results are cached in-memory for 30 minutes and Anthropic API cost is tracked per request. Claude Vision is used separately for OCR ad extraction.

## Nearby store discovery

- `GET /api/nearby-stores` — geocodes zip via Google Maps, then runs two Google Places searches (type=supermarket + keyword=grocery store) with pagination (up to 60 results per search).
- Normalizes results to brand names (80+ chain patterns matched).
- Checks which brands have cached deals or can be extracted via igroceryads.
- 30-day Supabase cache.

## Key API endpoints

### Store & deal endpoints
- `GET /api/nearby-stores?zip=&radius=` — discover stores via Google Places
- `GET /api/deals/regional?zip=&locationId=` — fetch all deals for a zip (Kroger + ALDI + ad-extracted)
- `GET /api/deals?locationId=` — Kroger deals for a specific store
- `GET /api/walmart/stores?zip=` / `GET /api/walmart/deals` — Walmart
- `GET /api/aldi/deals` / `GET /api/aldi/stores?zip=` / `GET /api/aldi/status`
- `POST /api/extract-store` — trigger on-demand ad extraction for a store
- `GET /api/extract-status?store=` — check extraction progress

### Recipe endpoints
- `POST /api/recipes/ai` — Claude AI recipe generation

### Auth & user endpoints
- `POST /api/site-login` — password gate
- `GET /auth/kroger` / `GET /auth/kroger/callback` — Kroger OAuth
- `GET /api/profile` / `PATCH /api/profile` — user profile
- `GET /api/recipes/saved` / `POST /api/recipes/saved` / `DELETE /api/recipes/saved/:id`
- `GET /api/coupons` — Kroger coupons (requires user auth)
- `POST /api/cart` — add items to Kroger cart

### Admin endpoints
- `GET /api/admin/cache-status` — cache statistics
- `POST /api/admin/cache-cleanup` / `GET /api/admin/cache-cleanup` — clear cache
- `GET /api/admin/ad-regions-stats` — ad regions coverage
- `GET /api/admin/cache-coverage` — which zips have cached deals
- `POST /api/extract-ad` — manually extract deals from uploaded ad image
- `POST /api/admin/import-deals` — import extracted deals to cache

### Debug endpoints
- `GET /api/debug-kroger-prices?locationId=` — raw Kroger product data
- `GET /api/debug-walmart?zip=` — raw Walmart API response
- `GET /api/debug-recipes` — recipe search diagnostics

## File structure

```
deals-to-meals/
├── server.js              # Express backend (all API routes, ~2,500 lines)
├── public/
│   ├── index.html          # Main SPA (all 6 screens, ~900 lines)
│   ├── login.html          # Password gate page
│   └── profile.html        # User profile/settings page
├── package.json
├── .env                    # Local env vars (not in git)
└── CLAUDE.md               # This file
```

## Known issues and areas for improvement

### Bugs to investigate
- The `cleanIngName()` function uses `.slice(-3)` which can drop important words from long product names.

### Architecture improvements needed
- **server.js is too large** (~2,500 lines). Should be split into route modules: `routes/kroger.js`, `routes/walmart.js`, `routes/aldi.js`, `routes/recipes.js`, `routes/admin.js`, `routes/auth.js`, `routes/stores.js`.
- **index.html is all inline** (~900 lines of JS in script tags). Should be modularized.
- **No tests.** Need unit tests for `findDeal()`, `getCategoryImage()`, `cleanIngName()`, `detectPerLb()`, and integration tests for API endpoints.
- **No error monitoring.** Should add structured logging or a service like Sentry.
- **In-memory caches** (recipeCache, aiRecipeCache, krogerTokens, extractingStores) are lost on every deploy/restart. Consider moving to Supabase or Redis.

### Performance improvements
- Kroger deal fetching is slow (~50 category searches serially in batches of 8). Could parallelize more aggressively or reduce categories.
- On-demand ad extraction takes 2-3 minutes (fetches images, sends each to Claude Vision). Consider pre-extracting popular stores.
- Google Places pagination adds 2-second delays between pages (required by Google). Consider caching more aggressively.

### Feature ideas
- Remove password gate and launch publicly
- Landing page with SEO for "recipes from grocery deals"
- Email notifications when new deals match saved recipe preferences
- Shopping list export/share functionality
- More stores via Flipp partnership or direct grocery chain API access
- Price history tracking over time
- User reviews/ratings on recipes
- PWA support for mobile

## Coding conventions

- ESM imports (`import x from 'y'`), not CommonJS
- Express route handlers use async/await
- Supabase queries use `.from().select().eq()` pattern
- Console.log used for server logging (no structured logger yet)
- Frontend uses vanilla JS with template literals for HTML rendering
- CSS custom properties defined in `:root` for theming
- No TypeScript (plain JS throughout)

## Common dev commands

```bash
# Start server locally
node server.js

# Kill port conflict
npx kill-port 5000

# Check server syntax without running
node --check server.js

# Push to production
git add -A
git commit -m "description"
git push
# Render auto-deploys from main branch
```

## Important notes

- **Anthropic API costs money per call.** AI recipe generation and OCR extraction both use Claude. The AI recipe endpoint logs token usage and estimated cost.
- **Google Places API costs money.** Nearby store results are cached for 30 days to minimize API calls.
- **Walmart API requires RSA-SHA256 signed requests.** The private key must be in PKCS8 PEM format in the WALMART_PRIVATE_KEY env var.
- **ALDI deals are national** — one OCR run covers all stores. No location-specific variants needed.
- **Kroger deals ARE location-specific** — must pass a locationId to get accurate sale prices for a specific store.
- **The owner (Billy) is in Dayton, Ohio (zip 45432).** Test with this zip for local results.
