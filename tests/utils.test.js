import assert from "node:assert";
import { detectPerLb, getCategoryImage, validateZip, validateStoreName, findDeal, CATEGORY_IMAGES } from "../lib/utils.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

// ── validateZip ─────────────────────────────────────────────────────────────

console.log("\nvalidateZip:");

test("accepts valid 5-digit zip", () => {
  assert.strictEqual(validateZip("45432"), true);
  assert.strictEqual(validateZip("10001"), true);
  assert.strictEqual(validateZip("00000"), true);
});

test("rejects non-string input", () => {
  assert.strictEqual(validateZip(12345), false);
  assert.strictEqual(validateZip(null), false);
  assert.strictEqual(validateZip(undefined), false);
});

test("rejects wrong-length strings", () => {
  assert.strictEqual(validateZip("1234"), false);
  assert.strictEqual(validateZip("123456"), false);
  assert.strictEqual(validateZip(""), false);
});

test("rejects non-numeric strings", () => {
  assert.strictEqual(validateZip("abcde"), false);
  assert.strictEqual(validateZip("1234a"), false);
  assert.strictEqual(validateZip("12 34"), false);
});

// ── validateStoreName ───────────────────────────────────────────────────────

console.log("\nvalidateStoreName:");

test("accepts valid store names", () => {
  assert.strictEqual(validateStoreName("Kroger"), true);
  assert.strictEqual(validateStoreName("H-E-B"), true);
  assert.strictEqual(validateStoreName("Trader Joe's"), true);
  assert.strictEqual(validateStoreName("Stop & Shop"), true);
  assert.strictEqual(validateStoreName("Food 4 Less"), true);
});

test("rejects empty or non-string", () => {
  assert.strictEqual(validateStoreName(""), false);
  assert.strictEqual(validateStoreName(123), false);
  assert.strictEqual(validateStoreName(null), false);
});

test("rejects names over 50 chars", () => {
  assert.strictEqual(validateStoreName("A".repeat(51)), false);
});

test("rejects names with special characters", () => {
  assert.strictEqual(validateStoreName("Store<script>"), false);
  assert.strictEqual(validateStoreName("Store;DROP TABLE"), false);
});

// ── detectPerLb ─────────────────────────────────────────────────────────────

console.log("\ndetectPerLb:");

test("detects explicit per-lb size strings", () => {
  assert.strictEqual(detectPerLb("1 lb", "chicken breast", 4.99), true);
  assert.strictEqual(detectPerLb("per lb", "beef roast", 7.99), true);
  assert.strictEqual(detectPerLb("price/lb", "ground beef", 5.49), true);
});

test("detects meat by name pattern under $15", () => {
  assert.strictEqual(detectPerLb("16 oz", "boneless chicken breast", 4.99), true);
  assert.strictEqual(detectPerLb("", "ground beef 80/20", 5.99), true);
  assert.strictEqual(detectPerLb("", "atlantic salmon fillet", 8.99), true);
  assert.strictEqual(detectPerLb("", "pork tenderloin", 3.99), true);
});

test("detects produce by name pattern under $15", () => {
  assert.strictEqual(detectPerLb("", "red potatoes", 2.99), true);
  assert.strictEqual(detectPerLb("", "fresh strawberries", 3.49), true);
  assert.strictEqual(detectPerLb("", "yellow onion", 1.29), true);
});

test("does not flag non-meat/produce items", () => {
  assert.strictEqual(detectPerLb("12 oz", "pasta sauce", 2.99), false);
  assert.strictEqual(detectPerLb("16 oz", "cereal box", 4.99), false);
  assert.strictEqual(detectPerLb("64 oz", "milk whole", 3.49), false);
});

test("does not flag items priced at $15+", () => {
  assert.strictEqual(detectPerLb("", "chicken breast", 15.99), false);
});

test("does not flag items with zero price", () => {
  assert.strictEqual(detectPerLb("", "chicken breast", 0), false);
});

// ── getCategoryImage ────────────────────────────────────────────────────────

console.log("\ngetCategoryImage:");

test("returns exact match for known categories", () => {
  assert.strictEqual(getCategoryImage("meat"), CATEGORY_IMAGES.meat);
  assert.strictEqual(getCategoryImage("dairy"), CATEGORY_IMAGES.dairy);
  assert.strictEqual(getCategoryImage("frozen"), CATEGORY_IMAGES.frozen);
});

test("returns fuzzy match for category keywords", () => {
  assert.strictEqual(getCategoryImage("chicken breast"), CATEGORY_IMAGES.meat);
  assert.strictEqual(getCategoryImage("fresh vegetables"), CATEGORY_IMAGES.vegetables);
  assert.strictEqual(getCategoryImage("strawberry jam"), CATEGORY_IMAGES.fruits);
  assert.strictEqual(getCategoryImage("cheddar cheese"), CATEGORY_IMAGES.dairy);
  assert.strictEqual(getCategoryImage("tortilla chips"), CATEGORY_IMAGES.snacks);
  assert.strictEqual(getCategoryImage("cola soda"), CATEGORY_IMAGES.beverages);
  assert.strictEqual(getCategoryImage("deli platter"), CATEGORY_IMAGES.deli);
  assert.strictEqual(getCategoryImage("fresh salmon"), CATEGORY_IMAGES.seafood);
});

test("returns 'other' for null or unrecognized", () => {
  assert.strictEqual(getCategoryImage(null), CATEGORY_IMAGES.other);
  assert.strictEqual(getCategoryImage(""), CATEGORY_IMAGES.other);
  assert.strictEqual(getCategoryImage("random stuff"), CATEGORY_IMAGES.other);
});

// ── findDeal ────────────────────────────────────────────────────────────────

console.log("\nfindDeal:");

const sampleIngredients = [
  { name: "Boneless Chicken Breast", salePrice: "3.99", source: "kroger" },
  { name: "Simply Nature Organic Pasta", salePrice: "1.99", source: "aldi" },
  { name: "Ground Beef 80/20", salePrice: "4.49", source: "kroger" },
];

test("matches recipe ingredient to sale item", () => {
  const deal = findDeal("chicken breast", sampleIngredients);
  assert.ok(deal);
  assert.strictEqual(deal.name, "Boneless Chicken Breast");
});

test("matches ALDI brand-stripped ingredient", () => {
  const deal = findDeal("pasta", sampleIngredients);
  assert.ok(deal);
  assert.strictEqual(deal.name, "Simply Nature Organic Pasta");
});

test("returns null for no match", () => {
  assert.strictEqual(findDeal("salmon fillet", sampleIngredients), null);
});

test("returns null for empty ingredient name", () => {
  assert.strictEqual(findDeal("", sampleIngredients), null);
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
