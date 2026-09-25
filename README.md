# GeoQuiz

A browser geography quiz: given some fact about a place (its name, its
location, its capital), guess another fact about it. Pick a **question
mode** and an **answer mode** independently and mix and match — show the
country name and click it on the map, or highlight a country and type its
name.

Live at **[zigakorosak.com/geoquiz](https://zigakorosak.com/geoquiz/)**.

## Features

- **Countries and Capitals** subjects (more — flags, emblems, currencies,
  cities — on the roadmap), each with its own question/answer combinations.
- **Four answer styles**: type the name, pick it from 2–6 multiple-choice
  options, click the map, or drop a pin on a borderless map (with a
  distance-from-target readout).
- **Region filtering** (Europe, Asia, Africa, the Americas, Oceania, or the
  whole world) and a sovereignty filter (all territories vs. sovereign
  states only), each showing how many items it'd leave you with.
- **US States**, reached from the Americas region step, with its own map
  and state capitals.
- A free-explore **Map** mode with no quiz mechanics — just click a country
  to see its name.
- Smooth scroll/pinch/drag zoom, with an unbounded world view that scrolls
  infinitely left/right instead of stopping at the antimeridian.
- Tiny countries and archipelagos get invisible, appropriately-sized click
  targets so they're actually selectable at normal zoom.
- Per-round timer with total/average time in the end-of-game summary.

## Tech stack

Vanilla JavaScript (ES modules), no UI framework. [Vite](https://vite.dev/)
for the dev server and build. [d3-geo](https://d3js.org/d3-geo) +
[topojson-client](https://github.com/topojson/topojson-client) to project
and render the world/state maps as SVG, [d3-zoom](https://d3js.org/d3-zoom)
for pan/zoom, [d3-delaunay](https://d3js.org/d3-delaunay) for the tiny-
country hit-area assist. No backend — fully static, data read from
`public/data/*.json` at runtime.

See [`DESIGN.md`](./DESIGN.md) for the full architecture writeup and
[`LOG.md`](./LOG.md) for a chronological history of what changed and why.

## Getting started

```bash
npm install
npm run dev       # dev server at http://localhost:5173
npm run build     # production build into dist/
npm run preview   # serve the production build locally
```

### Regenerating game data

Quiz data and map topologies are generated from upstream npm packages, not
hand-maintained:

```bash
npm run generate-data              # countries + world map (public/data/countries.json, world-50m.json)
npm run generate-us-states-data    # US states + map (public/data/us-states.json, us-states-topology.json)
```

Re-run these after bumping `world-countries`/`world-atlas`/`us-atlas`, or
to change the map resolution (see `MAP_RESOLUTION` in
`scripts/generate-data.mjs`).

### Archiving a snapshot

```bash
npm run archive -- <short-label>
```

Tars the project (excluding `node_modules`, `dist`, `archive`) into
`archive/<timestamp>_<label>.tar.gz`, keeping the 4 most recent snapshots.

## Deployment

Deploys are **manual only** — pushing to `main` does not trigger anything.
To push a build live:

```bash
gh workflow run "Deploy to Namecheap"
```

or trigger it from the repo's Actions tab. The workflow (`.github/workflows/
deploy.yml`) builds the site and FTPS-uploads `dist/` to Namecheap shared
hosting at `zigakorosak.com/geoquiz/`.

## Project structure

```
src/
  core/       — attribute/dataset/region/sovereignty registries, quiz engine
  map/        — reusable SVG map (WorldMap.js)
  ui/         — screens: home, wizard, game, map explore, settings
  main.js     — top-level screen router
public/data/  — generated quiz items + map topologies
scripts/      — data-generation and archiving scripts
```

## Docs conventions

This project keeps exactly two other markdown files: `DESIGN.md`
(architecture/design overview) and `LOG.md` (chronological change history).
Substantive changes are documented there rather than in new markdown files.
