// Regenerates public/data/us-states*.json from us-atlas (a devDependency,
// not shipped at runtime — same team/format as world-atlas, already used
// for the countries dataset).
//
// Run with: node scripts/generate-us-states-data.mjs
//
// Uses the raw lon/lat states-10m.json, projected at runtime by
// WorldMap's "albersUsa" projection (d3's geoAlbersUsa: Albers for the
// lower 48 with Alaska and Hawaii relocated into insets). This used to
// ship us-atlas's *pre-projected* states-albers-10m.json drawn with an
// identity projection — which meant no real coordinates at runtime, so no
// capital marker, no drop-a-pin modes and no km distances for US states.
// geoAlbersUsa can invert screen points back to lon/lat (including inside
// the Alaska/Hawaii insets), so all of those now work as on the world map.
//
// The raw file's 56 features include five territories (Puerto Rico, Guam,
// American Samoa, Northern Mariana Islands, US Virgin Islands) that
// geoAlbersUsa can't place (it only covers the 50 states + DC), so they're
// dropped — the same 51 features the pre-projected file had.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import us from "us-atlas/states-10m.json" with { type: "json" };
import { feature } from "topojson-client";
import { topology } from "topojson-server";
import { geoContains } from "d3-geo";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "data");

const TERRITORIES = new Set(["60", "66", "69", "72", "78"]);
const states = feature(us, us.objects.states).features.filter((f) => !TERRITORIES.has(f.id));
const outTopology = topology(
  { states: { type: "FeatureCollection", features: states.map((f) => ({ type: "Feature", id: f.id, properties: { name: f.properties.name }, geometry: f.geometry })) } },
  1e5
);
const geometries = outTopology.objects.states.geometries;

// State capitals' coordinates [lat, lon] (stable, well-known facts), for
// the capital marker and capital-scored pin mode. Checked below to fall
// inside their own state's shape.
const CAPITAL_LATLNG = {
  Alabama: [32.377, -86.3],
  Alaska: [58.302, -134.42],
  Arizona: [33.448, -112.074],
  Arkansas: [34.746, -92.29],
  California: [38.576, -121.494],
  Colorado: [39.739, -104.985],
  Connecticut: [41.764, -72.682],
  Delaware: [39.157, -75.52],
  Florida: [30.438, -84.281],
  Georgia: [33.749, -84.388],
  Hawaii: [21.307, -157.858],
  Idaho: [43.615, -116.202],
  Illinois: [39.798, -89.654],
  Indiana: [39.768, -86.158],
  Iowa: [41.591, -93.604],
  Kansas: [39.048, -95.678],
  Kentucky: [38.187, -84.875],
  Louisiana: [30.457, -91.187],
  Maine: [44.307, -69.782],
  Maryland: [38.979, -76.491],
  Massachusetts: [42.358, -71.064],
  Michigan: [42.733, -84.555],
  Minnesota: [44.955, -93.102],
  Mississippi: [32.303, -90.182],
  Missouri: [38.579, -92.173],
  Montana: [46.586, -112.018],
  Nebraska: [40.808, -96.7],
  Nevada: [39.164, -119.766],
  "New Hampshire": [43.207, -71.538],
  "New Jersey": [40.22, -74.77],
  "New Mexico": [35.682, -105.94],
  "New York": [42.653, -73.757],
  "North Carolina": [35.78, -78.639],
  "North Dakota": [46.821, -100.783],
  Ohio: [39.961, -82.999],
  Oklahoma: [35.492, -97.503],
  Oregon: [44.938, -123.03],
  Pennsylvania: [40.264, -76.884],
  "Rhode Island": [41.831, -71.415],
  "South Carolina": [34.0, -81.033],
  "South Dakota": [44.367, -100.346],
  Tennessee: [36.166, -86.784],
  Texas: [30.275, -97.74],
  Utah: [40.777, -111.888],
  Vermont: [44.262, -72.581],
  Virginia: [37.539, -77.434],
  Washington: [47.035, -122.905],
  "West Virginia": [38.336, -81.612],
  Wisconsin: [43.075, -89.384],
  Wyoming: [41.14, -104.82],
};

const CAPITALS = {
  Alabama: "Montgomery",
  Alaska: "Juneau",
  Arizona: "Phoenix",
  Arkansas: "Little Rock",
  California: "Sacramento",
  Colorado: "Denver",
  Connecticut: "Hartford",
  Delaware: "Dover",
  Florida: "Tallahassee",
  Georgia: "Atlanta",
  Hawaii: "Honolulu",
  Idaho: "Boise",
  Illinois: "Springfield",
  Indiana: "Indianapolis",
  Iowa: "Des Moines",
  Kansas: "Topeka",
  Kentucky: "Frankfort",
  Louisiana: "Baton Rouge",
  Maine: "Augusta",
  Maryland: "Annapolis",
  Massachusetts: "Boston",
  Michigan: "Lansing",
  Minnesota: "Saint Paul",
  Mississippi: "Jackson",
  Missouri: "Jefferson City",
  Montana: "Helena",
  Nebraska: "Lincoln",
  Nevada: "Carson City",
  "New Hampshire": "Concord",
  "New Jersey": "Trenton",
  "New Mexico": "Santa Fe",
  "New York": "Albany",
  "North Carolina": "Raleigh",
  "North Dakota": "Bismarck",
  Ohio: "Columbus",
  Oklahoma: "Oklahoma City",
  Oregon: "Salem",
  Pennsylvania: "Harrisburg",
  "Rhode Island": "Providence",
  "South Carolina": "Columbia",
  "South Dakota": "Pierre",
  Tennessee: "Nashville",
  Texas: "Austin",
  Utah: "Salt Lake City",
  Vermont: "Montpelier",
  Virginia: "Richmond",
  Washington: "Olympia",
  "West Virginia": "Charleston",
  Wisconsin: "Madison",
  Wyoming: "Cheyenne",
};

const items = geometries
  .map((g) => {
    const name = g.properties.name;
    const capital = CAPITALS[name] ?? null;
    const capitalLatLng = capital ? CAPITAL_LATLNG[name] : null;
    if (capital && !capitalLatLng) throw new Error(`No capital coordinates for ${name}`);
    return { id: g.id, name, capital, capitalLatLng };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
for (const g of geometries) delete g.properties;

// Sanity: 51 features (50 states + DC), every capital inside its state.
if (items.length !== 51) throw new Error(`Expected 51 states/DC, got ${items.length}`);
for (const it of items) {
  if (!it.capitalLatLng) continue;
  const f = states.find((x) => x.id === it.id);
  if (!geoContains(f, [it.capitalLatLng[1], it.capitalLatLng[0]])) throw new Error(`${it.capital} not inside ${it.name}`);
}

writeFileSync(path.join(outDir, "us-states.json"), JSON.stringify(items, null, 2) + "\n");
writeFileSync(path.join(outDir, "us-states-topology.json"), JSON.stringify(outTopology));

console.log(`Wrote ${items.length} US states/DC to public/data/us-states.json`);
console.log("Wrote map topology to public/data/us-states-topology.json");
