import { describe, it, expect } from 'vitest';
import { Buildings } from '../../src/osm/Buildings';
import type { LonLat } from '../../src/SelectionArea';
import type { Building } from '../../src/osm/OverpassBuildings';

// Axis-aligned 1°×1° selection (TL, TR, BR, BL) → affine maps u=lon, v=1−lat; 10×10 cells.
const CORNERS: LonLat[] = [[0, 1], [1, 1], [1, 0], [0, 0]];
const GRID = { corners: CORNERS, cols: 10, rows: 10 };

describe('Buildings', () => {
    it('exposes the raw list, count and emptiness', () => {
        const b = new Buildings([[[0, 0], [1, 0], [1, 1]]]);
        expect(b.count).toBe(1);
        expect(b.isEmpty()).toBe(false);
        expect(new Buildings().isEmpty()).toBe(true);
        expect(new Buildings().count).toBe(0);
    });

    it('projects lon/lat rings to fractional heightmap [col, row] sample indices', () => {
        // (lon .05, lat .95) → u .05, v .05 → col/row = .05·10 − .5 = 0.
        // (lon .95, lat .05) → u .95, v .95 → col/row = .95·10 − .5 = 9.
        const ring: Building = [[0.05, 0.95], [0.95, 0.95], [0.95, 0.05]];
        const [proj] = new Buildings([ring], GRID).gridBuildings;
        expect(proj[0][0]).toBeCloseTo(0);
        expect(proj[0][1]).toBeCloseTo(0);
        expect(proj[2][0]).toBeCloseTo(9);
        expect(proj[2][1]).toBeCloseTo(9);
    });

    it('buffers gridBuildings (same instance on repeat access)', () => {
        const b = new Buildings([[[0.1, 0.9], [0.9, 0.9], [0.9, 0.1]]], GRID);
        expect(b.gridBuildings).toBe(b.gridBuildings);
    });

    it('withGrid yields a grid-bound copy from a gridless instance', () => {
        const gridless = new Buildings([[[0.4, 0.6], [0.6, 0.6], [0.6, 0.4]]]);
        expect(() => gridless.gridBuildings).toThrow();
        const bound = gridless.withGrid(GRID);
        expect(bound.gridBuildings.length).toBe(1);
    });

    it('throws a clear error when gridBuildings is requested without a grid', () => {
        const b = new Buildings([[[0, 0], [1, 0], [1, 1]]]);
        expect(() => b.gridBuildings).toThrow(/grid/);
    });
});
