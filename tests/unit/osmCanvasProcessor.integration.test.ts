// @vitest-environment jsdom
//
// Integration coverage for the DOM-coupled OsmCanvasProcessor: process() paints a feature's ways
// onto a real <canvas> and reads the coverage back. Opts into jsdom + node-canvas so getContext('2d')
// is real. Covers BOTH geometry kinds the registry drives: 'line' (stroke + blur + radius, e.g.
// tracks/streets) and 'area' (solid fill, e.g. buildings). The pure pixels→heights step is the
// shared, separately-tested addRasterRaise (rasterRaise.test.ts).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { OsmCanvasProcessor } from '../../src/model/OsmCanvasProcessor';
import { OsmVectorData } from '../../src/osm/OsmVectorData';
import { osmFeature } from '../../src/osm/osmFeatures';
import type { LonLat } from '../../src/SelectionArea';
import type { OsmWay } from '../../src/osm/OverpassFeature';
import type { HeightGrid } from '../../src/HeightSampler';

const LINE = osmFeature('tracks');   // geometry: 'line'
const AREA = osmFeature('buildings'); // geometry: 'area'

// Axis-aligned 1°×1° selection (TL, TR, BR, BL); 1000 m square, 10×10 cells (100 m each).
const CORNERS: LonLat[] = [[0, 1], [1, 1], [1, 0], [0, 0]];
const GRID = { corners: CORNERS, cols: 10, rows: 10 };

function flatGrid(value = 100): HeightGrid {
    return {
        heights: new Float32Array(10 * 10).fill(value),
        cols: 10, rows: 10, widthMeters: 1000, heightMeters: 1000,
        minHeight: value, maxHeight: value, zoom: 14, tilesX: 1, tilesY: 1,
    };
}

const idx = (col: number, row: number) => row * 10 + col;
// A horizontal line at lat 0.55 → v 0.45 → row 4.
const MID_ROW_LINE: OsmWay = [[0.05, 0.55], [0.95, 0.55]];
// A square ring covering grid cols/rows 2..7 (lon/lat .25→2, .75→7; v = 1−lat).
const SQUARE: OsmWay = [[0.25, 0.75], [0.75, 0.75], [0.75, 0.25], [0.25, 0.25]];

describe('OsmCanvasProcessor.process (real canvas)', () => {
    beforeAll(() => {
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) throw new Error('no real 2d canvas — is the `canvas` package installed?');
    });

    it('line: raises along the painted way, leaves far cells flat, carves on negative', () => {
        const data = new OsmVectorData([MID_ROW_LINE], GRID);
        const up = new OsmCanvasProcessor(data, LINE, 50, 100).process(flatGrid(100));
        expect(up.heights).not.toBe(flatGrid(100).heights);
        expect(up.heights[idx(5, 4)]).toBeGreaterThan(130);
        expect(up.heights[idx(0, 0)]).toBe(100);
        const down = new OsmCanvasProcessor(data, LINE, -50, 100).process(flatGrid(100));
        expect(down.heights[idx(5, 4)]).toBeLessThan(70);
    });

    it('area: raises cells inside the footprint, leaves outside cells flat (radius ignored)', () => {
        const data = new OsmVectorData([SQUARE], GRID);
        const out = new OsmCanvasProcessor(data, AREA, 20, 0).process(flatGrid(100));
        expect(out.heights[idx(5, 5)]).toBe(120); // interior → full +20
        expect(out.heights[idx(0, 0)]).toBe(100); // far corner → unchanged
    });

    it('is a no-op for raise 0, empty data, or (line) radius 0', () => {
        const grid = flatGrid(100);
        expect(new OsmCanvasProcessor(new OsmVectorData([MID_ROW_LINE], GRID), LINE, 0, 100).process(grid)).toBe(grid);
        expect(new OsmCanvasProcessor(new OsmVectorData([MID_ROW_LINE], GRID), LINE, 50, 0).process(grid)).toBe(grid);
        expect(new OsmCanvasProcessor(new OsmVectorData([], GRID), LINE, 50, 100).process(grid)).toBe(grid);
        // radius 0 is NOT a no-op for an area feature (it ignores radius):
        expect(new OsmCanvasProcessor(new OsmVectorData([SQUARE], GRID), AREA, 20, 0).process(grid)).not.toBe(grid);
    });

    it('preserves no-data (NaN) cells even when a way covers them', () => {
        const grid = flatGrid(100);
        grid.heights[idx(5, 4)] = NaN;
        const out = new OsmCanvasProcessor(new OsmVectorData([MID_ROW_LINE], GRID), LINE, 50, 100).process(grid);
        expect(Number.isNaN(out.heights[idx(5, 4)])).toBe(true);
    });

    it('paints ALL ways in a single draw call (no per-way blur layer → no OOM)', () => {
        const proto = Object.getPrototypeOf(document.createElement('canvas').getContext('2d'));
        const strokeSpy = vi.spyOn(proto, 'stroke');
        const fillSpy = vi.spyOn(proto, 'fill');
        try {
            const lines: OsmWay[] = Array.from({ length: 50 }, (_, i) => {
                const lat = 0.1 + (i / 50) * 0.8;
                return [[0.05, lat], [0.95, lat]] as OsmWay;
            });
            new OsmCanvasProcessor(new OsmVectorData(lines, GRID), LINE, 50, 100).process(flatGrid(100));
            expect(strokeSpy).toHaveBeenCalledTimes(1);
            strokeSpy.mockClear();
            fillSpy.mockClear();
            const rings: OsmWay[] = Array.from({ length: 20 }, (_, i) => {
                const lon = 0.05 + (i / 20) * 0.04;
                return [[lon, 0.6], [lon + 0.01, 0.6], [lon + 0.01, 0.5], [lon, 0.5]] as OsmWay;
            });
            new OsmCanvasProcessor(new OsmVectorData(rings, GRID), AREA, 20, 0).process(flatGrid(100));
            expect(fillSpy).toHaveBeenCalledTimes(1);
        } finally {
            strokeSpy.mockRestore();
            fillSpy.mockRestore();
        }
    });
});
