// Probe the USASpending award-search API to confirm field names, filter
// behavior, and pagination BEFORE building the predictor. Run: npm run probe:usaspending
const ENDPOINT = "https://api.usaspending.gov/api/v2/search/spending_by_award/";

const body = {
  filters: {
    award_type_codes: ["A", "B", "C", "D"], // contract award types
    agencies: [{ type: "awarding", tier: "toptier", name: "Department of the Treasury" }],
    naics_codes: ["518210", "541511", "541512", "541519"],
    time_period: [{ start_date: "2019-10-01", end_date: "2025-09-30" }],
  },
  // Start with fields believed valid for award search; the API 422s and lists
  // valid names if any are wrong.
  fields: [
    "Award ID",
    "Recipient Name",
    "Award Amount",
    "Start Date",
    "End Date",
    "Awarding Agency",
    "Awarding Sub Agency",
    "NAICS",
    "Description",
  ],
  page: 1,
  limit: 15,
  sort: "Award Amount",
  order: "desc",
};

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

console.log("HTTP", res.status, res.statusText);
const rawText = await res.text();
if (!res.ok) {
  console.log("ERROR body:\n", rawText.slice(0, 1500));
  process.exit(0);
}

const json = JSON.parse(rawText);
console.log("page_metadata:", JSON.stringify(json.page_metadata));
console.log("results returned:", (json.results ?? []).length);
const first = (json.results ?? [])[0];
console.log("\nfirst result keys:", first ? Object.keys(first) : null);
console.log("\nfirst 3 results (End Date / Recipient / NAICS / Amount):");
for (const r of (json.results ?? []).slice(0, 3)) {
  console.log(
    `- End Date=${r["End Date"]} | ${r["Recipient Name"]} | NAICS=${JSON.stringify(r["NAICS"])} | $${r["Award Amount"]}\n    ${String(r["Description"] ?? "").slice(0, 90)}`
  );
}
