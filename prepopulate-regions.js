// prepopulate-regions.js
// Run this once a week to pre-cache Flipp deals for major US metro areas.
// Usage: node prepopulate-regions.js
//
// This sends representative zip codes to your server's prepopulate endpoint.
// Each 3-digit zip prefix = one ad region. The server will skip already-cached regions.

const SERVER = "http://127.0.0.1:5000";

// One zip per major metro area — covers the biggest grocery markets
// The 3-digit prefix of each zip defines the cached region
const METRO_ZIPS = [
  // Northeast
  "10001", // New York, NY (100)
  "10301", // Staten Island, NY (103)
  "11201", // Brooklyn, NY (112)
  "07001", // New Jersey (070)
  "08501", // NJ - Trenton area (085)
  "19101", // Philadelphia, PA (191)
  "02101", // Boston, MA (021)
  "06101", // Hartford, CT (061)
  "20001", // Washington, DC (200)
  "21201", // Baltimore, MD (212)
  "15201", // Pittsburgh, PA (152)
  "14201", // Buffalo, NY (142)
  "06901", // Stamford, CT (069)

  // Southeast
  "30301", // Atlanta, GA (303)
  "33101", // Miami, FL (331)
  "32801", // Orlando, FL (328)
  "33601", // Tampa, FL (336)
  "27601", // Raleigh, NC (276)
  "28201", // Charlotte, NC (282)
  "37201", // Nashville, TN (372)
  "40201", // Louisville, KY (402)
  "29401", // Charleston, SC (294)
  "23219", // Richmond, VA (232)
  "35201", // Birmingham, AL (352)

  // Midwest
  "60601", // Chicago, IL (606)
  "48201", // Detroit, MI (482)
  "43210", // Columbus, OH (432)
  "44101", // Cleveland, OH (441)
  "45201", // Cincinnati, OH (452)
  "46201", // Indianapolis, IN (462)
  "53201", // Milwaukee, WI (532)
  "55401", // Minneapolis, MN (554)
  "63101", // St. Louis, MO (631)
  "64101", // Kansas City, MO (641)
  "68101", // Omaha, NE (681)

  // South/Southwest
  "75201", // Dallas, TX (752)
  "77001", // Houston, TX (770)
  "78201", // San Antonio, TX (782)
  "73101", // Oklahoma City, OK (731)
  "70112", // New Orleans, LA (701)

  // West
  "85001", // Phoenix, AZ (850)
  "80201", // Denver, CO (802)
  "84101", // Salt Lake City, UT (841)
  "87101", // Albuquerque, NM (871)
  "89101", // Las Vegas, NV (891)
  "90001", // Los Angeles, CA (900)
  "92101", // San Diego, CA (921)
  "94101", // San Francisco, CA (941)
  "95101", // San Jose, CA (951)
  "97201", // Portland, OR (972)
  "98101", // Seattle, WA (981)
  "96801", // Honolulu, HI (968)
];

async function run() {
  console.log(`Pre-populating ${METRO_ZIPS.length} metro regions...\n`);

  // Send in batches of 5 to avoid overwhelming the server
  for (let i = 0; i < METRO_ZIPS.length; i += 5) {
    const batch = METRO_ZIPS.slice(i, i + 5);
    console.log(`Batch ${Math.floor(i/5)+1}: zips ${batch.join(", ")}`);

    try {
      const res = await fetch(`${SERVER}/api/admin/prepopulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zips: batch }),
      });
      const data = await res.json();

      for (const r of data.results) {
        const icon = r.status === "fetched" ? "🆕" : r.status === "already cached" ? "✅" : "❌";
        console.log(`  ${icon} ${r.region} (${r.zip}): ${r.status} — ${r.deals || 0} deals`);
      }
    } catch (e) {
      console.error(`  ❌ Batch failed: ${e.message}`);
    }

    // Wait between batches
    if (i + 5 < METRO_ZIPS.length) {
      console.log("  ⏳ Waiting 10s before next batch...\n");
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  // Check final status
  try {
    const res = await fetch(`${SERVER}/api/admin/cache-status`);
    const data = await res.json();
    console.log(`\n✅ Done! ${data.totalCached} regions cached, ${data.freshCount} fresh.`);
  } catch (e) {
    console.log("\nDone! Check http://127.0.0.1:5000/api/admin/cache-status for results.");
  }
}

run();
