// Regenerates the static game data in public/data/ from upstream datasets.
//
// Sources (installed as devDependencies, not shipped at runtime):
//   - world-countries: attributes (name, capital, region, latlng, flag emoji,
//                      currencies, ...)
//   - world-atlas:     topojson world map, countries keyed by ISO 3166-1
//                      numeric id (ccn3)
//   - coat-of-arms:    real flag SVGs (dist/flags/4x3/, lowercase cca2) AND
//                      national emblem/coat-of-arms SVGs (dist/coats/,
//                      uppercase cca2), both rasterized here rather than
//                      shipped as-is. Flags were originally sourced from
//                      country-flag-icons instead — dropped after its
//                      flags turned out to be simplified/inaccurate for
//                      anything with real detail in it (Mexico's coat of
//                      arms reduced to a vague blob, Brazil's globe
//                      missing its stars and motto entirely — fine for a
//                      small UI icon, wrong for a quiz where the actual
//                      design is the point). coat-of-arms' own flags are
//                      the genuine, detailed designs (verified directly,
//                      rasterized and looked — Mexico's eagle, Brazil's
//                      stars and "ORDEM E PROGRESSO", Nepal's actual
//                      double-pennant shape, Turkmenistan's carpet
//                      stripe, Saudi Arabia's calligraphy, all correct —
//                      an exhaustive later audit of every flag then in use
//                      found exactly one more mistake, this time upstream
//                      in the package itself: `sh.svg` (Saint Helena) is
//                      byte-identical to `gb.svg` (the UK) but for its
//                      `id`, a plain Union Jack mislabeled as this
//                      territory's own distinct flag. See
//                      MISLABELED_FLAG_CODES below), at the cost of being
//                      real, occasionally large SVGs (up to ~180KB) —
//                      rasterized via the system `rsvg-convert` binary
//                      (librsvg — this project's own visual-verification
//                      tooling already relied on it; regenerating
//                      public/data/flags+emblems/ is what makes it a
//                      *required* dependency of this script, not merely a
//                      development convenience) down to a fixed-size PNG,
//                      the same treatment emblems already needed for the
//                      same reason (their own sources run up to ~1.9MB
//                      each). Coverage: flags 235/238, emblems ~206/238 —
//                      a country missing either gets
//                      `flagUrl`/`emblemUrl: null`, handled the same way a
//                      missing `capital` already is: excluded from that
//                      attribute's rounds via isAskable (gameWizard.js),
//                      rendered normally everywhere else.
//
// Requires `rsvg-convert` (librsvg) on PATH to regenerate flags/emblems —
// not needed to just run the game, only to reproduce public/data/
// flags+emblems/.
//
// Run with: node scripts/generate-data.mjs
//
// This keeps the game's country data reproducible from source instead of
// hand-maintained. Re-run after bumping either package, or after changing
// MAP_RESOLUTION / FIELDS below.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
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

// world-countries' own `currencies` is keyed by ISO 4217 code with a
// {name, symbol} value, and can (rarely) list more than one — e.g. a few
// small economies that also accept a neighbor's currency alongside their
// own. Only the first is used: a "Currencies" round asks for *the*
// currency, and picking one consistently (rather than joining multiple
// names together) keeps both the prompt and every multiple-choice/
// picture-choice option a single, clean value.
function primaryCurrencyName(currencies) {
  return Object.values(currencies ?? {})[0]?.name ?? null;
}

const MAP_RESOLUTION = "50m"; // one of: 110m (coarse), 50m (medium), 10m (fine, large)
// Target raster dimensions for flags/emblems. rsvg-convert's default
// preserveAspectRatio ("xMidYMid meet") fits each source's own aspect
// ratio *inside* its box rather than stretching it, so these only need to
// be roughly the right shape, not exact per-flag/emblem measurements —
// Nepal's actual double-pennant outline, say, still comes out correctly
// shaped, just letterboxed within whichever box it's given. Flags get a
// 4:3 box (their own source folder's convention, and the common flag
// aspect ratio) so a normal rectangular flag fills it with no wasted
// letterboxing; emblems get a square box, matching their typical shield/
// circular/seal shapes. Both sizes are reused for the (larger) prompt
// display and the (smaller) picture-choice thumbnail alike — CSS scales
// down for the latter; both are comfortably crisp scaled down, and
// detailed enough not to look muddy at prompt size either.
const FLAG_PX = [320, 240];
const EMBLEM_PX = [240, 240];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Written to public/, not src/, so the game fetches them at runtime instead
// of Vite inlining ~1MB of JSON into the JS bundle.
const outDir = path.join(__dirname, "..", "public", "data");
const flagsOutDir = path.join(outDir, "flags");
const emblemsOutDir = path.join(outDir, "emblems");
mkdirSync(flagsOutDir, { recursive: true });
mkdirSync(emblemsOutDir, { recursive: true });

// Both flags and emblems come from the *same* coat-of-arms package now —
// see the header comment for why country-flag-icons (the original flag
// source) was dropped. Its flags live under dist/flags/4x3/, keyed by
// *lowercase* cca2 (unlike dist/coats/'s uppercase); resolved as a plain
// node_modules path rather than through the package's own JS API, since
// all that's actually needed is the raw SVG file it ships, not its
// (React-oriented) exported components.
const FLAG_SVG_DIR = path.join(__dirname, "..", "node_modules", "coat-of-arms", "dist", "flags", "4x3");
const COAT_SVG_DIR = path.join(__dirname, "..", "node_modules", "coat-of-arms", "dist", "coats");

