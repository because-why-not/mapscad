import { describe, it, expect } from 'vitest';
import { MapModel, ModelSettings, ModelBody, SelectionShape } from '../../src/MapModel';
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

// Y of vertex i within a body's flat positions buffer.
function ys(body: ModelBody): number[] {
    const out: number[] = [];
    for (let i = 1; i < body.positions.length; i += 3) out.push(body.positions[i]);
    return out;
}

const flat = makeGrid([[0, 10], [0, 10]]); // SW/NW = 0, SE/NE = 10

describe('buildGeometry — no socket', () => {
    it('emits an open sheet: one body, no thickness, no socket marker', () => {
        const geo = build(flat, { socketEnabled: false });
        expect(geo.bodies).toHaveLength(1);
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

describe('buildGeometry — water cutoff is tested on the raw height, then scaled with the rest', () => {
    it('flattens sub-cutoff cells to waterLevel and leaves land exaggerated', () => {
        const geo = build(flat, {
            waterEnabled: true, waterCutoff: 5, waterLevel: -50, heightScale: 2,
        });
        // heightScale runs LAST, so it multiplies the water plane too: the cutoff still
        // tests the raw height (0 < 5 → water), but the -50 level is then scaled to -100;
        // land at 10 ≥ cutoff → 10*2 = 20.
        expect(geo.minY).toBeCloseTo(-100);
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
        const p = geo.bodies[0].positions;
        // First emitted vertex is (r0,c0) = SW: -width/2 east, +height/2 south.
        expect(p[0]).toBeCloseTo(-50); // X = -w/2 (west)
        expect(p[1]).toBeCloseTo(42);  // Y = the SW height
        expect(p[2]).toBeCloseTo(30);  // Z = +h/2 (south)
    });
});

// Count disconnected blocks within a body by welding vertices on rounded position (the mesh is
// triangle soup, so index-keyed unioning would over-count).
function connectedComponents(body: ModelBody): number {
    const p = body.positions, idx = body.indices;
    const key = (i: number) => `${p[i * 3].toFixed(3)},${p[i * 3 + 1].toFixed(3)},${p[i * 3 + 2].toFixed(3)}`;
    const id = new Map<string, number>();
    const parent: number[] = [];
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const node = (i: number): number => {
        const k = key(i);
        let n = id.get(k);
        if (n === undefined) { n = parent.length; parent.push(n); id.set(k, n); }
        return n;
    };
    for (let i = 0; i < idx.length; i += 3) {
        const a = node(idx[i]), b = node(idx[i + 1]), c = node(idx[i + 2]);
        parent[find(a)] = find(b);
        parent[find(b)] = find(c);
    }
    const roots = new Set<number>();
    for (let i = 0; i < parent.length; i++) roots.add(find(i));
    return roots.size;
}

describe('buildGeometry — tiling (no-data dividers → separate blocks in one solid)', () => {
    // A 5×5 grid splits cleanly into 2×2 blocks (the divider falls at the midpoints).
    const grid5 = makeGrid(Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => r + c)));

    it('emits ONE body holding tilesX×tilesY disconnected blocks', () => {
        const geo = build(grid5, { tilesEnabled: true, tilesX: 2, tilesY: 2, socketEnabled: true, socketSize: 3 });
        expect(geo.bodies).toHaveLength(1);
        expect(connectedComponents(geo.bodies[0])).toBe(4);
    });

    it('all bodies share one socket base level — a multi-tile print stays level', () => {
        const geo = build(grid5, { tilesEnabled: true, tilesX: 2, tilesY: 1, socketEnabled: true, socketSize: 3 });
        expect(connectedComponents(geo.bodies[0])).toBe(2);
        expect(Math.min(...ys(geo.bodies[0]))).toBeCloseTo(geo.minY); // shared floor
    });

    it('a single block is the fast un-divided path (one body)', () => {
        const geo = build(grid5, { tilesEnabled: true, tilesX: 1, tilesY: 1 });
        expect(geo.bodies).toHaveLength(1);
        expect(connectedComponents(geo.bodies[0])).toBe(1);
    });

    it('changes the vertex count when toggled on a no-data grid WITHOUT a socket', () => {
        // Regression: with soup, tiling an open sheet left vertexCount identical (the seam was
        // lost in the duplicated-vertex inflation). Welded, the separated seam shows up.
        const N = NaN;
        const coast = makeGrid(Array.from({ length: 6 }, (_, r) =>
            Array.from({ length: 6 }, (_, c) => (r === 0 && c === 0 ? N : r + c))));
        const off = build(coast, { socketEnabled: false });
        const on = build(coast, { socketEnabled: false, tilesEnabled: true, tilesX: 2, tilesY: 2 });
        expect(on.vertexCount).not.toBe(off.vertexCount);
    });

    it('emits a welded mesh: no two vertices share a position', () => {
        const N = NaN;
        const coast = makeGrid([[N, 0, 0], [0, 0, 0], [0, 0, 0]]);
        const geo = build(coast, { socketEnabled: true, socketSize: 2 });
        const body = geo.bodies[0];
        const seen = new Set<string>();
        for (let i = 0; i < body.positions.length; i += 3) {
            seen.add(`${body.positions[i].toFixed(3)},${body.positions[i + 1].toFixed(3)},${body.positions[i + 2].toFixed(3)}`);
        }
        expect(seen.size).toBe(body.positions.length / 3); // every vertex position is unique
    });
});

describe('buildGeometry — a socketed solid is a closed manifold', () => {
    it('every edge is shared by exactly two triangles', () => {
        const geo = build(makeGrid([[0, 1, 2], [1, 5, 1], [2, 1, 0]]), { socketEnabled: true, socketSize: 2 });
        const body = geo.bodies[0];
        const counts = new Map<string, number>();
        const idx = body.indices;
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

// Manifold check keyed by vertex POSITION (the oval mesh is triangle soup with per-cell
// duplicated vertices, so an index-keyed check would see shared edges as separate).
function maxEdgeSharingByPosition(body: ModelBody): { counts: Map<string, number>; positions: Float32Array } {
    const p = body.positions, idx = body.indices;
    const key = (i: number) => `${p[i * 3].toFixed(4)},${p[i * 3 + 1].toFixed(4)},${p[i * 3 + 2].toFixed(4)}`;
    const counts = new Map<string, number>();
    for (let i = 0; i < idx.length; i += 3) {
        const tri = [idx[i], idx[i + 1], idx[i + 2]];
        for (let e = 0; e < 3; e++) {
            const ka = key(tri[e]), kb = key(tri[(e + 1) % 3]);
            const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            counts.set(ek, (counts.get(ek) ?? 0) + 1);
        }
    }
    return { counts, positions: p };
}

describe('buildGeometry — oval footprint', () => {
    const bumpy = makeGrid([
        [0, 1, 2, 1, 0], [1, 3, 5, 3, 1], [2, 5, 9, 5, 2], [1, 3, 5, 3, 1], [0, 1, 2, 1, 0],
    ]);

    it('defaults to rectangle; oval is opt-in', () => {
        expect(new MapModel().getSettings().shape).toBe(SelectionShape.Rectangle);
        // Raw string from JSON config/share links coerces to the enum member.
        expect(new MapModel({ shape: 'oval' as any }).getSettings().shape).toBe(SelectionShape.Oval);
    });

    it('drops the corner cells but keeps the edge midpoints (inscribed ellipse)', () => {
        const grid = makeGrid(Array.from({ length: 11 }, (_, r) => Array.from({ length: 11 }, (_, c) => r + c)));
        const oval = build(grid, { shape: SelectionShape.Oval, socketEnabled: true, socketSize: 2 });
        expect(oval.triangleCount).toBeGreaterThan(0);

        const p = oval.bodies[0].positions;
        const has = (x: number, z: number) => {
            for (let i = 0; i < p.length; i += 3) {
                if (Math.abs(p[i] - x) < 1e-6 && Math.abs(p[i + 2] - z) < 1e-6) return true;
            }
            return false;
        };
        // Extreme corner (-w/2, +h/2) is outside the ellipse → absent.
        expect(has(-50, 50)).toBe(false);
        // The west and south edge midpoints (where the ellipse touches the box) are present.
        expect(has(-50, 0)).toBe(true);
        expect(has(0, 50)).toBe(true);
    });

    it('a socketed oval is a closed manifold (every edge shared by exactly two faces)', () => {
        const geo = build(bumpy, { shape: SelectionShape.Oval, socketEnabled: true, socketSize: 3 });
        expect(geo.bodies).toHaveLength(1);
        const { counts } = maxEdgeSharingByPosition(geo.bodies[0]);
        const bad = [...counts.entries()].filter(([, n]) => n !== 2);
        expect(bad).toEqual([]);
    });

    it('keeps water/socket semantics (literal-metre socket below the kept region)', () => {
        const geo = build(bumpy, { shape: SelectionShape.Oval, socketEnabled: true, socketSize: 4, heightScale: 2 });
        // Lowest kept surface is 1 (the corners at 0 are masked out) → ×2 = 2; base = 2 - 4.
        expect(geo.socketStartY).toBeCloseTo(2);
        expect(geo.minThickness).toBeCloseTo(4);
        expect(geo.minY).toBeCloseTo(-2);
    });
});

describe('buildGeometry — no-data carves holes', () => {
    const N = NaN;

    it('drops every cell touching a no-data corner and emits no NaN vertices', () => {
        // 3×3 grid (2×2 = 4 cells); the SW corner is no-data → only the cell that uses it
        // is dropped, leaving 3 kept cells (2 triangles each).
        const grid = makeGrid([[N, 0, 0], [0, 0, 0], [0, 0, 0]]);
        const geo = build(grid, { socketEnabled: false });
        expect(geo.triangleCount).toBe(6);
        expect([...geo.bodies[0].positions].some(v => Number.isNaN(v))).toBe(false);
    });

    it('emits nothing when the whole selection is no-data', () => {
        const geo = build(makeGrid([[N, N], [N, N]]), { socketEnabled: true, socketSize: 5 });
        expect(geo.bodies).toHaveLength(0);
        expect(geo.vertexCount).toBe(0);
    });
});

describe('MapModel.sanitize (via applySettings/getSettings)', () => {
    it('clamps out-of-range and non-finite settings', () => {
        const m = new MapModel({
            socketSize: -5,
            heightScale: NaN,
            rasterResolution: 1,     // below the floor of 2
            tilesX: 0,
            tilesY: 2.9,
        });
        const s = m.getSettings();
        expect(s.socketSize).toBe(0);
        expect(s.heightScale).toBe(1);
        expect(s.rasterResolution).toBe(2);
        expect(s.tilesX).toBe(1);
        expect(s.tilesY).toBe(2);
    });
});
