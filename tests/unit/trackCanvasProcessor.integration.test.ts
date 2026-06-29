// @vitest-environment jsdom
//
// Integration coverage for the DOM-coupled half of TrackCanvasProcessor: process() actually
// paints the tracks onto a real <canvas> and reads the coverage back. The node test env has no
// canvas, so this file opts into jsdom + the `canvas` (node-canvas) package, which together make
// document.createElement('canvas').getContext('2d') real. The pure pixels→heights step is covered
// separately in trackCanvasProcessor.test.ts; this verifies the geometry/coordinate path.
import { describe, it, expect, beforeAll } from 'vitest';
import { TrackCanvasProcessor } from '../../src/model/TrackCanvasProcessor';
import { Tracks } from '../../src/osm/Tracks';
import type { LonLat } from '../../src/SelectionArea';
import type { Track } from '../../src/osm/OverpassTracks';
import type { HeightGrid } from '../../src/HeightSampler';

// Axis-aligned 1°×1° selection (TL, TR, BR, BL) → affine maps u=lon, v=1−lat; 1000 m square,
// 10×10 cells, so each cell is 100 m and grid index = sample (c+0.5)/10 etc.
const CORNERS: LonLat[] = [[0, 1], [1, 1], [1, 0], [0, 0]];
const GRID = { corners: CORNERS, cols: 10, rows: 10, widthMeters: 1000, heightMeters: 1000 };

// A flat heightmap at a constant elevation so any change is purely the processor's doing.
function flatGrid(value = 100): HeightGrid {
    return {
        heights: new Float32Array(10 * 10).fill(value),
        cols: 10, rows: 10, widthMeters: 1000, heightMeters: 1000,
        minHeight: value, maxHeight: value, zoom: 14, tilesX: 1, tilesY: 1,
    };
}

// A horizontal track running across the full width at lat 0.55 → v 0.45 → row 4 (0.45·10−0.5),
// col 0…9. So it should paint along grid row 4 and leave the far rows untouched.
const MID_ROW_TRACK: Track = [[0.05, 0.55], [0.95, 0.55]];
const idx = (col: number, row: number) => row * 10 + col;

describe('TrackCanvasProcessor.process (real canvas)', () => {
    beforeAll(() => {
        // Guard: if node-canvas isn't wired up, getContext returns null and the processor
        // silently no-ops, which would make these tests pass vacuously. Fail loudly instead.
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) throw new Error('no real 2d canvas — is the `canvas` package installed?');
    });

    it('raises cells along the painted track and leaves far cells flat', () => {
        const tracks = new Tracks([MID_ROW_TRACK], GRID);
        const out = new TrackCanvasProcessor(tracks, 50, 100).process(flatGrid(100));
        expect(out.heights).not.toBe(flatGrid(100).heights); // a new buffer, original untouched
        // On the centreline (row 4, a middle column) coverage is ~full → near +50.
        expect(out.heights[idx(5, 4)]).toBeGreaterThan(130);
        // A far corner sees no track → unchanged.
        expect(out.heights[idx(0, 0)]).toBe(100);
        expect(out.heights[idx(9, 9)]).toBe(100);
    });

    it('carves (lowers) along the track when raise is negative', () => {
        const tracks = new Tracks([MID_ROW_TRACK], GRID);
        const out = new TrackCanvasProcessor(tracks, -50, 100).process(flatGrid(100));
        expect(out.heights[idx(5, 4)]).toBeLessThan(70);  // centreline carved down
        expect(out.heights[idx(0, 0)]).toBe(100);          // far cell untouched
    });

    it('is a no-op for raise 0, radius 0, or no tracks (returns the same grid)', () => {
        const tracks = new Tracks([MID_ROW_TRACK], GRID);
        const grid = flatGrid(100);
        expect(new TrackCanvasProcessor(tracks, 0, 100).process(grid)).toBe(grid);
        expect(new TrackCanvasProcessor(tracks, 50, 0).process(grid)).toBe(grid);
        const empty = new Tracks([], GRID);
        expect(new TrackCanvasProcessor(empty, 50, 100).process(grid)).toBe(grid);
    });

    it('preserves no-data (NaN) cells even when a track passes over them', () => {
        const grid = flatGrid(100);
        grid.heights[idx(5, 4)] = NaN; // a hole right on the track centreline
        const tracks = new Tracks([MID_ROW_TRACK], GRID);
        const out = new TrackCanvasProcessor(tracks, 50, 100).process(grid);
        expect(Number.isNaN(out.heights[idx(5, 4)])).toBe(true);
    });
});
