// @vitest-environment jsdom
//
// Integration coverage for the DOM-coupled half of BuildingCanvasProcessor: process() fills the
// footprints onto a real <canvas> and reads the coverage back. Like the track equivalent, this
// opts into jsdom + node-canvas so getContext('2d') is real. The pure pixels→heights step lives in
// rasterRaise.ts and is unit-tested via trackCanvasProcessor.test.ts.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { BuildingCanvasProcessor } from '../../src/model/BuildingCanvasProcessor';
import { Buildings } from '../../src/osm/Buildings';
import type { LonLat } from '../../src/SelectionArea';
import type { Building } from '../../src/osm/OverpassBuildings';
import type { HeightGrid } from '../../src/HeightSampler';

// Axis-aligned 1°×1° selection, 10×10 cells (100 m each). grid index = sample (c+0.5)/10 etc.
const CORNERS: LonLat[] = [[0, 1], [1, 1], [1, 0], [0, 0]];
const GRID = { corners: CORNERS, cols: 10, rows: 10 };

function flatGrid(value = 100): HeightGrid {
    return {
        heights: new Float32Array(10 * 10).fill(value),
        cols: 10, rows: 10, widthMeters: 1000, heightMeters: 1000,
        minHeight: value, maxHeight: value, zoom: 14, tilesX: 1, tilesY: 1,
    };
}

// A square footprint covering grid cols 2..7, rows 2..7: lon .25→col 2, lon .75→col 7,
// lat .75→row 2, lat .25→row 7 (v = 1−lat). So cell (5,5) is interior, (0,0) is well outside.
const SQUARE: Building = [[0.25, 0.75], [0.75, 0.75], [0.75, 0.25], [0.25, 0.25]];
const idx = (col: number, row: number) => row * 10 + col;

describe('BuildingCanvasProcessor.process (real canvas)', () => {
    beforeAll(() => {
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) throw new Error('no real 2d canvas — is the `canvas` package installed?');
    });

    it('raises cells inside the footprint and leaves outside cells flat', () => {
        const buildings = new Buildings([SQUARE], GRID);
        const out = new BuildingCanvasProcessor(buildings, 20).process(flatGrid(100));
        expect(out.heights).not.toBe(flatGrid(100).heights); // a new buffer, original untouched
        expect(out.heights[idx(5, 5)]).toBe(120); // interior → full +20
        expect(out.heights[idx(0, 0)]).toBe(100); // far corner → unchanged
    });

    it('carves (lowers) the footprint when raise is negative', () => {
        const buildings = new Buildings([SQUARE], GRID);
        const out = new BuildingCanvasProcessor(buildings, -20).process(flatGrid(100));
        expect(out.heights[idx(5, 5)]).toBe(80);
        expect(out.heights[idx(0, 0)]).toBe(100);
    });

    it('is a no-op for raise 0 or no buildings (returns the same grid)', () => {
        const grid = flatGrid(100);
        expect(new BuildingCanvasProcessor(new Buildings([SQUARE], GRID), 0).process(grid)).toBe(grid);
        expect(new BuildingCanvasProcessor(new Buildings([], GRID), 20).process(grid)).toBe(grid);
    });

    it('preserves no-data (NaN) cells even when a footprint covers them', () => {
        const grid = flatGrid(100);
        grid.heights[idx(5, 5)] = NaN; // a hole inside the footprint
        const out = new BuildingCanvasProcessor(new Buildings([SQUARE], GRID), 20).process(grid);
        expect(Number.isNaN(out.heights[idx(5, 5)])).toBe(true);
    });

    it('fills ALL footprints in a single fill draw regardless of count', () => {
        const proto = Object.getPrototypeOf(document.createElement('canvas').getContext('2d'));
        const spy = vi.spyOn(proto, 'fill');
        try {
            const many: Building[] = Array.from({ length: 20 }, (_, i) => {
                const lon = 0.05 + (i / 20) * 0.04;
                return [[lon, 0.6], [lon + 0.01, 0.6], [lon + 0.01, 0.5], [lon, 0.5]] as Building;
            });
            new BuildingCanvasProcessor(new Buildings(many, GRID), 20).process(flatGrid(100));
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
    });
});
