import type { HeightGrid } from '../HeightSampler';
import type { ModelSettings, ModelGeometry, ModelBody } from '../MapModel';
import {
    type ElevationGridProcessor, TileDividerProcessor,
    type ElevationValueProcessor, type ElevationContext, HeightScaleProcessor, WaterProcessor, LowCutProcessor,
    type VertexProcessor, type VertexMesh, SocketProcessor,
} from './processors';
import { pushQuadOriented, weldIndexed } from './geometry';

/**
 * The pure, DOM-free half of the model build: it turns an (already OSM-raised) `HeightGrid` plus
 * `ModelSettings` into neutral metre-space geometry. Extracted from MapModel so the SAME code runs
 * both synchronously (StlMaker / tests, via MapModel.buildGeometry) and off the main thread in
 * `geometry.worker.ts` — no duplication. The only stage that stays on the main thread is the
 * canvas-based OSM raise (workers have no DOM); MapModel runs it before calling in here.
 *
 * The math is byte-for-byte identical to the old MapModel methods (the golden STL e2e guards it);
 * the only addition is an optional `onProgress` hook so the worker can drive the shared progress
 * bar. Progress is coarse (phase boundaries) — the build has no sub-steps worth finer reporting.
 */

// Minimum socket thickness, so a "size 0" socket is still a handleable solid.
const SOCKET_FLOOR_OFFSET = 0.1;

// A cell joins an OSM body when any of its four corners carries at least this coverage (0..1). Just
// above zero, so the body reaches every cell the painted way touches, ramp shoulders included.
const OSM_COVERAGE_THRESHOLD = 0.02;

/** One OSM feature to emit as its OWN body draped on the terrain (roads/buildings as separate solids
 *  for multi-part / multi-colour printing). The coverage raster is painted on the main thread (needs
 *  a canvas) against the ORIGINAL sampled grid, so it's a plain, serialisable Float32Array. */
export interface OsmBody {
    id: string;
    coverage: Float32Array;  // cols×rows, 0..1, aligned with the ORIGINAL (pre-tiling) grid
    raise: number;           // metres added on top of the terrain surface at full coverage
}

export interface BuildInput {
    grid: HeightGrid;        // pure terrain heights; OSM features ride on top as separate bodies
    settings: ModelSettings;
    osmBodies?: OsmBody[];   // enabled OSM features, emitted as extra bodies after the terrain
}

export interface BuildHooks {
    /** Coarse 0..1 build progress, for the cancellable progress bar. */
    onProgress?: (fraction: number) => void;
}

/** Build the neutral geometry both the preview and StlMaker consume, from a serializable input. */
export function buildModelGeometry(input: BuildInput, hooks: BuildHooks = {}): ModelGeometry {
    const s = input.settings;
    let grid = input.grid;
    let osmBodies = input.osmBodies;
    const report = hooks.onProgress ?? (() => {});
    report(0);

    // Grid stage (pure): reshape the whole grid first (may change its dimensions). The OSM raises
    // already ran on the main thread; tiling injects no-data dividers here. A processor that changes
    // dimensions remaps the OSM coverage rasters the same way, so features stay co-registered with the
    // reshaped terrain (tiling relocates the tiles AND splits the features that ride on them).
    for (const gp of pureGridProcessors(s)) {
        const { cols, rows } = grid;
        grid = gp.process(grid);
        if (osmBodies && osmBodies.length > 0 && gp.remapRaster) {
            const remap = gp.remapRaster.bind(gp);
            osmBodies = osmBodies.map(b => {
                const coverage = remap(b.coverage, cols, rows, 0);
                return { ...b, coverage };
            });
        }
    }
    report(0.2);

    const terrain = buildTerrain(grid, s);
    for (const b of terrain.bodies) b.kind = 'terrain';
    report(0.9);

    // OSM features ride on top of the terrain as their own draped solids, appended as extra bodies.
    // They build against the reshaped grid + remapped coverage, so they line up with the tiled terrain.
    // An oval selection carves the terrain with a cell-centre mask (not NaN in the height field), so
    // pass that same mask down to clip the feature bodies to the oval too — otherwise a separate-object
    // track would run out over the cut-off corners.
    const terrainMask = s.shape === 'oval' ? ovalCellMask(grid.cols, grid.rows) : undefined;
    const geo = appendOsmBodies(terrain, grid, s, osmBodies, terrainMask);
    report(1);
    return geo;
}

