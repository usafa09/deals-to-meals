# Dishcount site review fixes — April 18, 2026

Context: The stack is Node/Express + Supabase with a vanilla HTML/JS frontend. A detailed external review surfaced seven priority items. Work through them in order. For each one: read the relevant code first, confirm the issue matches what's described, then implement. Don't deploy between tasks — batch them into one deploy at the end.

Ask me before making any changes you're uncertain about. If an item turns out to be already fixed or not applicable, say so and move on.

---

## 1. Fix `Cache-Control` headers on static assets

**Problem:** Every asset the server returns has `Cache-Control: public, max-age=0`, including hashed JS/CSS, images, favicons, and the manifest. This forces browsers to revalidate every asset on every page load — big performance cost for returning visitors.

**What to do:**

In `server.js`, find where `express.static` is being set up and replace with per-extension cache rules. Here's the pattern to use:

```js
const ONE_YEAR = 31536000;
const FIVE_MIN = 300;

app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();

    // Immutable — fingerprinted or rarely-changing assets
    if ([".js", ".css", ".woff", ".woff2", ".ttf"].includes(ext)) {
      res.setHeader("Cache-Control", `public, max-age=${ONE_YEAR}, immutable`);
    }
    // Images — long cache, not immutable (in case we swap one)
    else if ([".jpg", ".jpeg", ".png", ".webp", ".avif", ".svg", ".ico", ".gif"].includes(ext)) {
      res.setHeader("Cache-Control", `public, max-age=${ONE_YEAR}`);
    }
    // HTML — short cache with revalidation
    else if (ext === ".html") {
      res.setHeader("Cache-Control", `public, max-age=${FIVE_MIN}, must-revalidate`);
    }
    // Manifest, robots, sitemap — short
    else if ([".json", ".xml", ".txt"].includes(ext)) {
      res.setHeader("Cache-Control", `public, max-age=${FIVE_MIN}`);
    }
  }
}));
```

**Important caveats:**

- The `app.min.js` and `styles.min.css` filenames are NOT content-hashed today. If we set them to `immutable` and later ship a change, users will keep the old version until the cache expires. So either:
  - (a) Also add a build step that hashes filenames (`app.a3f2b1.js`) and updates the HTML references, OR
  - (b) Use `max-age=3600, must-revalidate` instead of `immutable` for those two files specifically until hashing is in place.
- I lean toward (b) for now since it's a one-line change and doesn't require a build pipeline.

**Test after:** `curl -sI https://dishcount.co/app.min.js` should show `cache-control: public, max-age=3600, must-revalidate` (or whatever you choose). HTML pages should show `max-age=300`. Images should show `max-age=31536000`.

---

## 2. Frontend should pass `limit` and `brands` params to the deals API

**Problem:** The deals API response without params is ~664 KB with 1,508 deals. The frontend downloads all of it and filters client-side. The server endpoint already supports `limit` and `brands` params — the frontend just isn't using them.

**What to do:**

Find this code in `app.min.js` (or wherever the deals fetch lives in source — probably `app.js` if you have an unbuilt version):

```js
const params = new URLSearchParams({ zip: state.zip });
if (state.selectedKrogerId) params.set("locationId", state.selectedKrogerId);
const res = await fetch(`/api/deals/regional?${params}`);
```

Replace with:

```js
const params = new URLSearchParams({ zip: state.zip, limit: "300" });
if (state.selectedKrogerId) params.set("locationId", state.selectedKrogerId);
if (state.selectedBrands && state.selectedBrands.length) {
  params.set("brands", state.selectedBrands.join(","));
}
const res = await fetch(`/api/deals/regional?${params}`);
```

**Caveats:**

- Verify the server's `/api/deals/regional` endpoint actually accepts `brands` as a comma-separated list and that the matching logic on the server handles the same Kroger-family expansion the frontend does. If not, the server may need matching logic added. Check `server.js` for the route handler first.
- Pick `limit` based on how many deals you actually want to show. 300 is a safe middle ground (enough to feel abundant, small enough to render fast). If you have client-side pagination at 50/page, 300 gives the user 6 pages worth.
- After this change, the downstream client-side filter can stay as a safety net but should rarely do work.

**Test after:** Network tab on the deals screen should show `/api/deals/regional?zip=X&limit=300&brands=...` and a payload under 100 KB.

---

## 3. Diagnose why recipe generation went from ~17s to ~30s

**Problem:** An identical test (`POST /api/recipes/ai` with `{ingredients:[chicken,broccoli,rice], count:4}`) that took 17s in early April now takes 30s. That's a user-killer.

**What to do — diagnostic first, then fix:**

