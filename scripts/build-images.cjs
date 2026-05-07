const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "public", "images");

// WebP conversions. Sources can be .jpg or .png; outputs always .webp.
// Each entry's `src` and `out` are paths relative to public/images. The
// existing JPG re-optimization for og-hero (below) runs separately and
// preserves the .jpg as the social-share canonical (Facebook/Twitter
// crawlers do support webp now but we keep both for robustness).
const WEBP = [
  { src: "how-choose-stores.jpg",                      out: "how-choose-stores.webp",                      width: 800,  quality: 80 },
  { src: "how-browse-deals.jpg",                       out: "how-browse-deals.webp",                       width: 800,  quality: 80 },
  { src: "how-get-recipes.jpg",                        out: "how-get-recipes.webp",                        width: 800,  quality: 80 },
  { src: "og-hero.jpg",                                out: "og-hero.webp",                                width: 1200, quality: 75 },
  { src: "sample-deals/deal-01-bananas-aldi.png",      out: "sample-deals/deal-01-bananas-aldi.webp",      width: 480,  quality: 80 },
  { src: "sample-deals/deal-02-ground-beef-kroger.png",out: "sample-deals/deal-02-ground-beef-kroger.webp",width: 480,  quality: 80 },
  { src: "sample-deals/deal-03-chicken-walmart.png",   out: "sample-deals/deal-03-chicken-walmart.webp",   width: 480,  quality: 80 },
  { src: "sample-deals/deal-04-eggs-kroger.png",       out: "sample-deals/deal-04-eggs-kroger.webp",       width: 480,  quality: 80 },
  { src: "sample-deals/deal-05-yogurt-publix.png",     out: "sample-deals/deal-05-yogurt-publix.webp",     width: 480,  quality: 80 },
  { src: "sample-deals/deal-06-pasta-sauce-walmart.png",out:"sample-deals/deal-06-pasta-sauce-walmart.webp",width: 480, quality: 80 },
];

// JPG optimization (overwrites source — used directly in og:image meta tags
// where some crawlers may not request webp).
const JPG_OPTIMIZE = {
  "og-hero": { width: 1200, quality: 75 },
};

async function run() {
  // WebP builds
  for (const opts of WEBP) {
    const srcPath = path.join(SRC, opts.src);
    if (!fs.existsSync(srcPath)) { console.log(`  skip: ${opts.src} not found`); continue; }
    const outPath = path.join(SRC, opts.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await sharp(srcPath)
      .resize({ width: opts.width, withoutEnlargement: true })
      .webp({ quality: opts.quality })
      .toFile(outPath);
    const inSize = (fs.statSync(srcPath).size / 1024).toFixed(0);
    const outSize = (fs.statSync(outPath).size / 1024).toFixed(0);
    console.log(`  ${opts.out} created (${inSize}KB ${path.extname(opts.src).slice(1)} → ${outSize}KB webp)`);
  }

  // JPG optimization
  for (const [name, opts] of Object.entries(JPG_OPTIMIZE)) {
    const jpgPath = path.join(SRC, `${name}.jpg`);
    if (!fs.existsSync(jpgPath)) { console.log(`  skip: ${name}.jpg not found`); continue; }
    const tmpPath = path.join(SRC, `${name}.tmp.jpg`);
    const beforeSize = (fs.statSync(jpgPath).size / 1024).toFixed(0);
    await sharp(jpgPath)
      .resize({ width: opts.width, withoutEnlargement: true })
      .jpeg({ quality: opts.quality, mozjpeg: true, progressive: true })
      .toFile(tmpPath);
    fs.renameSync(tmpPath, jpgPath);
    const afterSize = (fs.statSync(jpgPath).size / 1024).toFixed(0);
    console.log(`  ${name}.jpg optimized (${beforeSize}KB → ${afterSize}KB)`);
  }
}

run().catch(e => { console.error("Image build error:", e.message); process.exit(1); });
