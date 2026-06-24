import { describe, it, expect } from 'vitest';
import { MapModel, ModelSettings, ModelTile } from '../../src/MapModel';
import type { HeightGrid } from '../../src/HeightSampler';

// Build a HeightGrid from a 2D array. Row 0 is the SOUTH edge and column 0 the WEST edge,
// matching the sampler (see CLAUDE.md: selection corners are [SW,SE,NE,NW]).
function makeGrid(rowsSN: number[][], w = 100, h = 100): HeightGrid {
    const rows = rowsSN.length, cols = rowsSN[0].length;
    const heights = new Float32Array(cols * rows);
    let minHeight = Infinity, maxHeight = -Infinity;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const v = rowsSN[r][c];
            heights[r * cols + c] = v;
            if (v < minHeight) minHeight = v;
            if (v > maxHeight) maxHeight = v;
        }
    }
    return { heights, cols, rows, widthMeters: w, heightMeters: h, minHeight, maxHeight, zoom: 14, tilesX: 1, tilesY: 1 };
}

function build(grid: HeightGrid, settings: Partial<ModelSettings>) {
    const model = new MapModel(settings);
    model.setGrid(grid);
    return model.buildGeometry()!;
}

// Y of vertex i within a tile's flat positions buffer.
function ys(tile: ModelTile): number[] {
    const out: number[] = [];
    for (let i = 1; i < tile.positions.length; i += 3) out.push(tile.positions[i]);
    return out;
}

const flat = makeGrid([[0, 10], [0, 10]]); // SW/NW = 0, SE/NE = 10

describe('buildGeometry — no socket', () => {
    it('emits an open sheet: one tile, no thickness, no socket marker', () => {
        const geo = build(flat, { socketEnabled: false });
        expect(geo.tiles).toHaveLength(1);
        expect(geo.socketStartY).toBeNull();
        expect(geo.minThickness).toBe(0);
        expect(geo.maxThickness).toBe(0);
        // 2×2 grid → 4 vertices, 2 triangles.
        expect(geo.vertexCount).toBe(4);
        expect(geo.triangleCount).toBe(2);
    });
});

describe('buildGeometry — heightScale exaggerates terrain only', () => {
    it('socket thickness is literal metres, identical across height scales', () => {
        const a = build(flat, { socketEnabled: true, socketSize: 5, heightScale: 1 });
        const b = build(flat, { socketEnabled: true, socketSize: 5, heightScale: 2 });

        // Socket depth (lowest surface down to the base) is the same regardless of scale…
        expect(a.minThickness).toBeCloseTo(5);
        expect(b.minThickness).toBeCloseTo(5);
        // …while the terrain above it doubles with the scale.
        expect(a.maxThickness).toBeCloseTo(15); // 10*1 above a 5 socket
        expect(b.maxThickness).toBeCloseTo(25); // 10*2 above a 5 socket
    });
});

describe('buildGeometry — water is a literal plane, not scaled', () => {
    it('flattens sub-cutoff cells to waterLevel and leaves land exaggerated', () => {
        const geo = build(flat, {
            waterEnabled: true, waterCutoff: 5, waterLevel: -50, heightScale: 2,
        });
        // height 0 < cutoff → exactly -50 (NOT -100); height 10 ≥ cutoff → 10*2 = 20.
        expect(geo.minY).toBeCloseTo(-50);
        expect(geo.maxY).toBeCloseTo(20);
    });

    it('water counts toward socket depth — base sits below the waterLevel', () => {
        // Harbour scenario: one land cell at 10, the rest water at 0, water rendered at -5.
        const grid = makeGrid([[0, 0], [0, 10]]);
        const geo = build(grid, {
            socketEnabled: true, socketSize: 10,
            waterEnabled: true, waterCutoff: 5, waterLevel: -5,
        });
        expect(geo.socketStartY).toBeCloseTo(-5);          // lowest surface is the water plane
        expect(geo.minY).toBeCloseTo(-15);                 // base = -5 - 10
        expect(geo.maxThickness).toBeCloseTo(25);          // 10 land - (-15) base
    });
});