Instrument the recipe endpoint with timing logs. In the route handler, wrap the Anthropic API call:

```js
const anthropicStart = Date.now();
const aiResponse = await anthropic.messages.create({ ... });
const anthropicMs = Date.now() - anthropicStart;
console.log(`[recipes/ai] anthropic_ms=${anthropicMs} prompt_tokens=${aiResponse.usage?.input_tokens} completion_tokens=${aiResponse.usage?.output_tokens} ingredient_count=${ingredients.length} requested_count=${count}`);
```

Also log: time spent on Pexels image fetches, time parsing the AI response, and any Supabase calls in between.

**Hypotheses to check, in order of likelihood:**

1. **Prompt has grown.** The system prompt or the user prompt template may have had features tacked on. Compare current prompt against git history from early April. Token count of input matters.
2. **Pexels image fetching is serial.** If the endpoint fetches an image for each of the 4 recipes *sequentially* rather than in parallel, that alone could be 4–8s. Use `Promise.all` if not already.
3. **`count` default changed.** If the default is now 6 or 8 instead of 4, that's a linear cost increase per recipe generated.
4. **Model changed.** Verify the request is still using `claude-haiku-4-5` and not accidentally upgraded to Sonnet or Opus.

**After diagnosing, likely fixes:**

- Cap ingredient list to 30 items server-side before sending to Claude.
- Parallelize all Pexels fetches.
- Strip any verbose examples from the prompt that aren't actually needed.
- Consider streaming the response to the client so the UI can show recipes as they arrive rather than waiting for the full batch.

Run the diagnostic for a day first. Don't guess-fix — tell me what the actual breakdown is and we'll decide the fix together.

---

## 4. Actually minify `app.min.js` and `styles.min.css`

**Problem:** The files named `*.min.*` are not minified. `app.min.js` is 204 KB with full whitespace, comments, and readable variable names. `app.js` and `app.min.js` are byte-identical duplicates.

**What to do:**

Add a build step. Simplest approach, using `terser` and `csso`:

```bash
npm install --save-dev terser csso-cli
```

Add to `package.json` scripts:

```json
"scripts": {
  "build:js": "terser public/app.js -c -m -o public/app.min.js",
  "build:css": "csso public/styles.css -o public/styles.min.css",
  "build": "npm run build:js && npm run build:css",
  "prestart": "npm run build"
}
```

