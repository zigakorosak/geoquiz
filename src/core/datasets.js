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

// Items and topology are cached (and fetched) *separately*, because they
// have very different weights and very different consumers: the items file
// is small (~100KB for countries) and the wizard needs it early to show
// region/sovereignty item counts, while the topology is the heavy part
// (~750KB for the 50m world map) and nothing needs it until the game
// screen actually mounts a map. Splitting them means picking through the
// wizard never waits on — or even requests — the big file; it starts
// downloading on the final "Loading…" screen right before gameplay.
//
// Both caches hold *promises*, not results, so concurrent callers share
// one in-flight fetch. A failed fetch is evicted so a retry (e.g. going
// back and re-entering after a network blip) actually re-attempts instead
// of replaying the cached rejection forever.
const itemsCache = new Map();
const topologyCache = new Map();

// Check r.ok before parsing: a 404 typically returns an HTML error page,
// and letting that hit r.json() surfaces as a cryptic JSON parse error
// instead of saying which file failed to load.
const fetchJson = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Failed to load ${url}: HTTP ${r.status}`);
    return r.json();
  });

function cachedFetch(cache, key, url) {
  if (!cache.has(key)) {
    const promise = fetchJson(url);
    promise.catch(() => {
      if (cache.get(key) === promise) cache.delete(key);
    });
    cache.set(key, promise);
  }
  return cache.get(key);
}

export function listDatasetMeta() {
  return Object.values(datasetMeta);
}

// The lightweight half: just the quizzable items. What the wizard's
// region/sovereignty steps await for their counts.
export function loadItems(key) {
  const meta = datasetMeta[key];
  if (!meta) return Promise.reject(new Error(`Unknown dataset: ${key}`));
  return cachedFetch(itemsCache, key, meta.itemsUrl);
}

// The heavyweight half: the map topology. Only awaited where a map is
// actually about to render (startGame, map explore).
export function loadTopology(key) {
  const meta = datasetMeta[key];
  if (!meta) return Promise.reject(new Error(`Unknown dataset: ${key}`));
  return cachedFetch(topologyCache, key, meta.topologyUrl);
}

export async function loadDataset(key) {
  const meta = datasetMeta[key];
  if (!meta) throw new Error(`Unknown dataset: ${key}`);
  const [items, topology] = await Promise.all([loadItems(key), loadTopology(key)]);
  return { ...meta, items, topology };
}
