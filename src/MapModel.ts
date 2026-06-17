import type { HeightGrid } from './HeightSampler';

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
}

const DEFAULTS: ModelSettings = {
    heightZoom: 0,
    resolutionLimit: 256,
    heightScale: 1,
    socketEnabled: false,
    socketSize: 0,
    tilesEnabled: false,
    tilesX: 1,
    tilesY: 1,
};

// Always leave a sliver of socket so a "size 0" model is still a handleable solid.
const SOCKET_FLOOR_OFFSET = 0.1;

export class MapModel {
    private grid: HeightGrid | null = null;
    private settings: ModelSettings;
    private listeners = new Set<() => void>();
    private cache: ModelGeometry | null = null;
    private dirty = true;

    constructor(initial: Partial<ModelSettings> = {}) {
        this.settings = sanitize({ ...DEFAULTS, ...initial });
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
        const { cols, rows, widthMeters, heightMeters } = grid;
        const s = this.settings;
        const nx = s.tilesEnabled ? Math.min(s.tilesX, cols - 1) : 1;
        const ny = s.tilesEnabled ? Math.min(s.tilesY, rows - 1) : 1;

        const tiles: ModelTile[] = [];
        let vertexCount = 0, triangleCount = 0;
        for (let ty = 0; ty < ny; ty++) {
            const r0 = Math.round(ty * (rows - 1) / ny);
            const r1 = Math.round((ty + 1) * (rows - 1) / ny);
            if (r1 <= r0) continue;
            for (let tx = 0; tx < nx; tx++) {
                const c0 = Math.round(tx * (cols - 1) / nx);
                const c1 = Math.round((tx + 1) * (cols - 1) / nx);
                if (c1 <= c0) continue;
                const tile = this.buildTile(grid, c0, c1, r0, r1, tx, ty);
                tiles.push(tile);
                vertexCount += tile.positions.length / 3;
                triangleCount += tile.indices.length / 3;
            }
        }
        return { tiles, widthMeters, heightMeters, vertexCount, triangleCount };
    }

    /** Build one independent solid spanning grid columns c0..c1 and rows r0..r1. */
    private buildTile(
        grid: HeightGrid, c0: number, c1: number, r0: number, r1: number, ix0: number, iy0: number,
    ): ModelTile {
        const { heights, cols, rows, widthMeters, heightMeters, minHeight } = grid;
        const scale = this.settings.heightScale;
        const tcols = c1 - c0 + 1, trows = r1 - r0 + 1;

        // Model-centred metre coordinates. The sampler walks west→east (c) and
        // south→north (r), so +X is east and the south edge (r=0) is +Z (toward the
        // default camera), north is -Z. This keeps East×North=Up (right-handed), so the
        // mesh and exported STL are not mirrored.
        const X = (c: number) => -widthMeters / 2 + (c / (cols - 1)) * widthMeters;
        const Z = (r: number) => heightMeters / 2 - (r / (rows - 1)) * heightMeters;
        const Y = (c: number, r: number) => heights[r * cols + c] * scale;

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

        if (this.settings.socketEnabled) {
            // The socket is a print/handling feature, so its thickness is literal metres
            // and is NOT affected by heightScale — only the terrain itself is exaggerated.
            const baseY = minHeight * scale - this.settings.socketSize - SOCKET_FLOOR_OFFSET;
            this.addSocket(positions, indices, tcols, trows, baseY);
        }

        return {
            positions: new Float32Array(positions),
            indices: new Uint32Array(indices),
            ix0, iy0,
        };
    }

    /** Skirt + base that closes the open top surface into a watertight solid. */
    private addSocket(positions: number[], indices: number[], tcols: number, trows: number, baseY: number): void {
        const topCount = tcols * trows;
        // Perimeter loop of top vertices, CCW-ish: north → east → south → west.
        const loop: number[] = [];
        for (let c = 0; c < tcols; c++) loop.push(c);                              // north edge
        for (let r = 1; r < trows; r++) loop.push(r * tcols + (tcols - 1));        // east edge
        for (let c = tcols - 2; c >= 0; c--) loop.push((trows - 1) * tcols + c);   // south edge
        for (let r = trows - 2; r >= 1; r--) loop.push(r * tcols);                 // west edge
        const n = loop.length;

        // A bottom vertex directly below each perimeter top vertex.
        for (let k = 0; k < n; k++) {
            const ti = loop[k];
            positions.push(positions[ti * 3], baseY, positions[ti * 3 + 2]);
        }
        const bottom = (k: number) => topCount + k;

        // Walls: one quad per perimeter segment, oriented outward (away from the axis).
        for (let k = 0; k < n; k++) {
            const k1 = (k + 1) % n;
            this.pushOriented(positions, indices, loop[k], loop[k1], bottom(k1), 'radial');
            this.pushOriented(positions, indices, loop[k], bottom(k1), bottom(k), 'radial');
        }
        // Base: fan triangulate the bottom loop, oriented downward (-Y).
        for (let k = 1; k < n - 1; k++) {
            this.pushOriented(positions, indices, bottom(0), bottom(k), bottom(k + 1), 'down');
        }
    }

    /** Push a triangle, flipping its winding so its normal faces the desired way. */
    private pushOriented(
        positions: number[], indices: number[], a: number, b: number, c: number, ref: 'radial' | 'down',
    ): void {
        const nrm = triNormal(positions, a, b, c);
        let outward: boolean;
        if (ref === 'down') {
            outward = nrm.y < 0;
        } else {
            const cx = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
            const cz = (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3;
            outward = nrm.x * cx + nrm.z * cz > 0;
        }
        if (outward) indices.push(a, b, c);
        else indices.push(a, c, b);
    }
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
    };
}

function num(v: unknown, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/** Unnormalised face normal of triangle (a,b,c) from a flat positions array. */
function triNormal(p: number[], a: number, b: number, c: number): { x: number; y: number; z: number } {
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
    const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
    return { x: uy * vz - uz * vy, y: uz * vx - ux * vz, z: ux * vy - uy * vx };
}
