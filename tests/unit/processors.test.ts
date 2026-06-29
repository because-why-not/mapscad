import { describe, it, expect } from 'vitest';
import {
    HeightScaleProcessor, WaterProcessor, LowCutProcessor, SocketProcessor, TileDividerProcessor,
    type ElevationContext, type VertexMesh,
} from '../../src/model/processors';
import type { HeightGrid } from '../../src/HeightSampler';

// A grid whose cell (r,c) encodes its coordinate as r*10+c, for easy identity checks.
function coordGrid(cols: number, rows: number, w = 30, h = 30): HeightGrid {
    const heights = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = r * 10 + c;
    return { heights, cols, rows, widthMeters: w, heightMeters: h, minHeight: 0, maxHeight: 0, zoom: 14, tilesX: 1, tilesY: 1 };
}

// A throwaway elevation context; only `raw` matters to the built-in processors.
const ctx = (raw: number): ElevationContext =>
    ({ raw, col: 0, row: 0, cols: 1, rows: 1, grid: {} as any });

describe('HeightScaleProcessor', () => {
    it('scales the running value', () => {
        const p = new HeightScaleProcessor(2.5);
        expect(p.process(10, ctx(10))).toBe(25);
        expect(p.process(-4, ctx(-4))).toBe(-10);
    });
});

describe('WaterProcessor', () => {
    it('flattens below the cutoff to the literal level, tested on the RAW height', () => {
        const p = new WaterProcessor(0, -50);
        // Above/at cutoff: pass the (possibly exaggerated) running value through unchanged.
        expect(p.process(123, ctx(5))).toBe(123);
        // Below cutoff (by raw): force the literal water level, ignoring the running value.
        expect(p.process(123, ctx(-2))).toBe(-50);
    });
});

describe('LowCutProcessor', () => {
    it('cuts by the RUNNING value (post-water), not raw, so it composes with water', () => {
        const p = new LowCutProcessor(0);
        // raw 30 is above 0, but water already lowered the running value to -100 -> hole.
        expect(Number.isNaN(p.process(-100, ctx(30)))).toBe(true);
        expect(p.process(40, ctx(-5))).toBe(40); // running value 40 kept, regardless of raw
        expect(p.process(0, ctx(0))).toBe(0);    // boundary is NOT below
    });
});

describe('elevation chain reproduces surfaceY semantics', () => {
    // Default order: heightScale THEN water, so exaggeration never moves the waterline.
    const scale = new HeightScaleProcessor(2);
    const water = new WaterProcessor(0, -50);
    const run = (raw: number) => water.process(scale.process(raw, ctx(raw)), ctx(raw));

    it('exaggerates terrain above the cutoff', () => {
        expect(run(10)).toBe(20); // 10*2, water passes through
    });
    it('clamps below-cutoff to the literal water level (not scaled)', () => {
        expect(run(-5)).toBe(-50); // raw < 0 -> level, NOT -5*2
    });
});

describe('TileDividerProcessor', () => {
    it('injects a no-data divider with a duplicated seam and no lost values', () => {
        // 4×4 grid, split into 2 column-blocks (1 row-block) → one vertical divider at col 2.
        const out = new TileDividerProcessor(2, 1).process(coordGrid(4, 4));
        // axisPlan(4,2) = [0,1,2,-1,2,3] → 6 cols; rows untouched → 4.
        expect(out.cols).toBe(6);
        expect(out.rows).toBe(4);
        // The divider column (index 3) is all no-data…
        for (let r = 0; r < out.rows; r++) expect(Number.isNaN(out.heights[r * out.cols + 3])).toBe(true);
        // …and the seam (source col 2) survives on BOTH sides of it (cols 2 and 4), so no
        // surface strip is lost at the cut.
        for (let r = 0; r < out.rows; r++) {
            expect(out.heights[r * out.cols + 2]).toBe(r * 10 + 2);
            expect(out.heights[r * out.cols + 4]).toBe(r * 10 + 2);
        }
    });

    it('grows the metre extents so per-cell spacing (terrain scale) is preserved', () => {
        const out = new TileDividerProcessor(2, 1).process(coordGrid(4, 4, 30, 30));
        expect(out.widthMeters).toBeCloseTo(30 * 5 / 3); // (6-1)/(4-1) more columns
        expect(out.heightMeters).toBe(30);               // rows unchanged
    });

    it('is a no-op for a single block', () => {
        const grid = coordGrid(4, 4);
        const out = new TileDividerProcessor(1, 1).process(grid);
        expect(out.cols).toBe(4);
        expect(out.rows).toBe(4);
        expect([...out.heights].some(Number.isNaN)).toBe(false);
    });
});

describe('SocketProcessor', () => {
    it('closes an open 2×2 surface into a solid with a base at minY - size', () => {
        // A flat 2×2 top surface (4 verts) at y=0.
        const positions = [
            -1, 0, 1, 1, 0, 1,   // row 0
            -1, 0, -1, 1, 0, -1, // row 1
        ];
        const indices = [0, 1, 2, 1, 3, 2];
        const mesh: VertexMesh = { positions, indices, tcols: 2, trows: 2, minY: 0 };

        new SocketProcessor(5, 0.1).process(mesh);

        // 4 top + 4 perimeter-bottom verts.
        expect(positions.length / 3).toBe(8);
        // Base floor at minY - max(size, floor) = 0 - 5 = -5.
        const ys = [];
        for (let i = 1; i < positions.length; i += 3) ys.push(positions[i]);
        expect(Math.min(...ys)).toBe(-5);
        expect(ys.filter(y => y === -5)).toHaveLength(4); // the 4 base verts
        // Walls + base triangles were added beyond the original 2.
        expect(indices.length / 3).toBeGreaterThan(2);
    });

    it('honours the floor offset for a size-0 socket', () => {
        const positions = [-1, 0, 1, 1, 0, 1, -1, 0, -1, 1, 0, -1];
        const mesh: VertexMesh = { positions, indices: [0, 1, 2, 1, 3, 2], tcols: 2, trows: 2, minY: 0 };
        new SocketProcessor(0, 0.1).process(mesh);
        const ys: number[] = [];
        for (let i = 1; i < positions.length; i += 3) ys.push(positions[i]);
        expect(Math.min(...ys)).toBeCloseTo(-0.1, 6); // sliver, not flush
    });
});
