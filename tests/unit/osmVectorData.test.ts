import { describe, it, expect } from 'vitest';
import { OsmVectorData } from '../../src/kit/mapelements/OsmVectorData';
import type { LonLat } from '../../src/kit/common/mathHelper';
import type { OsmElement } from '../../src/kit/mapelements/OverpassFeature';

// Axis-aligned 1°×1° selection in canonical order SW, SE, NE, NW (corner[0] = south-west, as
// SelectionArea emits) → affine maps u=lon, v=lat (row 0 = the south edge); 10×10 cells.
const CORNERS: LonLat[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const GRID = { corners: CORNERS, cols: 10, rows: 10 };
const el = (id: number, coords: LonLat[], name?: string): OsmElement => ({ id, name, coords });

describe('OsmVectorData', () => {
    it('exposes the raw element list, count and emptiness', () => {
        const d = new OsmVectorData([el(1, [[0, 0], [1, 1]], 'Main St')]);
        expect(d.count).toBe(1);
        expect(d.isEmpty()).toBe(false);
        expect(d.list[0].name).toBe('Main St');
        expect(new OsmVectorData().isEmpty()).toBe(true);
        expect(new OsmVectorData().count).toBe(0);
    });

    it('projects each element\'s geometry to fractional heightmap [col, row] sample indices', () => {
        // (lon .05, lat .95) → u .05 → col .05·10 − .5 = 0; v .95 → row .95·10 − .5 = 9 (far north).
        // (lon .95, lat .05) → col 9; row 0 (row 0 = the south edge).
        const [proj] = new OsmVectorData([el(7, [[0.05, 0.95], [0.95, 0.05]])], GRID).gridWays;
        expect(proj[0][0]).toBeCloseTo(0);
        expect(proj[0][1]).toBeCloseTo(9);
        expect(proj[1][0]).toBeCloseTo(9);
        expect(proj[1][1]).toBeCloseTo(0);
    });

    it('buffers gridWays (same instance on repeat access)', () => {
        const d = new OsmVectorData([el(1, [[0.1, 0.9], [0.9, 0.1]])], GRID);
        expect(d.gridWays).toBe(d.gridWays);
    });

    it('withGrid yields a grid-bound copy from a gridless instance', () => {
        const gridless = new OsmVectorData([el(1, [[0.4, 0.6], [0.6, 0.4]])]);
        expect(() => gridless.gridWays).toThrow();
        const bound = gridless.withGrid(GRID);
        expect(bound.gridWays.length).toBe(1);
    });

    it('throws a clear error when gridWays is requested without a grid', () => {
        const d = new OsmVectorData([el(1, [[0, 0], [1, 1]])]);
        expect(() => d.gridWays).toThrow(/grid/);
    });
});
