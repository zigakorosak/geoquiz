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
      latlng: [9.4942, 44.0269],
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
      latlng: [35.1856, 33.3823],
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
if (stillUnmatched.length) {
  console.log(
    `\n${stillUnmatched.length} map shapes have no matching country record and are not real governed territories, so they stay excluded (rendered muted, never playable):`
  );
  for (const u of stillUnmatched) console.log(`  - ${u.name} (id: ${u.id})`);
}