function rasterize(svgSrc, pngOut, [w, h]) {
  execFileSync("rsvg-convert", ["-w", String(w), "-h", String(h), svgSrc, "-o", pngOut]);
}

// Resolves one country's flag + emblem, returning the pair of paths
// (relative to public/, matching how countries.json's other URLs — see
// core/datasets.js — are stored BASE_URL-agnostic and prefixed with
// import.meta.env.BASE_URL at fetch time, since this script has no access
// to that browser-only value) the client can load each from, or null for
// either the source package doesn't cover. Both are rasterized — real,
// detailed SVGs, up to ~180KB (flags) / ~1.9MB (emblems), far too heavy
// to ship per-round as-is.
// coat-of-arms' own flag SVGs, verified one by one (rasterized + visually
// checked against the real thing): every entry matched, except this one —
// `sh.svg` (Saint Helena, Ascension and Tristan da Cunha) is byte-identical
// to `gb.svg` (the UK) but for its `id` attribute, i.e. upstream mislabeled
// a plain Union Jack as this territory's own flag (a distinct design: a
// Blue Ensign with a shield charge on the fly). No other flag in the
// package has this problem — `au`/`hm` and the various French-territory
// codes sharing a file with `fr` are legitimately identical (those
// territories really do fly Australia's/France's own flag, unlike this
// one). Same "leave null rather than guessed" policy as any other field
// with no reliable value (see the header comment) — country-flag-icons,
// the original flag source, is no longer installed (see FLAG_SVG_DIR's own
// comment) so there's nothing else local to fall back to, and hand-drawing
// the real shield here risks trading one inaccurate flag for another.
const MISLABELED_FLAG_CODES = new Set(["SH"]);

function resolveFlagAndEmblem(cca2) {
  if (!cca2) return { flagUrl: null, emblemUrl: null };

  const flagSrc = path.join(FLAG_SVG_DIR, `${cca2.toLowerCase()}.svg`);
  let flagUrl = null;
  if (existsSync(flagSrc) && !MISLABELED_FLAG_CODES.has(cca2)) {
    rasterize(flagSrc, path.join(flagsOutDir, `${cca2}.png`), FLAG_PX);
    flagUrl = `data/flags/${cca2}.png`;
  }

  const coatSrc = path.join(COAT_SVG_DIR, `${cca2}.svg`);
  let emblemUrl = null;
  if (existsSync(coatSrc)) {
    rasterize(coatSrc, path.join(emblemsOutDir, `${cca2}.png`), EMBLEM_PX);
    emblemUrl = `data/emblems/${cca2}.png`;
  }

  return { flagUrl, emblemUrl };
}

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
      // world-countries has real currency data for Kosovo (it just lacks
      // the ccn3 id that would otherwise let it join the standard path
      // below) — the Euro, unilaterally adopted despite Kosovo being
      // outside the Eurozone proper.
      currency: primaryCurrencyName(kosovoSource.currencies),
      ...resolveFlagAndEmblem(kosovoSource.cca2),
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
      // Its own unrecognized currency, not used anywhere with an ISO 4217
      // code (no cca2 to look one up by regardless) — public knowledge.
      currency: "Somaliland shilling",
      flagUrl: null,
      emblemUrl: null,
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
      currency: "Turkish lira", // uses Turkey's currency, not its own
      flagUrl: null,
      emblemUrl: null,
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
// Antarctica (ccn3 "010") is excluded from the game outright: it isn't a
// country (no government, no capital, no real flag — the "True South" flag
// world-countries ships is unofficial), so quizzing on it never made
// sense. Its topology shape stays in the map data — with no item carrying
// its id it renders muted and unplayable, same as any other non-playable
// shape.
const EXCLUDED_CCN3 = new Set(["010"]);

const gameCountries = countries
  .filter((c) => mapIds.has(c.ccn3) && !EXCLUDED_CCN3.has(c.ccn3))
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
    currency: primaryCurrencyName(c.currencies),
    ...resolveFlagAndEmblem(c.cca2),
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

const withFlag = gameCountries.filter((c) => c.flagUrl).length;
const withEmblem = gameCountries.filter((c) => c.emblemUrl).length;
const withCurrency = gameCountries.filter((c) => c.currency).length;
console.log(
  `\nFlags: ${withFlag}/${gameCountries.length}. Emblems: ${withEmblem}/${gameCountries.length}. Currencies: ${withCurrency}/${gameCountries.length}.`
);
const missingEmblem = gameCountries.filter((c) => !c.emblemUrl);
if (missingEmblem.length) {
  console.log(`Countries with no emblem (excluded from Emblems rounds, still playable everywhere else):`);
  for (const c of missingEmblem) console.log(`  - ${c.name}`);
}

if (stillUnmatched.length) {
  console.log(
    `\n${stillUnmatched.length} map shapes have no matching country record and are not real governed territories, so they stay excluded (rendered muted, never playable):`
  );
  for (const u of stillUnmatched) console.log(`  - ${u.name} (id: ${u.id})`);
}
