import { describe, it, expect } from 'vitest';
import {
    HeightScaleProcessor, WaterProcessor, SocketProcessor,
    type ElevationContext, type VertexMesh,
} from '../../src/model/processors';

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
