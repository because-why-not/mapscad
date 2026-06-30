import { describe, it, expect } from 'vitest';
import { Streets } from '../../src/osm/Streets';
import type { LonLat } from '../../src/SelectionArea';
import type { Street } from '../../src/osm/OverpassStreets';

// Axis-aligned 1°×1° selection (TL, TR, BR, BL) → affine maps u=lon, v=1−lat; 10×10 cells.
const CORNERS: LonLat[] = [[0, 1], [1, 1], [1, 0], [0, 0]];
const GRID = { corners: CORNERS, cols: 10, rows: 10 };

describe('Streets', () => {
    it('exposes the raw list, count and emptiness', () => {
        const s = new Streets([[[0, 0], [1, 1]]]);
        expect(s.count).toBe(1);
        expect(s.isEmpty()).toBe(false);
        expect(new Streets().isEmpty()).toBe(true);
        expect(new Streets().count).toBe(0);
    });

    it('projects lon/lat polylines to fractional heightmap [col, row] sample indices', () => {
        // (lon .05, lat .95) → u .05, v .05 → col/row = .05·10 − .5 = 0.
        // (lon .95, lat .05) → u .95, v .95 → col/row = .95·10 − .5 = 9.
        const line: Street = [[0.05, 0.95], [0.95, 0.05]];
        const [proj] = new Streets([line], GRID).gridStreets;
        expect(proj[0][0]).toBeCloseTo(0);
        expect(proj[0][1]).toBeCloseTo(0);
        expect(proj[1][0]).toBeCloseTo(9);
        expect(proj[1][1]).toBeCloseTo(9);
    });

    it('buffers gridStreets (same instance on repeat access)', () => {
        const s = new Streets([[[0.1, 0.9], [0.9, 0.1]]], GRID);
        expect(s.gridStreets).toBe(s.gridStreets);
    });

    it('withGrid yields a grid-bound copy from a gridless instance', () => {
        const gridless = new Streets([[[0.4, 0.6], [0.6, 0.4]]]);
        expect(() => gridless.gridStreets).toThrow();
        const bound = gridless.withGrid(GRID);
        expect(bound.gridStreets.length).toBe(1);
    });

    it('throws a clear error when gridStreets is requested without a grid', () => {
        const s = new Streets([[[0, 0], [1, 1]]]);
        expect(() => s.gridStreets).toThrow(/grid/);
    });
});
