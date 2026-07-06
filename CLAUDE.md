# mapscad — notes for Claude

Turns DEM (elevation) data into 3D-printable terrain models. TypeScript + Svelte 5
(runes) + webpack. Two side-by-side panels: a 2D/3D map (for picking an area) and a
Three.js preview of the printable mesh.

> This is the **public** repo — all app code and tests live **here**. Paths below are relative to
> this repo root.
>
> Keep this file scoped to the public codebase: architecture, conventions, and build/verify steps
> that any contributor needs. Do **not** add personal or environment-specific preferences (editor
> setup, private tooling, individual workflow habits, deployment secrets) — those belong in a
> contributor's own local config, not in the shared repo.

## Architecture (the load-bearing pieces)

- **Engine abstraction** — `src/engine/MapEngine.ts` is the only map interface the app knows.
  Concrete engines: `OpenLayersEngine` (2D tiles + the selection tool + computed 2D
  hillshade), `MapLibreTerrainEngine` (3D imagery/hillshade). `MapController` routes a source
  id to whichever engine owns it and mounts engines lazily. `src/index.ts` is the composition
  root — the only file that names concrete engines.
- **`MapModel` (`src/MapModel.ts`)** — the canonical 3D model. `ModelSettings` + a `HeightGrid`
  go in; `buildGeometry()` emits neutral metre-space geometry consumed by **both** the preview
  (`src/TerrainPreview.ts`) and the STL exporter (`src/StlMaker.ts`). Add an **export** setting here
  (interface + `DEFAULT_MODEL_SETTINGS` + `sanitize`) — all co-located.
- **`MapElementManager` (`src/osm/MapElementManager.ts`)** — the single source of truth for
  *map-element object data* (OSM tracks/streets/buildings today; more element types later). A
  plain, framework-agnostic domain model: it knows nothing about OpenLayers, Three.js, or Svelte.
  It owns each feature type's element set (`OsmElement[]` incl. the `disabled` flag) and whether
  it's bound into the print (`inPreview`), and exposes per-feature ops via a `FeatureView`:
  `download` (through an injected `MapElementSource`), `loadFiles` (saved JSON **and** GPX/TCX
  via `src/osm/TrackParser.ts`, merged + id-deduped), `save`, `setEnabled`, `remove`,
  `updatePreview`. It announces exactly two typed events — `dataChanged` / `previewChanged`.
  `src/index.ts` is its **renderer**: it subscribes and drives the OL overlays + `MapModel`; the
  Data panel (`src/ui/OsmDataPanel.svelte`) subscribes independently to render the object list.
  **The boundary rule: does it influence the final 3D model? → it's the manager's business**
  (element sets, `disabled`, `inPreview`). Selection highlight, the staging "marks" set (until a
  commit), hover, filter text, and download-button progress are UI-only and stay in Svelte —
  a different UI could do them differently. Guard: `tests/unit/mapElementManager.test.ts`.