describe('buildGeometry — socket floor is a minimum, not an addend', () => {
    it.each([
        [0, 0.1],     // size 0 → still a 0.1 sliver
        [0.05, 0.1],  // below the floor → clamped up to 0.1
        [2, 2],       // above the floor → used as-is
    ])('socketSize %d → thickness %d', (size, expected) => {
        const geo = build(makeGrid([[0, 0], [0, 0]]), { socketEnabled: true, socketSize: size });
        expect(geo.minThickness).toBeCloseTo(expected);
    });
});

describe('buildGeometry — orientation is not mirrored', () => {
    it('places the SW grid sample at (-w/2, +h/2)', () => {
        // Unique height at SW (row 0, col 0) so we can find that exact vertex.
        const grid = makeGrid([[42, 1], [2, 3]], 100, 60);
        const geo = build(grid, { socketEnabled: false });
        const p = geo.tiles[0].positions;
        // First emitted vertex is (r0,c0) = SW: -width/2 east, +height/2 south.
        expect(p[0]).toBeCloseTo(-50); // X = -w/2 (west)
        expect(p[1]).toBeCloseTo(42);  // Y = the SW height
        expect(p[2]).toBeCloseTo(30);  // Z = +h/2 (south)
    });
});

describe('buildGeometry — tiling', () => {
    it('splits into tilesX×tilesY independent solids sharing one base level', () => {
        const grid = makeGrid([[0, 5, 0], [5, 9, 5], [0, 5, 0]]); // 3×3
        const geo = build(grid, { tilesEnabled: true, tilesX: 2, tilesY: 2, socketEnabled: true, socketSize: 3 });
        expect(geo.tiles).toHaveLength(4);
        // Every tile's lowest vertex is the shared socket base — a multi-tile print stays level.
        const bases = geo.tiles.map(t => Math.min(...ys(t)));
        for (const b of bases) expect(b).toBeCloseTo(bases[0]);
    });

    it('clamps tile counts to the grid (cols-1 / rows-1)', () => {
        const grid = makeGrid([[0, 1, 2], [3, 4, 5], [6, 7, 8]]); // 3×3 → max 2×2 tiles
        const geo = build(grid, { tilesEnabled: true, tilesX: 10, tilesY: 10, socketEnabled: false });
        expect(geo.tiles).toHaveLength(4);
    });
});

describe('buildGeometry — a socketed solid is a closed manifold', () => {
    it('every edge is shared by exactly two triangles', () => {
        const geo = build(makeGrid([[0, 1, 2], [1, 5, 1], [2, 1, 0]]), { socketEnabled: true, socketSize: 2 });
        const tile = geo.tiles[0];
        const counts = new Map<string, number>();
        const idx = tile.indices;
        for (let i = 0; i < idx.length; i += 3) {
            const tri = [idx[i], idx[i + 1], idx[i + 2]];
            for (let e = 0; e < 3; e++) {
                const a = tri[e], b = tri[(e + 1) % 3];
                const key = a < b ? `${a}_${b}` : `${b}_${a}`;
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
        }
        const bad = [...counts.entries()].filter(([, n]) => n !== 2);
        expect(bad).toEqual([]); // watertight ⇒ printable STL
    });
});

describe('MapModel.sanitize (via applySettings/getSettings)', () => {
    it('clamps out-of-range and non-finite settings', () => {
        const m = new MapModel({
            socketSize: -5,
            heightScale: NaN,
            resolutionLimit: 1,     // below the floor of 2
            tilesX: 0,
            tilesY: 2.9,
        });
        const s = m.getSettings();
        expect(s.socketSize).toBe(0);
        expect(s.heightScale).toBe(1);
        expect(s.resolutionLimit).toBe(2);
        expect(s.tilesX).toBe(1);
        expect(s.tilesY).toBe(2);
    });
});
