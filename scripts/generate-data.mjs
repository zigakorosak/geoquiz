// Regenerates the static game data in public/data/ from upstream datasets.
//
// Sources (installed as devDependencies, not shipped at runtime):
//   - world-countries: attributes (name, capital, region, latlng, flag emoji, ...)
//   - world-atlas:     topojson world map, countries keyed by ISO 3166-1 numeric id (ccn3)
//
// Run with: node scripts/generate-data.mjs
//
// This keeps the game's country data reproducible from source instead of
// hand-maintained. Re-run after bumping either package, or after changing
// MAP_RESOLUTION / FIELDS below.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import countries from "world-countries";
import citiesData from "cities.json" with { type: "json" };

// --- Capital coordinates ---------------------------------------------------
//
// world-countries' own `latlng` field is each country's rough centroid, not
// its capital's location (e.g. Australia's `latlng` sits in central
// Australia, nowhere near Canberra) — no upstream package used elsewhere in
// this script carries real capital coordinates. cities.json (GeoNames-
// derived, CC-BY-4.0 — the one non-permissive-license source this project
// uses; only its lat/lng values end up in the shipped data, not the package
// itself) does, joined here by (ISO 3166-1 alpha-2 code, normalized city
// name) against each country's own `capital` field. Covers the vast
// majority of countries automatically; the handful cities.json doesn't
// resolve by name (a different transliteration, or genuinely absent) get an
// explicit override below, sourced from cities.json itself wherever it has
// the place under a different name, or public knowledge otherwise.
function normalizeCityName(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/^city of /, "") // "City of San Marino" / "City of Victoria" (Hong Kong)
    .replace(/\bst\.?\b/g, "saint") // "St. George's" / "St. Peter Port" -> cities.json spells both "Saint ..."
    .replace(/['’‘]/g, "") // "Sana'a"/"Nuku'alofa" -> "sanaa"/"nukualofa", matching cities.json's own spellings (no inserted space, unlike other punctuation below) — cities.json itself is inconsistent about which of the three it uses for the same kind of name
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const citiesByCountry = new Map();
for (const city of citiesData) {
  if (!citiesByCountry.has(city.country)) citiesByCountry.set(city.country, []);
  citiesByCountry.get(city.country).push(city);
}

// Keyed by world-countries' own `name.common`, checked before the
// normalized-name join below (so it always wins, e.g. for the US, where a
// plain "Washington" join would otherwise ambiguously match one of many
// same-named US cities rather than specifically Washington, D.C.).
const CAPITAL_LATLNG_OVERRIDES = {
  Myanmar: [19.745, 96.12972], // Naypyidaw / "Nay Pyi Taw" in cities.json
  "Western Sahara": [27.1418, -13.18797], // El Aaiún / "Laayoune" in cities.json
  "South Georgia": [-54.28111, -36.5092], // King Edward Point has no separate entry in cities.json; Grytviken, the only real settlement on the island, sits right next to it
  "British Indian Ocean Territory": [-7.3195, 72.4229], // Diego Garcia; not in cities.json at all, public-knowledge coordinates
  Kiribati: [1.3278, 172.97696], // South Tarawa / "Tarawa" in cities.json
  "United States": [38.89511, -77.03637], // Washington, D.C.'s own cities.json entry (admin1 "DC"), not the ambiguous plain-name join
};

function findCapitalLatLng(name, cca2, capital) {
  if (!capital) return null;
  if (CAPITAL_LATLNG_OVERRIDES[name]) return CAPITAL_LATLNG_OVERRIDES[name];
  const candidates = cca2 ? citiesByCountry.get(cca2) : null;
  if (!candidates) return null;
  const target = normalizeCityName(capital);
  const hit = candidates.find((c) => normalizeCityName(c.name) === target);
  return hit ? [Number(hit.lat), Number(hit.lng)] : null;
}

const MAP_RESOLUTION = "50m"; // one of: 110m (coarse), 50m (medium), 10m (fine, large)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Written to public/, not src/, so the game fetches them at runtime instead
// of Vite inlining ~1MB of JSON into the JS bundle.
const outDir = path.join(__dirname, "..", "public", "data");

const topoModule = await import(`world-atlas/countries-${MAP_RESOLUTION}.json`, {
  with: { type: "json" },
});
const topology = topoModule.default;
const geometries = topology.objects.countries.geometries;

// --- Extra territories --------------------------------------------------
//
// A handful of topojson shapes have no ISO 3166-1 numeric id and so never
// match anything in world-countries by ccn3. Most aren't really governed
// places (a glacier, an uninhabited administrative territory) and stay
// excluded permanently — see the unmatched-shapes log at the bottom. Three
// are real, populated, partially-recognized states worth offering as an
// opt-in "extra territories" setting:
//   - Kosovo: world-countries actually has full data for it already (name,
//     capital, region, ...), it just has no ccn3 — joined here by the
//     topology's feature name instead, using its cca3 "UNK" as the id.
//   - Somaliland / Northern Cyprus: not in world-countries at all.
//     Hand-curated below from public knowledge, since no upstream package
//     has them. Fields with no real/stable value (cca2/cca3, flag emoji —
//     neither has an assigned Unicode flag) are left null rather than
//     guessed.
const kosovoSource = countries.find((c) => c.name.common === "Kosovo");

const EXTRA_TERRITORIES = [
  {
    topologyName: "Kosovo",
    record: {
      id: kosovoSource.cca3, // "UNK"
      cca2: kosovoSource.cca2,
      cca3: kosovoSource.cca3,
      name: kosovoSource.name.common,
      officialName: kosovoSource.name.official,
      capital: kosovoSource.capital?.[0] ?? null,
      region: kosovoSource.region,
      subregion: kosovoSource.subregion,
      latlng: kosovoSource.latlng,
      // world-countries' own centroid, not Pristina's own coordinates
      // specifically (no cca2 means it can't join against cities.json the
      // normal way) — close enough given how small Kosovo's whole territory
      // is (~10,900 km²) for this to still be a reasonable stand-in.
      capitalLatLng: kosovoSource.latlng,
      flagEmoji: kosovoSource.flag,
      independent: kosovoSource.independent,
      area: kosovoSource.area,
    },
  },
  {
    topologyName: "Somaliland",
    record: {
      id: "SML",
      cca2: null,
      cca3: null,
      name: "Somaliland",
      officialName: "Republic of Somaliland",
      capital: "Hargeisa",
      region: "Africa",
      subregion: "Eastern Africa",
      latlng: [9.4942, 44.0269], // already Hargeisa's own coordinates, not a separate country-wide centroid
      capitalLatLng: [9.4942, 44.0269],
      flagEmoji: null,
      independent: false,
      area: 176120,
    },
  },
  {
    topologyName: "N. Cyprus",
    record: {
      id: "XNC",
      cca2: null,
      cca3: null,
      name: "Northern Cyprus",
      officialName: "Turkish Republic of Northern Cyprus",
      capital: "North Nicosia",
      region: "Europe",
      subregion: "Southern Europe",
      latlng: [35.1856, 33.3823], // already North Nicosia's own coordinates
      capitalLatLng: [35.1856, 33.3823],
      flagEmoji: null,
      independent: false,
      area: 3355,
    },
  },
];

for (const { topologyName, record } of EXTRA_TERRITORIES) {
  const geom = geometries.find((g) => g.properties?.name === topologyName);
  if (geom) geom.id = record.id;
}

const extraRecords = EXTRA_TERRITORIES.map(({ record }) => ({ ...record, isExtraTerritory: true }));

// --- Standard countries ---------------------------------------------------

const byCcn3 = new Map(countries.map((c) => [c.ccn3, c]).filter(([ccn3]) => ccn3));
const mapIds = new Set();
const stillUnmatched = [];

for (const geom of geometries) {
  if (geom.id && byCcn3.has(geom.id)) {
    mapIds.add(geom.id);
  } else if (!EXTRA_TERRITORIES.some((t) => t.topologyName === geom.properties?.name)) {
    stillUnmatched.push({ id: geom.id ?? null, name: geom.properties?.name ?? null });
  }
}

// Game dataset: one record per country that has both attribute data AND a
// shape on the map, keyed by id = ccn3 (matches the topojson feature id),
// plus the hand-curated extra territories above (isExtraTerritory: true,
// opt-in at play time — see core/datasets.js / core/continents.js usage).
const gameCountries = countries
  .filter((c) => mapIds.has(c.ccn3))
  .map((c) => ({
    id: c.ccn3,
    cca2: c.cca2,
    cca3: c.cca3,
    name: c.name.common,
    officialName: c.name.official,
    capital: c.capital?.[0] ?? null,
    region: c.region,
    subregion: c.subregion,
    latlng: c.latlng,
    capitalLatLng: findCapitalLatLng(c.name.common, c.cca2, c.capital?.[0] ?? null),
    flagEmoji: c.flag,
    independent: c.independent,
    area: c.area,
    isExtraTerritory: false,
  }))
  .concat(extraRecords)
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(
  path.join(outDir, "countries.json"),
  JSON.stringify(gameCountries, null, 2) + "\n"
);

writeFileSync(
  path.join(outDir, `world-${MAP_RESOLUTION}.json`),
  JSON.stringify(topology)
);

const extraCount = extraRecords.length;
console.log(
  `Wrote ${gameCountries.length} countries to public/data/countries.json (${gameCountries.length - extraCount} standard + ${extraCount} extra territories)`
);
console.log(`Wrote map topology to public/data/world-${MAP_RESOLUTION}.json`);

const missingCapitalLatLng = gameCountries.filter((c) => c.capital && !c.capitalLatLng);
if (missingCapitalLatLng.length) {
  console.log(
    `\n${missingCapitalLatLng.length} countries have a capital but no capitalLatLng — cities.json's normalized-name join didn't find a match and there's no CAPITAL_LATLNG_OVERRIDES entry either:`
  );
  for (const c of missingCapitalLatLng) console.log(`  - ${c.name} (capital: ${c.capital})`);
} else {
  console.log(`\nEvery country with a capital has a resolved capitalLatLng.`);
}

if (stillUnmatched.length) {
  console.log(
    `\n${stillUnmatched.length} map shapes have no matching country record and are not real governed territories, so they stay excluded (rendered muted, never playable):`
  );
  for (const u of stillUnmatched) console.log(`  - ${u.name} (id: ${u.id})`);
}
