// Regenerates public/data/us-states*.json from us-atlas (a devDependency,
// not shipped at runtime — same team/format as world-atlas, already used
// for the countries dataset).
//
// Run with: node scripts/generate-us-states-data.mjs
//
// Uses the pre-projected states-albers-10m.json rather than the raw
// states-10m.json: the raw file's 56 features include territories (Puerto
// Rico, Guam, American Samoa, Northern Mariana Islands, US Virgin
// Islands) spread across the whole Pacific/Caribbean, which the
// Albers USA projection isn't designed to handle (it's a fixed multiplex
// of three conics for the 50 states + DC only, out-of-range input
// degenerates). The albers file is already exactly the 51 states+DC,
// pre-projected with Alaska/Hawaii relocated into their conventional
// insets — see WorldMap.js's "identity" projection option, which expects
// coordinates already in that flat, SVG-ready space rather than raw
// lon/lat.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import topology from "us-atlas/states-albers-10m.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "data");

const geometries = topology.objects.states.geometries;

const items = geometries
  .map((g) => ({ id: g.id, name: g.properties.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(path.join(outDir, "us-states.json"), JSON.stringify(items, null, 2) + "\n");
writeFileSync(path.join(outDir, "us-states-topology.json"), JSON.stringify(topology));

console.log(`Wrote ${items.length} US states/DC to public/data/us-states.json`);
console.log("Wrote map topology to public/data/us-states-topology.json");
