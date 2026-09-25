// Dataset registry: each entry pairs a data file (quizzable items) with a
// map topology and declares which attributes (from attributes.js) apply to
// its items. Adding a new dataset means adding one entry here plus its
// data files — no other module needs to change.
//
// Item/topology JSON is fetched lazily (not bundled) so picking a mode in
// the wizard stays instant even as datasets grow.

export const datasetMeta = {
  countries: {
    key: "countries",
    label: "World Countries",
    itemsUrl: `${import.meta.env?.BASE_URL ?? "/"}data/countries.json`,
    topologyUrl: `${import.meta.env?.BASE_URL ?? "/"}data/world-50m.json`,
    topologyObject: "countries",
    attributeKeys: ["name", "location", "capital"],
    supportsRegionFilter: true,
    supportsSovereigntyFilter: true,
    // Country-id pairs whose *shared* border (not their whole outline —
    // WorldMap uses topojson's mesh() to extract just the arc the two
    // actually share) renders dashed, to flag a disputed frontier rather
    // than draw it like a normal international border. Serbia (ccn3
    // "688") / Kosovo ("UNK") is the only one in this dataset so far;
    // world-countries' own record for Serbia lists "UNK" in its
    // `borders`, confirming they're topologically adjacent.
    dashedBorders: [["688", "UNK"]],
  },
  "us-states": {
    key: "us-states",
    label: "US States",
    itemsUrl: `${import.meta.env?.BASE_URL ?? "/"}data/us-states.json`,
    topologyUrl: `${import.meta.env?.BASE_URL ?? "/"}data/us-states-topology.json`,
    topologyObject: "states",
    attributeKeys: ["name", "location", "capital"],
    // Pre-projected (Albers USA, Alaska/Hawaii insets already applied) —
    // see WorldMap.js's PROJECTIONS map and generate-us-states-data.mjs.
    projection: "identity",
    // Not picked from the subject step like other datasets — reached via
    // the region step's America branch instead (regions.js), which is
    // also why there's nothing left to filter by once you're here: no
    // further region breakdown, and "sovereignty" isn't a concept that
    // applies to US states.
    supportsRegionFilter: false,
    supportsSovereigntyFilter: false,
  },
};

const loaded = new Map();

export function listDatasetMeta() {
  return Object.values(datasetMeta);
}

export async function loadDataset(key) {
  if (loaded.has(key)) return loaded.get(key);
  const meta = datasetMeta[key];
  if (!meta) throw new Error(`Unknown dataset: ${key}`);

  const [items, topology] = await Promise.all([
    fetch(meta.itemsUrl).then((r) => r.json()),
    fetch(meta.topologyUrl).then((r) => r.json()),
  ]);

  const dataset = { ...meta, items, topology };
  loaded.set(key, dataset);
  return dataset;
}
