import { describe, it, expect } from 'vitest';
import { OsmVectorData } from '../../src/osm/OsmVectorData';
import type { LonLat } from '../../src/SelectionArea';
import type { OsmWay } from '../../src/osm/OverpassFeature';

// Axis-aligned 1°×1° selection (TL, TR, BR, BL) → affine maps u=lon, v=1−lat; 10×10 cells.
const CORNERS: LonLat[] = [[0, 1], [1, 1], [1, 0], [0, 0]];
const GRID = { corners: CORNERS, cols: 10, rows: 10 };

describe('OsmVectorData', () => {
    it('exposes the raw list, count and emptiness', () => {
        const d = new OsmVectorData([[[0, 0], [1, 1]]]);
        expect(d.count).toBe(1);
        expect(d.isEmpty()).toBe(false);
        expect(new OsmVectorData().isEmpty()).toBe(true);
        expect(new OsmVectorData().count).toBe(0);
    });

    it('projects lon/lat ways to fractional heightmap [col, row] sample indices', () => {
        // (lon .05, lat .95) → u .05, v .05 → col/row = .05·10 − .5 = 0.
        // (lon .95, lat .05) → u .95, v .95 → col/row = .95·10 − .5 = 9.
        const way: OsmWay = [[0.05, 0.95], [0.95, 0.05]];
        const [proj] = new OsmVectorData([way], GRID).gridWays;
        expect(proj[0][0]).toBeCloseTo(0);
        expect(proj[0][1]).toBeCloseTo(0);
        expect(proj[1][0]).toBeCloseTo(9);
        expect(proj[1][1]).toBeCloseTo(9);
    });

    it('buffers gridWays (same instance on repeat access)', () => {
        const d = new OsmVectorData([[[0.1, 0.9], [0.9, 0.1]]], GRID);
        expect(d.gridWays).toBe(d.gridWays);
    });

    it('withGrid yields a grid-bound copy from a gridless instance', () => {
        const gridless = new OsmVectorData([[[0.4, 0.6], [0.6, 0.4]]]);
        expect(() => gridless.gridWays).toThrow();
        const bound = gridless.withGrid(GRID);
        expect(bound.gridWays.length).toBe(1);
    });

    it('throws a clear error when gridWays is requested without a grid', () => {
        const d = new OsmVectorData([[[0, 0], [1, 1]]]);
        expect(() => d.gridWays).toThrow(/grid/);
    });
});
