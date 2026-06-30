import type { HeightGrid } from '../HeightSampler';
import type { ModelSettings, ModelGeometry, ModelTile } from '../MapModel';
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

export interface BuildInput {
    grid: HeightGrid;        // already reshaped by the DOM-bound OSM grid processors (if any)
    settings: ModelSettings;
}

export interface BuildHooks {
    /** Coarse 0..1 build progress, for the cancellable progress bar. */
    onProgress?: (fraction: number) => void;
}

/** Build the neutral geometry both the preview and StlMaker consume, from a serializable input. */
export function buildModelGeometry(input: BuildInput, hooks: BuildHooks = {}): ModelGeometry {
    const s = input.settings;
    let grid = input.grid;
    const report = hooks.onProgress ?? (() => {});
    report(0);

    // Grid stage (pure): reshape the whole grid first (may change its dimensions). The OSM raises
    // already ran on the main thread; tiling injects no-data dividers here.
    for (const gp of pureGridProcessors(s)) grid = gp.process(grid);
    report(0.2);

    // The oval footprint masks the sampled rectangle, so it gets its own builder (per-cell solid
    // with a boundary-following wall); the rectangle path is untouched. Compare the string value
    // (SelectionShape.Oval === 'oval') to avoid a runtime import cycle with MapModel.
    if (s.shape === 'oval') {
        const geo = buildOval(grid, s);
        report(1);
        return geo;
    }

    const { cols, rows, widthMeters, heightMeters } = grid;

    // Elevation stage: run the per-cell processor chain (exaggeration, water, …) once, up front,
    // into a model-space height field both the surface and the socket read.
    const processed = applyElevation(grid, s);
    report(0.5);

    // No-data carves holes: real gaps OR the tile dividers injected above. Route through the masked
    // builder — one solid whose disconnected bodies ARE the tiles, each walled.
    if (hasNoData(processed)) {
        const keep = (cc: number, cr: number) => cellHasData(processed, cols, rows, cc, cr);
        const geo = buildKept(grid, processed, keep, s);
        report(1);
        return geo;
    }

    // Lowest model-space surface (incl. water), so the socket floor sits below the water.
    const minY = minOf(processed);
    const tile = buildTile(grid, processed, 0, cols - 1, 0, rows - 1, 0, 0, minY, s);

    let lowY = Infinity, highY = -Infinity;
    for (let i = 1; i < tile.positions.length; i += 3) {
        const y = tile.positions[i];
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

    report(1);
    return {
        tiles: [tile], widthMeters, heightMeters,
        vertexCount: tile.positions.length / 3,
        triangleCount: tile.indices.length / 3,
        minY: lowY, maxY: highY,
        socketStartY: s.socketEnabled ? minY : null,
        minThickness, maxThickness,
    };
}

/** Build one independent solid spanning grid columns c0..c1 and rows r0..r1. */
function buildTile(
    grid: HeightGrid, processed: Float32Array,
    c0: number, c1: number, r0: number, r1: number, ix0: number, iy0: number, minY: number,
    s: ModelSettings,
): ModelTile {
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

    // A cell (cc,cr) spans grid columns cc..cc+1 and rows cr..cr+1; keep it if its centre is inside
    // the unit ellipse AND all four corners carry data (no-data carves holes in the oval too).
    const inside = (cc: number, cr: number): boolean => {
        if (cc < 0 || cr < 0 || cc >= cols - 1 || cr >= rows - 1) return false;
        const du = 2 * ((cc + 0.5) / (cols - 1)) - 1;
        const dv = 2 * ((cr + 0.5) / (rows - 1)) - 1;
        return du * du + dv * dv <= 1;
    };

    const processed = applyElevation(grid, s);
    const keep = (cc: number, cr: number) => inside(cc, cr) && cellHasData(processed, cols, rows, cc, cr);
    return buildKept(grid, processed, keep, s);
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
            tiles: [], widthMeters, heightMeters, vertexCount: 0, triangleCount: 0,
            minY: 0, maxY: 0, socketStartY: null, minThickness: 0, maxThickness: 0,
        };
    }

    const tile = buildMaskedTile(grid, processed, keep, minSurf, s);
    let minThickness = 0, maxThickness = 0, lowY = minSurf;
    if (s.socketEnabled) {
        const baseY = minSurf - Math.max(s.socketSize, SOCKET_FLOOR_OFFSET);
        lowY = baseY;
        minThickness = minSurf - baseY;
        maxThickness = highY - baseY;
    }
    return {
        tiles: [tile], widthMeters, heightMeters,
        vertexCount: tile.positions.length / 3,
        triangleCount: tile.indices.length / 3,
        minY: lowY, maxY: highY,
        socketStartY: s.socketEnabled ? minSurf : null,
        minThickness, maxThickness,
    };
}

/** One solid over the kept cells: top + (when socketed) base & boundary walls. */
function buildMaskedTile(
    grid: HeightGrid, processed: Float32Array, inside: (cc: number, cr: number) => boolean, minSurf: number,
    s: ModelSettings,
): ModelTile {
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
