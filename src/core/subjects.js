// What the game quizzes you about. Deliberately broader than
// core/datasets.js: a subject that isn't built yet still gets listed here
// (disabled, "coming soon") so the wizard communicates the roadmap, but
// only `available: true` subjects reference a real `datasetKey`.
//
// `attributeKeys` scopes which of the dataset's attributes this subject's
// question/answer steps offer — gameWizard.js's promptAttributesFor/
// answerAttributesFor prefer it over the dataset's own (usually broader)
// attributeKeys. Countries and Capitals both point at the same
// `datasetKey: "countries"` (same underlying data — every item already
// carries a name, a location, *and* a capital; no separate fetch needed)
// but scope to a different pair of attributes, so they read as two
// distinct games rather than one with every fact bundled together. Since
// this is a per-*subject* override rather than something baked into the
// dataset itself, region.js's America → US States branch (which swaps
// `datasetKey` but keeps the rest of `subject` — see gameWizard.js's
// showSubRegionStep) carries whichever subject's attributeKeys the player
// already chose straight into US states too, as long as the target
// dataset's own items actually have that attribute (state capitals are
// hand-curated in generate-us-states-data.mjs).
export const subjects = [
  { key: "countries", label: "Countries", available: true, datasetKey: "countries", attributeKeys: ["name", "location"] },
  { key: "capitals", label: "Capitals", available: true, datasetKey: "countries", attributeKeys: ["capital", "location"] },
  { key: "flags", label: "Flags", available: false },
  { key: "emblems", label: "Emblems", available: false },
  { key: "currencies", label: "Currencies", available: false },
  { key: "cities", label: "Cities", available: false },
];