/** The terrain body (surface + optional socket), one `ModelGeometry`. Splits three ways by shape /
 *  no-data, exactly as before OSM features became separate bodies. */
function buildTerrain(grid: HeightGrid, s: ModelSettings): ModelGeometry {
    // The oval footprint masks the sampled rectangle, so it gets its own builder (per-cell solid
    // with a boundary-following wall); the rectangle path is untouched. Compare the string value
    // (SelectionShape.Oval === 'oval') to avoid a runtime import cycle with MapModel.
    if (s.shape === 'oval') return buildOval(grid, s);

    const { cols, rows, widthMeters, heightMeters } = grid;

    // Elevation stage: run the per-cell processor chain (exaggeration, water, …) once, up front,
    // into a model-space height field both the surface and the socket read.
    const processed = applyElevation(grid, s);

    // No-data carves holes: real gaps OR the tile dividers injected above. Route through the masked
    // builder — one solid whose disconnected blocks ARE the tiles, each walled.
    if (hasNoData(processed)) {
        const keep = (cc: number, cr: number) => cellHasData(processed, cols, rows, cc, cr);
        return buildKept(grid, processed, keep, s);
    }

    // Lowest model-space surface (incl. water), so the socket floor sits below the water.
    const minY = minOf(processed);
    const body = buildBody(grid, processed, 0, cols - 1, 0, rows - 1, 0, 0, minY, s);

    let lowY = Infinity, highY = -Infinity;
    for (let i = 1; i < body.positions.length; i += 3) {
        const y = body.positions[i];
        if (y < lowY) lowY = y;
        if (y > highY) highY = y;
    }
    if (!Number.isFinite(lowY)) { lowY = 0; highY = 0; }

    // Solid thickness = top surface down to the flat base. Thinnest column sits at the lowest
    // surface (= the socket depth); thickest reaches the highest surface. Without a socket the mesh
    // is an open sheet, so there is no thickness.
    let minThickness = 0, maxThickness = 0;
    if (s.socketEnabled) {
        const baseY = minY - Math.max(s.socketSize, SOCKET_FLOOR_OFFSET);
        minThickness = minY - baseY;
        maxThickness = highY - baseY;
    }

    return {
        bodies: [body], widthMeters, heightMeters,
        vertexCount: body.positions.length / 3,
        triangleCount: body.indices.length / 3,
        minY: lowY, maxY: highY,
        socketStartY: s.socketEnabled ? minY : null,
        minThickness, maxThickness,
    };
}

/** Append each OSM feature as its OWN body draped on the terrain surface, so a slicer's "split to
 *  objects" separates terrain / tracks / streets / buildings for multi-part / multi-colour printing.
 *  Bodies OVERLAP the terrain (the base sinks below the surface) rather than carving it — the simplest
 *  representation; a watertight carve-and-inlay can come later. `grid` and each feature's coverage have
 *  already been through the same grid stage as the terrain (tiling remaps both), so features co-register
 *  with the reshaped terrain and split at its tile cuts. */
