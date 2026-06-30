// @vitest-environment jsdom
//
// Integration coverage for the DOM-coupled half of StreetCanvasProcessor: process() paints the
// streets onto a real <canvas> and reads the coverage back. Mirrors the track equivalent (streets
// are stroked polylines too), opting into jsdom + node-canvas so getContext('2d') is real. The
// pure pixels→heights step is the shared, separately-tested addRasterRaise (rasterRaise.ts).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { StreetCanvasProcessor } from '../../src/model/StreetCanvasProcessor';
import { Streets } from '../../src/osm/Streets';
import type { LonLat } from '../../src/SelectionArea';
import type { Street } from '../../src/osm/OverpassStreets';
import type { HeightGrid } from '../../src/HeightSampler';

// Axis-aligned 1°×1° selection (TL, TR, BR, BL); 1000 m square, 10×10 cells (100 m each).
const CORNERS: LonLat[] = [[0, 1], [1, 1], [1, 0], [0, 0]];
const GRID = { corners: CORNERS, cols: 10, rows: 10, widthMeters: 1000, heightMeters: 1000 };

function flatGrid(value = 100): HeightGrid {
    return {
        heights: new Float32Array(10 * 10).fill(value),
        cols: 10, rows: 10, widthMeters: 1000, heightMeters: 1000,
        minHeight: value, maxHeight: value, zoom: 14, tilesX: 1, tilesY: 1,
    };
}

// A horizontal street at lat 0.55 → v 0.45 → row 4; cols 0…9.
const MID_ROW_STREET: Street = [[0.05, 0.55], [0.95, 0.55]];
const idx = (col: number, row: number) => row * 10 + col;

describe('StreetCanvasProcessor.process (real canvas)', () => {
    beforeAll(() => {
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) throw new Error('no real 2d canvas — is the `canvas` package installed?');
    });

    it('raises cells along the painted street and leaves far cells flat', () => {
        const streets = new Streets([MID_ROW_STREET], GRID);
        const out = new StreetCanvasProcessor(streets, 50, 100).process(flatGrid(100));
        expect(out.heights).not.toBe(flatGrid(100).heights);
        expect(out.heights[idx(5, 4)]).toBeGreaterThan(130);
        expect(out.heights[idx(0, 0)]).toBe(100);
        expect(out.heights[idx(9, 9)]).toBe(100);
    });

    it('carves (lowers) along the street when raise is negative', () => {
        const streets = new Streets([MID_ROW_STREET], GRID);
        const out = new StreetCanvasProcessor(streets, -50, 100).process(flatGrid(100));
        expect(out.heights[idx(5, 4)]).toBeLessThan(70);
        expect(out.heights[idx(0, 0)]).toBe(100);
    });

    it('is a no-op for raise 0, radius 0, or no streets (returns the same grid)', () => {
        const streets = new Streets([MID_ROW_STREET], GRID);
        const grid = flatGrid(100);
        expect(new StreetCanvasProcessor(streets, 0, 100).process(grid)).toBe(grid);
        expect(new StreetCanvasProcessor(streets, 50, 0).process(grid)).toBe(grid);
        expect(new StreetCanvasProcessor(new Streets([], GRID), 50, 100).process(grid)).toBe(grid);
    });

    it('preserves no-data (NaN) cells even when a street passes over them', () => {
        const grid = flatGrid(100);
        grid.heights[idx(5, 4)] = NaN;
        const out = new StreetCanvasProcessor(new Streets([MID_ROW_STREET], GRID), 50, 100).process(grid);
        expect(Number.isNaN(out.heights[idx(5, 4)])).toBe(true);
    });

    it('strokes ALL streets in a single filtered draw (no per-street blur layer → no OOM)', () => {
        const proto = Object.getPrototypeOf(document.createElement('canvas').getContext('2d'));
        const spy = vi.spyOn(proto, 'stroke');
        try {
            const many: Street[] = Array.from({ length: 50 }, (_, i) => {
                const lat = 0.1 + (i / 50) * 0.8;
                return [[0.05, lat], [0.95, lat]] as Street;
            });
            new StreetCanvasProcessor(new Streets(many, GRID), 50, 100).process(flatGrid(100));
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
    });
});
