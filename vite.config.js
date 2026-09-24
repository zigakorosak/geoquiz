import { defineConfig } from "vite";

// Deployed at https://<your-domain>/geoquiz/ (a subdirectory, not the
// domain root) — base must match so built asset URLs and the
// import.meta.env.BASE_URL-prefixed data fetches in core/datasets.js
// resolve correctly instead of pointing at the domain root.
export default defineConfig({
  base: "/geoquiz/",
});