function appendOsmBodies(
    terrain: ModelGeometry, grid: HeightGrid, s: ModelSettings, osmBodies: OsmBody[] | undefined,
    terrainMask?: (cc: number, cr: number) => boolean,
): ModelGeometry {
    if (!osmBodies || osmBodies.length === 0) return terrain;
    // The surface features ride on: the same per-cell elevation chain the terrain used, over the same
    // (reshaped) grid so heights and the remapped coverage rasters line up cell-for-cell.
    const surface = applyElevation(grid, s);
    const bodies = terrain.bodies.slice();
    let { vertexCount, triangleCount, minY, maxY } = terrain;
    for (const feature of osmBodies) {
        const built = buildFeatureBody(grid, surface, feature, terrainMask);
        if (!built) continue;
        built.body.kind = feature.id;
        bodies.push(built.body);
        vertexCount += built.body.positions.length / 3;
        triangleCount += built.body.indices.length / 3;
        minY = Math.min(minY, built.minY);
        maxY = Math.max(maxY, built.maxY);
    }
    return { ...terrain, bodies, vertexCount, triangleCount, minY, maxY };
}

/** One OSM feature as a closed solid draped on the terrain: top = surface + coverage·raise (so
 *  shoulders ramp smoothly to ground where coverage tapers), base sunk a little below the surface so
 *  the body fuses into the terrain (overlap union). A cell is emitted when any corner passes the
 *  coverage threshold and all four corners carry terrain data; every boundary edge is walled. Returns
 *  null when nothing is covered. */
function buildFeatureBody(
    grid: HeightGrid, surface: Float32Array, feature: OsmBody,
    keep?: (cc: number, cr: number) => boolean,
): { body: ModelBody; minY: number; maxY: number } | null {
    const { cols, rows, widthMeters, heightMeters } = grid;
    const cov = feature.coverage;
    const X = (c: number) => -widthMeters / 2 + (c / (cols - 1)) * widthMeters;
    const Z = (r: number) => heightMeters / 2 - (r / (rows - 1)) * heightMeters;
    // Sink the base below the surface so the body always overlaps the terrain solid (robust union, no
    // coplanar z-fighting). Proportional to the raise so it scales with the feature's own height.
    const fuse = Math.max(SOCKET_FLOOR_OFFSET, Math.abs(feature.raise) * 0.5);
    const hasData = (c: number, r: number) => { const v = surface[r * cols + c]; return v === v; }; // !NaN
    const inside = (cc: number, cr: number): boolean => {
        if (cc < 0 || cr < 0 || cc >= cols - 1 || cr >= rows - 1) return false;
        if (keep && !keep(cc, cr)) return false; // clip to the terrain footprint (e.g. the oval mask)
        if (!(hasData(cc, cr) && hasData(cc + 1, cr) && hasData(cc, cr + 1) && hasData(cc + 1, cr + 1))) return false;
        const m = Math.max(cov[cr * cols + cc], cov[cr * cols + cc + 1], cov[(cr + 1) * cols + cc], cov[(cr + 1) * cols + cc + 1]);
        return m > OSM_COVERAGE_THRESHOLD;
    };

    type V = [number, number, number];
    const top = (c: number, r: number): V => [X(c), surface[r * cols + c] + feature.raise * cov[r * cols + c], Z(r)];
    const bot = (c: number, r: number): V => [X(c), surface[r * cols + c] - fuse, Z(r)];

    const positions: number[] = [];
    const indices: number[] = [];
    const quad = (p0: V, p1: V, p2: V, p3: V, ox: number, oy: number, oz: number) =>
        pushQuadOriented(positions, indices, p0, p1, p2, p3, ox, oy, oz);

    for (let cr = 0; cr < rows - 1; cr++) {
        for (let cc = 0; cc < cols - 1; cc++) {
            if (!inside(cc, cr)) continue;
            const A = top(cc, cr), B = top(cc + 1, cr), C = top(cc, cr + 1), D = top(cc + 1, cr + 1);
            const a = bot(cc, cr), b = bot(cc + 1, cr), c = bot(cc, cr + 1), d = bot(cc + 1, cr + 1);
            quad(A, B, D, C, 0, 1, 0);   // top faces +Y
            quad(a, b, d, c, 0, -1, 0);  // base faces -Y
            if (!inside(cc, cr - 1)) quad(A, B, b, a, 0, 0, 1);  // south edge → +Z
            if (!inside(cc, cr + 1)) quad(C, D, d, c, 0, 0, -1); // north edge → -Z
            if (!inside(cc - 1, cr)) quad(A, C, c, a, -1, 0, 0); // west edge  → -X
            if (!inside(cc + 1, cr)) quad(B, D, d, b, 1, 0, 0);  // east edge  → +X
        }
    }
    if (positions.length === 0) return null;

    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < positions.length; i += 3) {
        if (positions[i] < minY) minY = positions[i];
        if (positions[i] > maxY) maxY = positions[i];
    }
    const welded = weldIndexed(positions, indices);
    const body: ModelBody = { positions: welded.positions, indices: welded.indices, ix0: 0, iy0: 0 };
    return { body, minY, maxY };
}

