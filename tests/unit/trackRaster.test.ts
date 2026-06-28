import { describe, it, expect } from 'vitest';
import { trackDistanceField } from '../../src/osm/trackRaster';
import type { LonLat } from '../../src/SelectionArea';
import type { Track } from '../../src/osm/OverpassTracks';

// An axis-aligned 1°×1° selection (TL, TR, BR, BL), declared as 1000m × 1000m so the metre
// math is easy: u,v in [0,1] map straight to 0..1000 m.
const CORNERS: LonLat[] = [[0, 1], [1, 1], [1, 0], [0, 0]];
const W = 1000, H = 1000;

describe('trackDistanceField', () => {
    it('is ~0 on a cell the track passes through and grows with distance', () => {
        // A vertical track down the left edge (u≈0), i.e. the west side of the grid.
        const track: Track = [[0, 0], [0, 1]];
        const field = trackDistanceField(CORNERS, [track], 4, 4, W, H);
        // Cell column 0 centre is at x=125m; column 3 centre at x=875m. Distance grows east.
        const col0 = field[0 * 4 + 0];
        const col3 = field[0 * 4 + 3];
        expect(col0).toBeCloseTo(125, 0);
        expect(col3).toBeCloseTo(875, 0);
        expect(col3).toBeGreaterThan(col0);
    });

    it('returns all-Infinity when there are no tracks', () => {
        const field = trackDistanceField(CORNERS, [], 3, 3, W, H);
        expect([...field].every(d => d === Infinity)).toBe(true);
    });

    it('measures distance to the nearest segment of a diagonal track', () => {
        // Diagonal across the square; the centre cell sits on it → ~0.
        const track: Track = [[0, 0], [1, 1]];
        const field = trackDistanceField(CORNERS, [track], 3, 3, W, H);
        expect(field[1 * 3 + 1]).toBeCloseTo(0, 0);
    });
});
