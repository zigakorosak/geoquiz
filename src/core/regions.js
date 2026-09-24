// Region filter registry. Kept separate from attributes.js (which
// describes quizzable facts) since a region is a filter over *which
// items* are in play, not a fact to ask about.
//
// Entries form a two-level tree: a top-level entry either has `match`
// (a leaf, directly selectable — Europe, Asia, Oceania, World) or
// `children` (a branch — Africa, America — where the branch itself isn't
// directly selectable, only one of its children is; the games wizard
// shows a second screen for these). Every leaf's `match(item)` expects
// `region`/`subregion` fields shaped like world-countries' (UN geoscheme).
//
// Africa splits into North (the UN's own "Northern Africa" subregion) and
// the rest ("Southern Africa" colloquially, though it spans all of
// Eastern/Middle/Southern/Western Africa) — world-countries has no
// finer-grained field, so this is the only two-way split available.
//
// America splits into North, South, and Caribbean. Central America is
// folded into North America (the traditional continent boundary runs at
// the Panama/Colombia border, not narrower), so this is a 3-way split of
// world-countries' 4 Americas subregions rather than 1:1 with them.

// A couple of Caribbean-subregion countries sit on the South American
// continental shelf / right off its coast and are commonly grouped with
// South America despite the UN geoscheme filing them under "Caribbean":
// Trinidad and Tobago (on the shelf itself, a few km from Venezuela) and
// Grenada (southernmost of the Windward Islands, same arc). Named
// explicitly rather than by any subregion split, since world-countries
// doesn't have a finer-grained field to key off. Still excluded from the
// Caribbean bucket now that Caribbean is its own selectable region.
const SOUTH_AMERICA_OVERRIDES = new Set(["Trinidad and Tobago", "Grenada"]);

// Georgia and Türkiye are treated as Europe-only canonically here (world-
// countries files both under `region: "Asia"`, but per explicit user
// direction they should count as European, not Asian, for region
// membership) — excluded from Asia's own match below.
const EUROPE_ONLY = new Set(["Georgia", "Türkiye"]);

// Countries that are canonically Europe (natively, or via EUROPE_ONLY
// above) but should *also* be offered when the player picks Asia —
// real cultural/geographic ties there (Caucasus, Anatolia, Russia east of
// the Urals, Cyprus's proximity to the Middle East) even though they
// don't get their own region membership changed. This is the one
// intentional overlap in the whole region tree: every other pair of
// regions partitions its items with no overlap, but these four are real
// enough edge cases that Asia excluding them entirely would feel wrong
// in play, without actually being "Asian" for Europe's own count.
const ASIA_BONUS = new Set(["Georgia", "Türkiye", "Cyprus", "Russia"]);

export const regions = [
  {
    key: "europe",
    label: "Europe",
    match: (item) => item.region === "Europe" || EUROPE_ONLY.has(item.name),
  },
  {
    key: "asia",
    label: "Asia",
    match: (item) => (item.region === "Asia" && !EUROPE_ONLY.has(item.name)) || ASIA_BONUS.has(item.name),
  },
  {
    key: "africa",
    label: "Africa",
    children: [
      {
        key: "africa-north",
        label: "North Africa",
        match: (item) => item.region === "Africa" && item.subregion === "Northern Africa",
      },
      {
        key: "africa-south",
        label: "Southern Africa",
        match: (item) => item.region === "Africa" && item.subregion !== "Northern Africa",
      },
    ],
  },
  {
    key: "americas",
    label: "America",
    children: [
      {
        key: "america-north",
        label: "North America",
        match: (item) =>
          item.region === "Americas" &&
          ["North America", "Central America"].includes(item.subregion) &&
          !SOUTH_AMERICA_OVERRIDES.has(item.name),
      },
      {
        key: "america-south",
        label: "South America",
        match: (item) =>
          item.region === "Americas" &&
          (item.subregion === "South America" || SOUTH_AMERICA_OVERRIDES.has(item.name)),
      },
      {
        key: "america-caribbean",
        label: "Caribbean",
        match: (item) =>
          item.region === "Americas" && item.subregion === "Caribbean" && !SOUTH_AMERICA_OVERRIDES.has(item.name),
      },
      // Not a filter over the countries dataset like its siblings — this
      // one switches the whole game to a different dataset instead
      // (`datasetKey`, no `match`). The games wizard's sub-region step
      // special-cases entries with `datasetKey`: see gameWizard.js.
      { key: "us-states", label: "US States", datasetKey: "us-states" },
    ],
  },
  { key: "oceania", label: "Oceania", match: (item) => item.region === "Oceania" },
  { key: "world", label: "World", match: () => true },
];

export function getRegion(key) {
  for (const r of regions) {
    if (r.key === key) return r;
    const child = r.children?.find((c) => c.key === key);
    if (child) return child;
  }
  return regions.find((r) => r.key === "world");
}