/** Build one independent solid body spanning grid columns c0..c1 and rows r0..r1. */
function buildBody(
    grid: HeightGrid, processed: Float32Array,
    c0: number, c1: number, r0: number, r1: number, ix0: number, iy0: number, minY: number,
    s: ModelSettings,
): ModelBody {
    const { cols, rows, widthMeters, heightMeters } = grid;
    const tcols = c1 - c0 + 1, trows = r1 - r0 + 1;

    // Model-centred metre coordinates. The sampler walks west→east (c) and south→north (r), so
    // +X is east and the south edge (r=0) is +Z (toward the default camera), north is -Z. This
    // keeps East×North=Up (right-handed), so the mesh and exported STL are not mirrored.
    const X = (c: number) => -widthMeters / 2 + (c / (cols - 1)) * widthMeters;
    const Z = (r: number) => heightMeters / 2 - (r / (rows - 1)) * heightMeters;
    const Y = (c: number, r: number) => processed[r * cols + c];

    const positions: number[] = [];
    const indices: number[] = [];

    // Top surface.
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) positions.push(X(c), Y(c, r), Z(r));
    }
    for (let r = 0; r < trows - 1; r++) {
        for (let c = 0; c < tcols - 1; c++) {
            const a = r * tcols + c, b = a + 1, cc = a + tcols, d = cc + 1;
            indices.push(a, b, cc, b, d, cc); // winding gives +Y up (with -Z = north)
        }
    }

    // Vertex stage: each processor mutates this solid's mesh (e.g. the socket closes the open sheet
    // into a watertight solid). minY is the model-wide floor anchor.
    const mesh: VertexMesh = { positions, indices, tcols, trows, minY };
    for (const vp of vertexProcessors(s)) vp.process(mesh);

    const welded = weldIndexed(positions, indices);
    return { positions: welded.positions, indices: welded.indices, ix0, iy0 };
}

/** Grid-reshaping tools that are pure (no DOM): today just tiling, expressed as a grid reshape that
 *  injects no-data divider lines so the hole path walls each block into its own body. */
function pureGridProcessors(s: ModelSettings): ElevationGridProcessor[] {
    const list: ElevationGridProcessor[] = [];
    if (s.tilesEnabled && (s.tilesX > 1 || s.tilesY > 1)) {
        const tiler = new TileDividerProcessor(s.tilesX, s.tilesY);
        list.push(tiler);
    }
    return list;
}

/** Elevation-domain tools, applied per cell to the height value. Order matters and is the array
 *  order below: the threshold tools (water, low-cut) run FIRST so they compare un-exaggerated
 *  metres, then HeightScaleProcessor runs LAST and scales everything — including the water plane —
 *  keeping the whole model proportional. See the elevation gotcha in CLAUDE.md. */
function elevationValueProcessors(s: ModelSettings): ElevationValueProcessor[] {
    const list: ElevationValueProcessor[] = [];
    if (s.waterEnabled) list.push(new WaterProcessor(s.waterCutoff, s.waterLevel));
    if (s.lowCutEnabled) list.push(new LowCutProcessor(s.lowCutLevel));
    list.push(new HeightScaleProcessor(s.heightScale));
    return list;
}

