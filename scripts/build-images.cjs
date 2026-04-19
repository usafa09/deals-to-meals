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
    if (!fs.existsSync(jpgPath)) {
      console.log(`  skip: ${name}.jpg not found`);
      continue;
    }

    const webpPath = path.join(SRC, `${name}.webp`);
    await sharp(jpgPath)
      .resize({ width: opts.width, withoutEnlargement: true })
      .webp({ quality: opts.quality })
      .toFile(webpPath);

    const jpgSize = (fs.statSync(jpgPath).size / 1024).toFixed(0);
    const webpSize = (fs.statSync(webpPath).size / 1024).toFixed(0);
    console.log(`  ${name}.webp created (${jpgSize}KB jpg → ${webpSize}KB webp)`);
  }
}

run().catch(e => { console.error("Image build error:", e.message); process.exit(1); });
