// Persistent, app-wide preferences (as opposed to per-game choices made
// in the games wizard, which reset every time). Backed by localStorage so
// they survive reloads; falls back to defaults if storage is unavailable
// (private browsing, etc.) or holds unexpected data.

const STORAGE_KEY = "geo-quiz-settings";

const defaults = {
  keepZoom: true,
};

export function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return { ...defaults, ...stored };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private browsing, quota, etc.) — setting just
    // won't persist across reloads this session, not worth surfacing.
  }
}