Delete `public/app.min.js` and `public/styles.min.css` from git and add them to `.gitignore` (they'll be regenerated on every deploy).

If you're on Render, make sure the build command in Render's dashboard includes `npm run build` before `npm start`.

**Expected result:** `app.min.js` should drop from 204 KB to roughly 90–110 KB. `styles.min.css` from 44 KB to roughly 30 KB.

**Test after:** `curl -s https://dishcount.co/app.min.js | head -c 200` should show minified code (one line, short variable names), not readable source.

---

## 5. Convert images to WebP with JPEG fallback

**Problem:** `og-hero.jpg` is 263 KB. All four content images are JPEG. No modern formats anywhere.

**What to do:**

Install sharp and add an image build step:

```bash
npm install --save-dev sharp
```

Create `scripts/build-images.js`:

```js
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "public", "images");
const SIZES = {
  "og-hero": { width: 1200, quality: 82 },
  "how-choose-stores": { width: 800, quality: 80 },
  "how-browse-deals": { width: 800, quality: 80 },
  "how-get-recipes": { width: 800, quality: 80 },
};

async function run() {
  for (const [name, opts] of Object.entries(SIZES)) {
    const jpgPath = path.join(SRC, `${name}.jpg`);
    if (!fs.existsSync(jpgPath)) continue;

    const webpPath = path.join(SRC, `${name}.webp`);
    await sharp(jpgPath).resize({ width: opts.width, withoutEnlargement: true }).webp({ quality: opts.quality }).toFile(webpPath);
    console.log(`${name}.webp created`);
  }
}
run();
```

Add to package.json:
```json
"build:images": "node scripts/build-images.js",
"build": "npm run build:images && npm run build:js && npm run build:css"
```

**Then update the HTML** to use `<picture>` for the three tutorial images in the "How It Works" section:

```html
<picture>
  <source srcset="/images/how-choose-stores.webp" type="image/webp">
  <img src="/images/how-choose-stores.jpg" alt="Enter your zip code" loading="lazy" width="400" height="250" />
</picture>
```

Leave the OG tag alone — `og:image` should stay pointing at the JPEG for social network compatibility.

**Also add `width` and `height` attributes** to all `<img>` tags to prevent cumulative layout shift. The three tutorial images are 400x250, hero image is 1200x630.

---

## 6. Add JSON error middleware

**Problem:** Sending malformed JSON to any API endpoint returns an HTML error page. The frontend will fail `JSON.parse()` on it.

**What to do:**

At the bottom of `server.js`, after all routes but before `app.listen`, add:

```js
// JSON error handler — catch body-parser and other errors and return JSON
app.use((err, req, res, next) => {
  // Body-parser errors (invalid JSON)
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON in request body" });
  }
  // Body too large
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  // Only return JSON for /api/* routes, otherwise fall through
  if (req.path.startsWith("/api/")) {
    console.error(`[api error] ${req.method} ${req.path}:`, err);
    return res.status(err.status || 500).json({ error: err.message || "Internal server error" });
  }
  next(err);
});
```

**Also fix the recipe endpoint specifically:** when ingredient count exceeds some sane threshold, return a 400 with a helpful message instead of letting the Anthropic call fail with a 500:

```js
if (ingredients.length > 30) {
  return res.status(400).json({ error: "Too many ingredients. Please limit to 30 or fewer." });
}
```

**Test after:**
```bash
curl -s -X POST https://dishcount.co/api/recipes/ai -H "Content-Type: application/json" -d '{invalid}' 
# Should return: {"error":"Invalid JSON in request body"}
```

---

## 7. Sitemap cleanup

**Problem:**
- `login.html` is in sitemap.xml but is a byte-identical duplicate of profile.html and is noindexed.
- `tips.html` is linked from every page footer but missing from sitemap.
- `lastmod` dates are all stale (April 2 / April 12).

**What to do:**

Replace `public/sitemap.xml` with:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://dishcount.co/</loc>
    <lastmod>2026-04-18</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://dishcount.co/about.html</loc>
    <lastmod>2026-04-18</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://dishcount.co/features.html</loc>
    <lastmod>2026-04-18</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://dishcount.co/tips.html</loc>
    <lastmod>2026-04-18</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://dishcount.co/contact.html</loc>
    <lastmod>2026-04-18</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>https://dishcount.co/terms.html</loc>
    <lastmod>2026-04-18</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>https://dishcount.co/privacy.html</loc>
    <lastmod>2026-04-18</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
</urlset>
```

**Also delete `public/login.html`** — it's a dead duplicate. The HTML `<link rel="canonical">` on it already points to `/profile.html` and it's noindexed, but the cleaner fix is to remove the file and add a 301 redirect in `server.js`:

```js
app.get("/login.html", (req, res) => res.redirect(301, "/profile.html"));
app.get("/login", (req, res) => res.redirect(301, "/profile.html"));
```

Then update sitemap (done above — login.html already removed from it).

---

## 8. While you're in there — small wins

If there's any time left:

- **Add `/apple-touch-icon.png` at the root** (copy or symlink from `/icons/apple-touch-icon.png`). iOS probes the root path directly and ignores the HTML link in some sharing contexts.
- **Add footer social links** — at minimum, add whatever Dishcount social accounts exist. If none yet, skip.
- **Decide the PWA question:** the service worker self-destructs today. Either commit to a real caching SW or delete `manifest.json`'s `display: standalone` and the SW file entirely so the story is consistent.

---

## After all changes

Run these verification steps before deploying:

```bash
# 1. Cache headers
curl -sI https://dishcount.co/app.min.js | grep -i cache-control
curl -sI https://dishcount.co/images/og-hero.jpg | grep -i cache-control
curl -sI https://dishcount.co/ | grep -i cache-control

# 2. Minification
curl -s https://dishcount.co/app.min.js | wc -c   # should be < 120000
curl -s https://dishcount.co/app.min.js | head -c 200   # should look minified

# 3. Deals API size
curl -s "https://dishcount.co/api/deals/regional?zip=45324&brands=Kroger,ALDI&limit=300" | wc -c

# 4. Recipe timing
time curl -s -X POST https://dishcount.co/api/recipes/ai \
  -H "Content-Type: application/json" \
  -d '{"ingredients":[{"name":"chicken"},{"name":"broccoli"},{"name":"rice"}],"count":4}' \
  -o /dev/null

# 5. JSON error handler
curl -s -X POST https://dishcount.co/api/recipes/ai -H "Content-Type: application/json" -d '{bad}'
# expect: {"error":"Invalid JSON in request body"}

# 6. Sitemap
curl -s https://dishcount.co/sitemap.xml | grep -c "login.html"   # should be 0
curl -s https://dishcount.co/sitemap.xml | grep -c "tips.html"    # should be 1
```

Share the output of each when you're done and I'll verify nothing regressed.
