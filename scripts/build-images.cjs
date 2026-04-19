const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "public", "images");

// WebP conversions for tutorial images (used in <picture> tags)
const WEBP = {
  "how-choose-stores": { width: 800, quality: 80 },
  "how-browse-deals": { width: 800, quality: 80 },
  "how-get-recipes": { width: 800, quality: 80 },
};

// JPG optimization (overwrites source — used directly in og:image meta tags)
const JPG_OPTIMIZE = {
  "og-hero": { width: 1200, quality: 75 },
};

async function run() {
  // WebP builds
  for (const [name, opts] of Object.entries(WEBP)) {
    const jpgPath = path.join(SRC, `${name}.jpg`);
    if (!fs.existsSync(jpgPath)) { console.log(`  skip: ${name}.jpg not found`); continue; }
    const webpPath = path.join(SRC, `${name}.webp`);
    await sharp(jpgPath)
      .resize({ width: opts.width, withoutEnlargement: true })
      .webp({ quality: opts.quality })
      .toFile(webpPath);
    const jpgSize = (fs.statSync(jpgPath).size / 1024).toFixed(0);
    const webpSize = (fs.statSync(webpPath).size / 1024).toFixed(0);
    console.log(`  ${name}.webp created (${jpgSize}KB jpg → ${webpSize}KB webp)`);
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
