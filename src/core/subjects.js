// What the game quizzes you about. Deliberately broader than
// core/datasets.js: a subject that isn't built yet still gets listed here
// (disabled, "coming soon") so the wizard communicates the roadmap, but
// only `available: true` subjects reference a real `datasetKey`.

export const subjects = [
  { key: "countries", label: "Countries", available: true, datasetKey: "countries" },
  { key: "capitals", label: "Capitals", available: false },
  { key: "flags", label: "Flags", available: false },
  { key: "emblems", label: "Emblems", available: false },
  { key: "currencies", label: "Currencies", available: false },
  { key: "cities", label: "Cities", available: false },
];