/** Geometry-domain tools, applied to each emitted solid's mesh. */
function vertexProcessors(s: ModelSettings): VertexProcessor[] {
    return s.socketEnabled ? [new SocketProcessor(s.socketSize, SOCKET_FLOOR_OFFSET)] : [];
}

/** Run the elevation chain over every cell to produce model-space heights (metres). */
function applyElevation(grid: HeightGrid, s: ModelSettings): Float32Array {
    const procs = elevationValueProcessors(s);
    const { heights, cols, rows } = grid;
    const out = new Float32Array(heights.length);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            const raw = heights[idx];
            const ctx: ElevationContext = { raw, col: c, row: r, cols, rows, grid };
            let v = raw;
            for (const p of procs) v = p.process(v, ctx);
            out[idx] = v;
        }
    }
    return out;
}

/**
 * Oval footprint: the inscribed ellipse of the sampled rectangle. Cells whose centre falls outside
 * the ellipse are dropped, and the kept region is emitted as one solid with a wall on every boundary
 * edge — a stair-stepped but watertight outline. Tiling is ignored for ovals (a single solid). The
 * rectangle path is left exactly as-is.
 */
function buildOval(grid: HeightGrid, s: ModelSettings): ModelGeometry {
    const { cols, rows } = grid;
    const inside = ovalCellMask(cols, rows);
    const processed = applyElevation(grid, s);
    const keep = (cc: number, cr: number) => inside(cc, cr) && cellHasData(processed, cols, rows, cc, cr);
    return buildKept(grid, processed, keep, s);
}

/** Inscribed-ellipse cell mask: true where cell (cc,cr)'s CENTRE lies inside the oval that fits the
 *  sampled rectangle. The single definition of the oval footprint — used both to carve the terrain
 *  and to clip OSM feature bodies to it, so separate-object features stop at the same outline instead
 *  of running out over the cut-off corners. A cell spans grid columns cc..cc+1 and rows cr..cr+1. */
function ovalCellMask(cols: number, rows: number): (cc: number, cr: number) => boolean {
    return (cc, cr) => {
        if (cc < 0 || cr < 0 || cc >= cols - 1 || cr >= rows - 1) return false;
        const du = 2 * ((cc + 0.5) / (cols - 1)) - 1;
        const dv = 2 * ((cr + 0.5) / (rows - 1)) - 1;
        return du * du + dv * dv <= 1;
    };
}

/** Emit one masked solid over the cells kept by `keep`: top + (when socketed) base & boundary walls.
 *  Shared by the oval and the no-data (hole-carving) rectangle path. */
function buildKept(
    grid: HeightGrid, processed: Float32Array, keep: (cc: number, cr: number) => boolean, s: ModelSettings,
): ModelGeometry {
    const { cols, rows, widthMeters, heightMeters } = grid;

    // Lowest / highest surface over the KEPT region (so the socket floor and thickness reflect the
    // kept cells, not the discarded ones).
    let minSurf = Infinity, highY = -Infinity;
    for (let cr = 0; cr < rows - 1; cr++) {
        for (let cc = 0; cc < cols - 1; cc++) {
            if (!keep(cc, cr)) continue;
            for (const [c, r] of [[cc, cr], [cc + 1, cr], [cc, cr + 1], [cc + 1, cr + 1]] as const) {
                const y = processed[r * cols + c];
                if (y < minSurf) minSurf = y;
                if (y > highY) highY = y;
            }
        }
    }
    if (!Number.isFinite(minSurf)) {
        return {
            bodies: [], widthMeters, heightMeters, vertexCount: 0, triangleCount: 0,
            minY: 0, maxY: 0, socketStartY: null, minThickness: 0, maxThickness: 0,
        };
    }

    const body = buildMaskedBody(grid, processed, keep, minSurf, s);
    let minThickness = 0, maxThickness = 0, lowY = minSurf;
    if (s.socketEnabled) {
        const baseY = minSurf - Math.max(s.socketSize, SOCKET_FLOOR_OFFSET);
        lowY = baseY;
        minThickness = minSurf - baseY;
        maxThickness = highY - baseY;
    }
    return {
        bodies: [body], widthMeters, heightMeters,
        vertexCount: body.positions.length / 3,
        triangleCount: body.indices.length / 3,
        minY: lowY, maxY: highY,
        socketStartY: s.socketEnabled ? minSurf : null,
        minThickness, maxThickness,
    };
}

