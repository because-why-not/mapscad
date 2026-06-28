import type { HeightGrid } from './HeightSampler';
import {
    type ElevationProcessor, type ElevationContext, HeightScaleProcessor, WaterProcessor,
    type VertexProcessor, type VertexMesh, SocketProcessor,
} from './model/processors';
import { pushQuadOriented } from './model/geometry';

/**
 * The single canonical 3D model. Everything that isn't sampling flows through here:
 *
 *   - the 3D-view menu mutates settings via the setters / applySettings()
 *   - consumers (the preview, the STL exporter) subscribe with onChange() and read
 *     buildGeometry() — the ONE place the surface/socket/tile math lives, in real metres
 *
 * It is sync and pure: index.ts owns DEM sampling and feeds the result in via setGrid().
 * Height exaggeration (heightScale) is baked into the geometry so the preview and the
 * exported STL are always the exact same solid.
 */

export interface ModelSettings {
    heightZoom: number;      // DEM tile zoom to sample at — drives mesh detail/density
    resolutionLimit: number; // hard cap on vertices along the longest side
    heightScale: number;     // vertical exaggeration, baked into geometry
    socketEnabled: boolean;  // add a base below the terrain to make a manifold solid
    socketSize: number;      // metres of socket below the lowest point (+ a small floor)
    tilesEnabled: boolean;   // split into tilesX × tilesY separate printable solids
    tilesX: number;
    tilesY: number;
    waterEnabled: boolean;   // flatten everything below waterCutoff to a single water level
    waterCutoff: number;     // metres: terrain below this is treated as water (e.g. sea)
    waterLevel: number;      // metres: height water is rendered at (e.g. -50 for a clear step)
    shape: SelectionShape;   // footprint cut from the (still rectangular) sampled grid
}

/** The selection still samples a rectangle; Oval masks it to the inscribed ellipse.
 *  String-valued so it serializes to stable, human-readable config/share-link tokens. */
export enum SelectionShape {
    Rectangle = 'rectangle',
    Oval = 'oval',
}

/** One independent solid: a flat buffer of metre-space vertices + triangle indices. */
export interface ModelTile {
    positions: Float32Array;  // x,y,z per vertex; metres; model-centred; +Y up, +Z south
    indices: Uint32Array;     // 3 per triangle, outward-facing winding
    ix0: number;              // tile column index (for export filenames)
    iy0: number;              // tile row index
}

export interface ModelGeometry {
    tiles: ModelTile[];
    widthMeters: number;      // real-world extent, for camera framing
    heightMeters: number;
    vertexCount: number;
    triangleCount: number;
    minY: number;             // lowest / highest vertex Y (model metres, incl. socket + water)
    maxY: number;
    socketStartY: number | null; // Y where the socket begins (lowest surface), null if no socket
    minThickness: number;     // thinnest / thickest solid column, export units (0 without socket)
    maxThickness: number;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
    heightZoom: 0,
    resolutionLimit: 256,
    heightScale: 1,
    socketEnabled: false,
    socketSize: 0,
    tilesEnabled: false,
    tilesX: 1,
    tilesY: 1,
    waterEnabled: false,
    waterCutoff: 0,
    waterLevel: 0,
    shape: SelectionShape.Rectangle,
};

// Minimum socket thickness, so a "size 0" socket is still a handleable solid.
const SOCKET_FLOOR_OFFSET = 0.1;

export class MapModel {
    private grid: HeightGrid | null = null;
    private settings: ModelSettings;
    private listeners = new Set<() => void>();
    private cache: ModelGeometry | null = null;
    private dirty = true;

    constructor(initial: Partial<ModelSettings> = {}) {
        this.settings = sanitize({ ...DEFAULT_MODEL_SETTINGS, ...initial });
    }

    // --- observation ---------------------------------------------------------

