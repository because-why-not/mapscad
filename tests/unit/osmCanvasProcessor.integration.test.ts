// @vitest-environment jsdom
//
// Integration coverage for the DOM-coupled OsmCanvasProcessor: coverage() paints a feature's ways
// onto a real <canvas> and reads the 0..1 coverage mask back. Opts into jsdom + node-canvas so
// getContext('2d') is real. Covers BOTH geometry kinds the registry drives: 'line' (stroke + blur +
// radius, e.g. tracks/streets) and 'area' (solid fill, e.g. buildings). The mask is then draped onto
// the terrain as its own body by buildFeatureBody (tested via mapModel/geometry).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { OsmCanvasProcessor } from '../../src/kit/model/OsmCanvasProcessor';
import { OsmVectorData } from '../../src/kit/mapelements/OsmVectorData';
import { osmFeature } from '../../src/kit/mapelements/osmFeatures';
import type { LonLat } from '../../src/kit/common/mathHelper';
import type { HeightGrid } from '../../src/kit/maptiles/HeightSampler';

const LINE = osmFeature('tracks');   // geometry: 'line'
const AREA = osmFeature('buildings'); // geometry: 'area'

// Axis-aligned 1°×1° selection in canonical order SW, SE, NE, NW (corner[0] = south-west, as
// SelectionArea emits; v = lat, row 0 = the south edge); 1000 m square, 10×10 cells (100 m each).
const CORNERS: LonLat[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const GRID = { corners: CORNERS, cols: 10, rows: 10 };
// Wrap bare polylines as grid-bound elements (the processor only uses their geometry).
const vd = (coords: LonLat[][]) => new OsmVectorData(coords.map((c, i) => ({ id: i + 1, coords: c })), GRID);

function flatGrid(value = 100): HeightGrid {
    return {
        heights: new Float32Array(10 * 10).fill(value),
        cols: 10, rows: 10, widthMeters: 1000, heightMeters: 1000,
        minHeight: value, maxHeight: value, zoom: 14, tilesX: 1, tilesY: 1,
    };
}

const idx = (col: number, row: number) => row * 10 + col;
// A horizontal line at lat 0.55 → v 0.55 → row 5.
const MID_ROW_LINE: LonLat[] = [[0.05, 0.55], [0.95, 0.55]];
// A square ring covering grid cols/rows 2..7 (lon/lat .25→2, .75→7; v = lat, symmetric either way).
const SQUARE: LonLat[] = [[0.25, 0.75], [0.75, 0.75], [0.75, 0.25], [0.25, 0.25]];

describe('OsmCanvasProcessor.coverage (real canvas)', () => {
    beforeAll(() => {
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) throw new Error('no real 2d canvas — is the `canvas` package installed?');
    });

    it('line: full coverage along the painted way, zero on far cells', () => {
        const data = vd([MID_ROW_LINE]);
        const cov = new OsmCanvasProcessor(data, LINE, 100).coverage(flatGrid(100));
        expect(cov).not.toBeNull();
        expect(cov![idx(5, 5)]).toBeGreaterThan(0.6); // on the line (lat .55 → row 5)
        expect(cov![idx(0, 0)]).toBe(0);              // far corner
    });

    it('area: full coverage inside the footprint, zero outside (radius ignored)', () => {
        const data = vd([SQUARE]);
        const cov = new OsmCanvasProcessor(data, AREA, 0).coverage(flatGrid(100));
        expect(cov![idx(5, 5)]).toBeGreaterThan(0.9); // interior → ~1
        expect(cov![idx(0, 0)]).toBe(0);              // far corner → 0
    });

    it('returns null for empty data or (line) radius 0, but not for an area with radius 0', () => {
        expect(new OsmCanvasProcessor(vd([MID_ROW_LINE]), LINE, 0).coverage(flatGrid(100))).toBeNull();
        expect(new OsmCanvasProcessor(vd([]), LINE, 100).coverage(flatGrid(100))).toBeNull();
        // radius 0 is NOT a no-op for an area feature (it ignores radius):
        expect(new OsmCanvasProcessor(vd([SQUARE]), AREA, 0).coverage(flatGrid(100))).not.toBeNull();
    });

    it('paints ALL ways in a single draw call (no per-way blur layer → no OOM)', () => {
        const proto = Object.getPrototypeOf(document.createElement('canvas').getContext('2d'));
        const strokeSpy = vi.spyOn(proto, 'stroke');
        const fillSpy = vi.spyOn(proto, 'fill');
        try {
            const lines: LonLat[][] = Array.from({ length: 50 }, (_, i) => {
                const lat = 0.1 + (i / 50) * 0.8;
                return [[0.05, lat], [0.95, lat]] as LonLat[];
            });
            new OsmCanvasProcessor(vd(lines), LINE, 100).coverage(flatGrid(100));
            expect(strokeSpy).toHaveBeenCalledTimes(1);
            strokeSpy.mockClear();
            fillSpy.mockClear();
            const rings: LonLat[][] = Array.from({ length: 20 }, (_, i) => {
                const lon = 0.05 + (i / 20) * 0.04;
                return [[lon, 0.6], [lon + 0.01, 0.6], [lon + 0.01, 0.5], [lon, 0.5]] as LonLat[];
            });
            new OsmCanvasProcessor(vd(rings), AREA, 0).coverage(flatGrid(100));
            expect(fillSpy).toHaveBeenCalledTimes(1);
        } finally {
            strokeSpy.mockRestore();
            fillSpy.mockRestore();
        }
    });
});