/** One solid body over the kept cells: top + (when socketed) base & boundary walls. */
function buildMaskedBody(
    grid: HeightGrid, processed: Float32Array, inside: (cc: number, cr: number) => boolean, minSurf: number,
    s: ModelSettings,
): ModelBody {
    const { cols, rows, widthMeters, heightMeters } = grid;
    const X = (c: number) => -widthMeters / 2 + (c / (cols - 1)) * widthMeters;
    const Z = (r: number) => heightMeters / 2 - (r / (rows - 1)) * heightMeters;
    type V = [number, number, number];
    const top = (c: number, r: number): V => [X(c), processed[r * cols + c], Z(r)];

    const socket = s.socketEnabled;
    const baseY = minSurf - Math.max(s.socketSize, SOCKET_FLOOR_OFFSET);
    const bot = (c: number, r: number): V => [X(c), baseY, Z(r)];

    const positions: number[] = [];
    const indices: number[] = [];
    const quad = (p0: V, p1: V, p2: V, p3: V, ox: number, oy: number, oz: number) =>
        pushQuadOriented(positions, indices, p0, p1, p2, p3, ox, oy, oz);

    for (let cr = 0; cr < rows - 1; cr++) {
        for (let cc = 0; cc < cols - 1; cc++) {
            if (!inside(cc, cr)) continue;
            const A = top(cc, cr), B = top(cc + 1, cr), C = top(cc, cr + 1), D = top(cc + 1, cr + 1);
            quad(A, B, D, C, 0, 1, 0); // top surface faces +Y
            if (!socket) continue;
            const a = bot(cc, cr), b = bot(cc + 1, cr), c = bot(cc, cr + 1), d = bot(cc + 1, cr + 1);
            quad(a, b, d, c, 0, -1, 0); // base faces -Y
            // A wall on each edge whose neighbouring cell is outside the oval.
            if (!inside(cc, cr - 1)) quad(A, B, b, a, 0, 0, 1);  // south edge → +Z
            if (!inside(cc, cr + 1)) quad(C, D, d, c, 0, 0, -1); // north edge → -Z
            if (!inside(cc - 1, cr)) quad(A, C, c, a, -1, 0, 0); // west edge  → -X
            if (!inside(cc + 1, cr)) quad(B, D, d, b, 1, 0, 0);  // east edge  → +X
        }
    }
    const welded = weldIndexed(positions, indices);
    return { positions: welded.positions, indices: welded.indices, ix0: 0, iy0: 0 };
}

/** Smallest value in a float array (0 if empty / all non-finite). NaN entries are skipped. */
function minOf(a: Float32Array): number {
    let m = Infinity;
    for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i];
    return Number.isFinite(m) ? m : 0;
}

/** True if any cell is no-data (NaN) — the trigger to carve holes instead of a full sheet. */
function hasNoData(a: Float32Array): boolean {
    for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) return true;
    return false;
}

/** A cell (cc,cr) spans grid corners (cc..cc+1, cr..cr+1); printable only if all four carry data.
 *  A single no-data corner drops the whole cell, so the hole follows the missing data. */
function cellHasData(processed: Float32Array, cols: number, rows: number, cc: number, cr: number): boolean {
    if (cc < 0 || cr < 0 || cc >= cols - 1 || cr >= rows - 1) return false;
    const a = processed[cr * cols + cc], b = processed[cr * cols + cc + 1];
    const c = processed[(cr + 1) * cols + cc], d = processed[(cr + 1) * cols + cc + 1];
    return a === a && b === b && c === c && d === d; // NaN !== NaN
}