    /** Subscribe to any change of grid or settings. Returns an unsubscribe fn. */
    onChange(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    private notify(): void {
        this.dirty = true;
        this.cache = null;
        for (const cb of this.listeners) cb();
    }

    // --- data in -------------------------------------------------------------

    /** Feed in freshly sampled heights (or null to clear the model). */
    setGrid(grid: HeightGrid | null): void {
        this.grid = grid;
        this.notify();
    }

    getGrid(): HeightGrid | null {
        return this.grid;
    }

    hasModel(): boolean {
        return !!this.grid;
    }

    // --- settings ------------------------------------------------------------

    getSettings(): ModelSettings {
        return { ...this.settings };
    }

    /** Merge a (partial) settings object from the UI and notify. */
    applySettings(partial: Partial<ModelSettings>): void {
        this.settings = sanitize({ ...this.settings, ...partial });
        this.notify();
    }

    // --- geometry out --------------------------------------------------------

    /** Build (and cache) the neutral geometry both the preview and StlMaker consume. */
    buildGeometry(): ModelGeometry | null {
        if (!this.dirty && this.cache) return this.cache;
        this.dirty = false;
        this.cache = this.grid ? this.build(this.grid) : null;
        return this.cache;
    }

    private build(grid: HeightGrid): ModelGeometry {
        const s = this.settings;
        // The oval footprint masks the sampled rectangle, so it gets its own builder
        // (per-cell solid with a boundary-following wall); the rectangle path is untouched.
        if (s.shape === SelectionShape.Oval) return this.buildOval(grid);

        const { cols, rows, widthMeters, heightMeters } = grid;
        const nx = s.tilesEnabled ? Math.min(s.tilesX, cols - 1) : 1;
        const ny = s.tilesEnabled ? Math.min(s.tilesY, rows - 1) : 1;

        // Elevation stage: run the per-cell processor chain (exaggeration, water, …) once,
        // up front, into a model-space height field both the surface and the socket read.
        const processed = this.applyElevation(grid);
        // Lowest model-space surface (incl. water), so the socket floor sits below the
        // water too. Shared across tiles, so a multi-tile print stays level.
        const minY = minOf(processed);

        const tiles: ModelTile[] = [];
        let vertexCount = 0, triangleCount = 0;
        let lowY = Infinity, highY = -Infinity;
        for (let ty = 0; ty < ny; ty++) {
            const r0 = Math.round(ty * (rows - 1) / ny);
            const r1 = Math.round((ty + 1) * (rows - 1) / ny);
            if (r1 <= r0) continue;
            for (let tx = 0; tx < nx; tx++) {
                const c0 = Math.round(tx * (cols - 1) / nx);
                const c1 = Math.round((tx + 1) * (cols - 1) / nx);
                if (c1 <= c0) continue;
                const tile = this.buildTile(grid, processed, c0, c1, r0, r1, tx, ty, minY);
                tiles.push(tile);
                vertexCount += tile.positions.length / 3;
                triangleCount += tile.indices.length / 3;
                for (let i = 1; i < tile.positions.length; i += 3) {
                    const y = tile.positions[i];
                    if (y < lowY) lowY = y;
                    if (y > highY) highY = y;
                }
            }
        }
        if (!Number.isFinite(lowY)) { lowY = 0; highY = 0; }

        // Solid thickness = top surface down to the flat base. Thinnest column sits at the
        // lowest surface (= the socket depth); thickest reaches the highest surface. Without
        // a socket the mesh is an open sheet, so there is no thickness.
        let minThickness = 0, maxThickness = 0;
        if (s.socketEnabled) {
            const baseY = minY - Math.max(s.socketSize, SOCKET_FLOOR_OFFSET);
            minThickness = minY - baseY;
            maxThickness = highY - baseY;
        }

        return {
            tiles, widthMeters, heightMeters, vertexCount, triangleCount,
            minY: lowY, maxY: highY,
            socketStartY: s.socketEnabled ? minY : null,
            minThickness, maxThickness,
        };
    }

    /** Build one independent solid spanning grid columns c0..c1 and rows r0..r1. */
    private buildTile(
        grid: HeightGrid, processed: Float32Array,
        c0: number, c1: number, r0: number, r1: number, ix0: number, iy0: number, minY: number,
    ): ModelTile {
        const { cols, rows, widthMeters, heightMeters } = grid;
        const tcols = c1 - c0 + 1, trows = r1 - r0 + 1;

        // Model-centred metre coordinates. The sampler walks west→east (c) and
        // south→north (r), so +X is east and the south edge (r=0) is +Z (toward the
        // default camera), north is -Z. This keeps East×North=Up (right-handed), so the
        // mesh and exported STL are not mirrored.
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

        // Vertex stage: each processor mutates this solid's mesh (e.g. the socket closes the
        // open sheet into a watertight solid). minY is the model-wide floor anchor.
        const mesh: VertexMesh = { positions, indices, tcols, trows, minY };
        for (const vp of this.vertexProcessors()) vp.process(mesh);

        return {
            positions: new Float32Array(positions),
            indices: new Uint32Array(indices),
            ix0, iy0,
        };
    }

    // --- processor chains ----------------------------------------------------

    /** Elevation-domain tools, applied per cell to the height value (order matters: water
     *  runs after exaggeration so the waterline stays at its literal metres). */
    private elevationProcessors(): ElevationProcessor[] {
        const s = this.settings;
        const list: ElevationProcessor[] = [new HeightScaleProcessor(s.heightScale)];
        if (s.waterEnabled) list.push(new WaterProcessor(s.waterCutoff, s.waterLevel));
        return list;
    }

    /** Geometry-domain tools, applied to each emitted solid's mesh. */
    private vertexProcessors(): VertexProcessor[] {
        const s = this.settings;
        return s.socketEnabled ? [new SocketProcessor(s.socketSize, SOCKET_FLOOR_OFFSET)] : [];
    }

    /** Run the elevation chain over every cell to produce model-space heights (metres). */
    private applyElevation(grid: HeightGrid): Float32Array {
        const procs = this.elevationProcessors();
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
     * Oval footprint: the inscribed ellipse of the sampled rectangle. Cells whose centre
     * falls outside the ellipse are dropped, and the kept region is emitted as one solid
     * with a wall on every boundary edge — a stair-stepped but watertight outline. Tiling
     * is ignored for ovals (a single solid). The rectangle path is left exactly as-is.
     */
    private buildOval(grid: HeightGrid): ModelGeometry {
        const { cols, rows, widthMeters, heightMeters } = grid;
        const s = this.settings;

        // A cell (cc,cr) spans grid columns cc..cc+1 and rows cr..cr+1; keep it if its
        // centre is inside the unit ellipse mapped over the whole grid.
        const inside = (cc: number, cr: number): boolean => {
            if (cc < 0 || cr < 0 || cc >= cols - 1 || cr >= rows - 1) return false;
            const du = 2 * ((cc + 0.5) / (cols - 1)) - 1;
            const dv = 2 * ((cr + 0.5) / (rows - 1)) - 1;
            return du * du + dv * dv <= 1;
        };

        const processed = this.applyElevation(grid);

        // Lowest / highest surface over the KEPT region (so the socket floor and thickness
        // reflect the oval, not the discarded corners).
        let minSurf = Infinity, highY = -Infinity;
        for (let cr = 0; cr < rows - 1; cr++) {
            for (let cc = 0; cc < cols - 1; cc++) {
                if (!inside(cc, cr)) continue;
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

        const tile = this.buildMaskedTile(grid, processed, inside, minSurf);
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
    private buildMaskedTile(
        grid: HeightGrid, processed: Float32Array, inside: (cc: number, cr: number) => boolean, minSurf: number,
    ): ModelTile {
        const { cols, rows, widthMeters, heightMeters } = grid;
        const X = (c: number) => -widthMeters / 2 + (c / (cols - 1)) * widthMeters;
        const Z = (r: number) => heightMeters / 2 - (r / (rows - 1)) * heightMeters;
        type V = [number, number, number];
        const top = (c: number, r: number): V => [X(c), processed[r * cols + c], Z(r)];

        const socket = this.settings.socketEnabled;
        const baseY = minSurf - Math.max(this.settings.socketSize, SOCKET_FLOOR_OFFSET);
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
        return { positions: new Float32Array(positions), indices: new Uint32Array(indices), ix0: 0, iy0: 0 };
    }

}

/** Smallest value in a float array (0 if empty / all non-finite). */
function minOf(a: Float32Array): number {
    let m = Infinity;
    for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i];
    return Number.isFinite(m) ? m : 0;
}

function sanitize(s: ModelSettings): ModelSettings {
    return {
        heightZoom: Math.round(num(s.heightZoom, 0)),
        resolutionLimit: Math.min(4096, Math.max(2, Math.floor(num(s.resolutionLimit, 256)))),
        heightScale: Math.max(0.01, num(s.heightScale, 1)),
        socketEnabled: !!s.socketEnabled,
        socketSize: Math.max(0, num(s.socketSize, 0)),
        tilesEnabled: !!s.tilesEnabled,
        tilesX: Math.max(1, Math.floor(num(s.tilesX, 1))),
        tilesY: Math.max(1, Math.floor(num(s.tilesY, 1))),
        waterEnabled: !!s.waterEnabled,
        waterCutoff: num(s.waterCutoff, 0),
        waterLevel: num(s.waterLevel, 0),
        shape: s.shape === SelectionShape.Oval ? SelectionShape.Oval : SelectionShape.Rectangle,
    };
}

function num(v: unknown, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
