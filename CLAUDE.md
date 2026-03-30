# CLAUDE.md — Dishcount (Deals to Meals)

## What this app does

Dishcount (dealstomeals.co) helps grocery shoppers save money by finding recipes based on what's currently on sale at their local stores. The user enters a zip code, selects nearby stores, browses this week's deals, picks items they want, chooses a recipe style, and gets AI-generated recipes that maximize savings.

**Branding:** The app name is "Dishcount" with tagline "Meals from Deals". The domain is dealstomeals.co. The codebase repo is named `deals-to-meals`.

## Tech stack

- **Frontend:** Single-page app in `public/index.html` (~900 lines). Vanilla JS, no framework. DM Sans font. Supabase JS SDK loaded via CDN for auth.
- **Backend:** `server.js` (~2,500 lines). Node.js + Express. ESM modules (import/export).
- **Database:** Supabase (PostgreSQL). Project URL: `https://gkzlwzafnkqwxwiootah.supabase.co`
- **Hosting:** Render (auto-deploys from GitHub on push). Port 10000 in production.
- **Domain:** dealstomeals.co

## Environment variables (all set in Render)

```
SUPABASE_URL                # Supabase project URL
SUPABASE_SERVICE_KEY        # Supabase service role key (server-side only)
KROGER_CLIENT_ID            # Kroger developer API
KROGER_CLIENT_SECRET        # Kroger developer API
WALMART_CONSUMER_ID         # Walmart affiliate API
WALMART_PRIVATE_KEY         # Walmart affiliate API (PKCS8 PEM format)
SPOONACULAR_API_KEY          # Spoonacular recipe API (Starter plan, 200pts/day)
ANTHROPIC_API_KEY           # Claude API for AI recipe generation & OCR deal extraction
GOOGLE_MAPS_API_KEY         # Google Places API for nearby store discovery
PEXELS_API_KEY              # Pexels API for recipe images
SITE_PASSWORD               # Password gate for beta access
PORT                        # Set by Render (10000), defaults to 5000 locally
```

## Supabase tables

- **`deal_cache`** — Key-value cache for deals. Columns: `cache_key` (text PK), `data` (jsonb), `fetched_at` (timestamptz). TTL: 24 hours. Keys follow patterns like `kroger:{locationId}`, `aldi:national`, `ad-extract:{store-slug}`, `ad-extract:{store-slug}:{zip3}`, `nearby-stores:{zip}:{miles}mi`.
- **`aldi_deals`** — Scraped ALDI weekly deals. Columns: `id`, `name`, `brand`, `category`, `price`, `regular_price`, `savings`, `image`, `product_url`, `week_start`, `week_end`, `scraped_at`.
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
- Flow: user clicks store → `POST /api/extract-store` → fetches weekly ad images from igroceryads.com, iweeklyads.com, or ladysavings.com → sends each page to Claude Haiku Vision for deal extraction → caches results in `deal_cache`.
- Text fallback: if vision extracts <10 deals, strips HTML from the ad page and sends text to Claude for extraction.
- Deals get category-based placeholder images from Unsplash/Pexels (see `CATEGORY_IMAGES` map).
- Store URL lookup table: `IGROCERYADS_STORES` (~80 entries mapping store names to ad page URLs).

### 4. ALDI (Supabase table)
- ALDI deals are national (same everywhere). Stored in `aldi_deals` table.
- Scraped by `Aldi.js` (Playwright-based scraper, runs weekly on Wednesdays).
- Dummy store endpoint returns a single "ALDI - Near {zip}" entry since deals aren't location-specific.

## How recipes are generated

### Primary: Claude AI (`POST /api/recipes/ai`)
- Sends sale items + recipe style + dietary restrictions to Claude API.
- Extensive prompt engineering for budget-friendly recipes, dietary compliance, and proper use of raw vs. processed ingredients.
- Pexels API fetches food photos for each recipe by title.
- 30-minute in-memory cache. Anthropic API cost tracked per request.
- Diet rules filter incompatible sale items BEFORE sending to AI.

### Secondary: Spoonacular (`POST /api/recipes/search`)
- `complexSearch` API with `includeIngredients` from sale items.
- `findDeal()` function matches recipe ingredients back to sale items for savings calculation.
- Brand word stripping for ALDI products (removes "Appleton Farms", "Simply Nature", etc.).
- 200 points/day limit with 180-point safety buffer. 2-hour in-memory cache.

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
- `POST /api/recipes/ai` — Claude AI recipe generation (primary)
- `POST /api/recipes/search` — Spoonacular recipe search (secondary)

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
- `GET /api/points` — Spoonacular daily point usage

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
├── scrapers/
│   └── aldi.js             # ALDI weekly deals scraper (Playwright)
├── Aldi.js                 # Alternate location for ALDI scraper
├── package.json
├── .env                    # Local env vars (not in git)
└── CLAUDE.md               # This file
```

## Known issues and areas for improvement

### Bugs to investigate
- Recipe search with non-"Kid Friendly" filters sometimes returns no results — may need better ingredient cleaning before sending to Spoonacular.
- The `cleanIngName()` function in the Spoonacular path uses `.slice(-3)` which can drop important words from long product names.

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

# Run ALDI scraper
node Aldi.js

# Check server syntax without running
node --check server.js

# Push to production
git add -A
git commit -m "description"
git push
# Render auto-deploys from main branch
```

## Important notes

- **Spoonacular has a 200 points/day limit.** The server tracks usage and blocks at 180 points. Cache helps avoid unnecessary API calls.
- **Anthropic API costs money per call.** AI recipe generation and OCR extraction both use Claude. The AI recipe endpoint logs token usage and estimated cost.
- **Google Places API costs money.** Nearby store results are cached for 30 days to minimize API calls.
- **Walmart API requires RSA-SHA256 signed requests.** The private key must be in PKCS8 PEM format in the WALMART_PRIVATE_KEY env var.
- **ALDI deals are national** — one scrape covers all stores. No location-specific variants needed.
- **Kroger deals ARE location-specific** — must pass a locationId to get accurate sale prices for a specific store.
- **The owner (Billy) is in Dayton, Ohio (zip 45432).** Test with this zip for local results.
