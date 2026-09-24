// Sovereignty filter: a principled replacement for the old ad-hoc
// "extra territories" toggle. Uses the `independent` field already
// present on every item (sourced from world-countries, `true`/`false`/
// `null` for contested cases like Kosovo) instead of a separate flag.
//
// "All Sovereign" naturally excludes both ordinary non-sovereign
// dependent territories (Puerto Rico, Bermuda, Hong Kong, ...) and the
// contested-status extra territories (Kosovo/Somaliland/Northern
// Cyprus — none have `independent === true`), so one filter does the
// job two separate concepts used to.

export const sovereigntyOptions = [
  { key: "all", label: "All", match: () => true },
  { key: "sovereign", label: "All Sovereign", match: (item) => item.independent === true },
];

export function getSovereignty(key) {
  return sovereigntyOptions.find((s) => s.key === key) ?? sovereigntyOptions[0];
}
