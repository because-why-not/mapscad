import { describe, it, expect } from 'vitest';
import { Tracks } from '../../src/osm/Tracks';
import type { LonLat } from '../../src/SelectionArea';
import type { Track } from '../../src/osm/OverpassTracks';

// Axis-aligned 1°×1° selection (TL, TR, BR, BL) so the affine maps u=lon, v=1−lat; 1000 m square.
const CORNERS: LonLat[] = [[0, 1], [1, 1], [1, 0], [0, 0]];
const GRID = { corners: CORNERS, cols: 10, rows: 10, widthMeters: 1000, heightMeters: 1000 };

describe('Tracks', () => {
    it('exposes the raw list, count and emptiness', () => {
        const t = new Tracks([[[0, 0], [1, 1]]]);
        expect(t.count).toBe(1);
        expect(t.isEmpty()).toBe(false);
        expect(new Tracks().isEmpty()).toBe(true);
        expect(new Tracks().count).toBe(0);
    });

    it('projects lon/lat to fractional heightmap [col, row] sample indices', () => {
        // Point 1 (lon .05, lat .95) → u .05, v .05 → col/row = .05·10 − .5 = 0.
        // Point 2 (lon .95, lat .05) → u .95, v .95 → col/row = .95·10 − .5 = 9.
        const track: Track = [[0.05, 0.95], [0.95, 0.05]];
        const [line] = new Tracks([track], GRID).gridTracks;
        expect(line[0][0]).toBeCloseTo(0);
        expect(line[0][1]).toBeCloseTo(0);
        expect(line[1][0]).toBeCloseTo(9);
        expect(line[1][1]).toBeCloseTo(9);
    });

    it('buffers gridTracks (same instance on repeat access)', () => {
        const t = new Tracks([[[0.05, 0.95], [0.95, 0.05]]], GRID);
        expect(t.gridTracks).toBe(t.gridTracks);
    });

    it('withGrid yields a grid-bound copy from a gridless instance', () => {
        const gridless = new Tracks([[[0.5, 0.5], [0.6, 0.6]]]);
        expect(() => gridless.gridTracks).toThrow();
        const bound = gridless.withGrid(GRID);
        expect(bound.count).toBe(1);
        expect(bound.gridTracks.length).toBe(1);
    });

    it('throws a clear error when a derived form is requested without a grid', () => {
        const t = new Tracks([[[0, 0], [1, 1]]]);
        expect(() => t.gridTracks).toThrow(/grid/);
    });
});