- **Processors (`src/model/processors.ts`)** — the three tool stages, as a pluggable, unified
  API (this is where custom/future tools plug in). `buildGeometry()` runs them in order:
  - `ElevationGridProcessor` (`process(grid) → grid`) reshapes the WHOLE grid first and **may
    change its dimensions** (insert/drop rows & cols, crop, resample, composite sources).
    `TileDividerProcessor` lives here and **is how tiling now works**: `tilesEnabled`/`tilesX`/
    `tilesY` → `MapModel.gridProcessors()` builds a `TileDividerProcessor` that splits the grid
    into blocks by injecting no-data (NaN) divider lines + a DUPLICATED seam on each side (so
    the cut loses no surface), growing the metre extents so per-cell scale is preserved. The
    no-data hole path then walls each block into its own body, so tiling emits **one solid
    whose disconnected bodies are the tiles** (the old per-block `buildTile` loop is gone).
    `StlMaker` writes the whole model to **one file** (was one-file-per-tile); a slicer's
    "split to objects" separates the bodies for multi-part/multi-colour printing.
  - `ElevationValueProcessor` (`process(value, ctx) → value`, was `ElevationProcessor`)
    transforms a height VALUE per grid cell before any geometry exists — `HeightScaleProcessor`,
    `WaterProcessor`, and future per-cell ops (carve roads, raise buildings, user scripts).
    `ctx.raw` is the original sampled height (so water keeps its cutoff on the un-exaggerated
    value); chain order is height-scale THEN water. `applyElevation()` runs the chain once into
    a `processed` Float32 field that the surface + socket both read.
  - `VertexProcessor` (`process(mesh)`) mutates an assembled solid's mesh — `SocketProcessor`
    (closes the open sheet); future mesh ops (extrude footprints). Runs per emitted tile.
  - No-data (`NaN`) carves holes: `MapModel` skips any cell with a missing corner and routes
    through `buildMaskedTile` (walls every dropped-neighbour edge). Both real DEM gaps and the
    injected tile dividers flow through this one path. The **oval** carries its own per-cell
    socket in `buildMaskedTile` (the rectangle `SocketProcessor` doesn't apply to it). Geometry
    helpers live in `src/model/geometry.ts`.
  - The split is output-preserving — `mapModel.test` + the golden STL e2e are the guards.
  - **North star (don't lose this in the details):** this pluggable chain is the seed of a
    **CAD-style feature history** — an ordered, serialized list of steps the user can reorder
    (drag & drop), reconfigure, enable/disable, and re-run, where custom user tools slot in at
    a chosen point and the system returns sensible errors for orders that don't make sense.
    The hard rule that survives every iteration: **elevation steps (2D height field) run
    before the fixed surface lift, vertex steps (3D mesh) run after** — that phase boundary is
    where ordering is constrained. Today's two fixed chains are just the degenerate case. Full
    plan in the roadmap (the private root `../todo.md`, "CAD-style processor history"); keep new
    processor work compatible with it.
- **`PreviewConfig` (`src/PreviewConfig.ts`)** — the single source of truth for preview/export
  config (DEM id, selection, model settings, display flags). One localStorage key
  (`previewConfig`), generic JSON (de)serialization, versioned with a `migrate()` hook. Adding a
  setting needs **no** persistence wiring — `config.model` serializes wholesale. Only the
  **selected area** is shareable: `src/index.ts` writes it to the URL hash in **human-readable**
  form (`&shape=…&sel=lon,lat;…` next to the readable `map`/`lat`/`lng`/`z`), kept live via
  debounced `replaceState`, and adopts it on load (winning over localStorage). DEM id + model
  settings are NOT in the URL — they live only in localStorage. (There is no opaque `#c=` blob.)
- **Height pipeline (`src/dem/`)** — split into three single-purpose, separately-testable
  stages, with `src/HeightSampler.ts` as a thin facade/orchestrator (public API:
  `sampleSelectionHeights`, `tileCoverage`, `rectExtent`, `HeightGrid`). The raw geodesy/zoom
  math (`groundResolution`, `zoomForResolution`, `haversine`, `lonLatToWorldPx`) lives in
  **`src/mathHelper.ts`** (which also defines the base `LonLat` type); import from there directly
  (no re-export shims):
  - `src/dem/TileDownloader.ts` — fetches + composites DEM tiles into a `RawRaster` (the only
    DOM/network part; `Image` + canvas).
  - `src/dem/TerrariumMapData.ts` — wraps the raw RGBA (by reference, no copy) and decodes a
    global pixel to metres (`R*256 + G + B/256 - 32768`, NaN for no-data). Pure → unit-tested.
  - `src/dem/Sampler.ts` — bilinear-samples a cols×rows `HeightGrid` over the (rotated) selection
    via `TerrariumMapData.heightAtPixel`. Pure → unit-tested directly.
  The split is byte-for-byte output-preserving (the golden STL e2e is the guard). Performance
  is unchanged: raster shared by reference, decode returns a plain number, no per-sample alloc.

## Build & verify

- **Build**: `npm run compile` (dev webpack), `npm run watch`, `npm run dev` (dev server, port
  8003), `npm run build` (release: `webpack --mode production`, minified — the dev config is
  deliberately left unchanged, they branch on `argv.mode` in `webpack.config.js`).
- **Types**: `npm run check` type-checks **both** `.ts` and `.svelte` (svelte-check — a superset
  of `tsc --noEmit`, so there's no separate tsc step). TypeScript in components works via
  `svelte-preprocess` (`svelte.config.js`, read by both the loader and the tooling).
  `verbatimModuleSyntax` is on, so **type-only imports MUST use `import type`** (svelte-preprocess
  transpiles per-file, so a type imported as a value would be emitted as a runtime import and
  crash). Components migrate to `<script lang="ts">` one at a time — JS and TS coexist.
- **Tests**: `npm run test` (vitest unit), `npm run test:e2e` (Playwright), `npm run test:all`.
  The **golden STL** (`tests/e2e/dunedin-download.spec.ts`) is the byte-for-byte guard on geometry
  output; regenerate intentionally with `UPDATE_GOLDEN=1 npm run test:e2e -- dunedin-download`.

## Gotchas / lessons (don't relearn these the slow way)

- **Selection coords are `[SW, SE, NE, NW]`** despite being labelled TL,TR,BR,BL — OL's
  projection has +Y = north, so the sampler's row 0 is the *south* edge. This drove the
  earlier mirror bug; `MapModel`'s `Z(r)`/winding account for it. Don't "fix" the labels.
- **`heightScale` runs LAST in the elevation-value chain** (`water → lowCut → heightScale`),
  so the threshold processors before it compare *un-exaggerated* metres — the water cutoff
  and the low-cut level are set in real elevation regardless of scale. The flip side: scale
  then multiplies their output too, so the **water plane IS scaled** (water at -50 with scale
  2 sits at -100), staying proportional to the exaggerated relief. **Socket thickness stays
  literal** — `SocketProcessor` is a VertexProcessor that runs after, on the already-scaled
  `minY`. The socket floor sits below the lowest *post-water* surface (`effectiveMinY`), so
  water counts toward how deep the base goes. Overlay "thickness" = top surface down to that
  flat base.
- **Oval selection = rectangle + mask, not a new geometry path for the sampler.** The
  selection tool always emits the same 4 bounding-box corners (config stays length-4) and
  the sampler always samples a rectangle. `shape: 'rectangle' | 'oval'` is a `ModelSettings`
  field; only `MapModel.buildOval` masks the grid to the inscribed ellipse. It emits a
  per-cell solid (top + base + a wall on every boundary edge). The masked builder generates
  **triangle soup** (every quad pushes its own corners), but every tile is then run through
  `weldIndexed` (`src/model/geometry.ts`) — coincident vertices are merged by quantised position
  into ONE shared-vertex indexed mesh. So the final mesh is watertight by *shared index*, not
  just by coincident position: `computeVertexNormals` smooths correctly and vertex counts are
  comparable across paths. **One representation everywhere** (rectangle, oval, holes, tiling);
  `weldIndexed` never moves a vertex, so the exported STL triangles are unchanged. Tiling is
  ignored for ovals.
- **Memory has two functions, don't mix them up (`src/memory.ts`).** `estimateMemory` is
  PREDICTIVE — from grid `cols×rows` alone, assuming the dense sheet — and gates a selection
  against the budget BEFORE anything is sampled (no mesh exists yet). `measureMemory` is the
  REALISTIC figure from the *actual* built `geo` (vertex/triangle counts post weld/holes/
  tiling/socket) + the retained grid; that's what the overlay shows. The overlay reads `geo`
  for vertices/triangles/memory; the "Detail: C×R" line is still the *sampled* grid resolution
  (pre-reshape), which is a different stat by design. `tileSize` is plumbed through both (512px
  Mapterhorn tiles are 4× the pixels of a 256px source).
- **Tile server URL** is OPTIONAL — from `.env` (`LOCAL_TILE_SERVER_URL` / `TILE_SERVER_URL`)
  baked in at build via `webpack.DefinePlugin` → `__TILE_SERVER_URL__`, defaulting to `''`
  when unset (the manifest fetch then just fails gracefully → `[]`). With no server the app
  runs entirely on the public base maps in **`src/externalMaps.ts`** (`EXTERNAL_MAPS`:
  OpenStreetMap, OpenTopoMap) + the public DEMs in `src/externalDems.ts`. Elevation DEMs are
  manifest entries with `mmapsrv.type === 'elevation'`; the preview Source toggle is built
  from those dynamically (don't hardcode DEM names).
- **External base maps + DEMs** (`src/externalMaps.ts` / `src/externalDems.ts`) are appended to
  the fetched manifest in `src/index.ts`. They're just `ManifestMap` entries pointing at public
  terrarium endpoints (Mapterhorn, AWS) — no new code path, they flow through the same source
  toggle and sampler. Requirements for any new one: terrarium encoding, `Access-Control-Allow-Origin`
  (the sampler reads tiles off a canvas → no CORS = tainted canvas = throws), and a correct
  `mmapsrv.tileSize`. **`tileSize` is load-bearing for non-256 sources**: Mapterhorn is 512px,
  and `HeightSampler` (`groundResolution`/`lonLatToWorldPx`/canvas) + `OpenLayersEngine` all
  read it. A 512px tile is twice as fine per zoom, so the pixel↔zoom math breaks silently if
  it's left at 256 (misaligned composite, half the detail). `mmapsrv.proxy`/`downloadable`
  are inert client-side (server-only flags) — don't rely on them in the app.
- **Map-menu source categories** group a source's tile layers out of the generic section into a
  named group (Mapterhorn, North Island, …). The category is carried on `src/customMaps.ts`
  entries and merged with the fetched providers by `buildSections` in `src/ui/MapPanel.svelte`,
  ordered Raw / 2D Hillshade / 3D Hillshade by name. **Two ways to get a 2D hillshade**: a server
  that already ships rendered hillshade tiles (NZ `*_hillshade_8m`) just lists that tile layer as
  the "2D Hillshade"; sources without one (Mapterhorn/AWS) compute it in-browser via
  `surface: 'hillshade-2d'` → `src/engine/hillshadeRaster.ts` (an OL `Raster` worker op) rendered
  on the OL map so the selection tool works over it. 3D hillshade = `surface: 'hillshade'`
  (MapLibre, no selection tool yet).
