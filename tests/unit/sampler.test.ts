import { describe, it, expect } from 'vitest';
import { lonLatToWorldPx, rectPoint, sampleHeights } from '../../src/dem/Sampler';
import { TerrariumMapData, type RawRaster } from '../../src/dem/TerrariumMapData';
import type { LonLat } from '../../src/SelectionArea';

function encode(m: number): [number, number, number, number] {
    const v = m + 32768;
    const r = Math.floor(v / 256);
    const g = Math.floor(v - r * 256);
    const b = Math.round((v - r * 256 - g) * 256);
    return [r, g, b, 255];
}

// A raster (all pixels = the same height, or transparent) big enough that sampling never
// needs more than edge-clamped reads — fine for the constant / no-data structural tests.
function flatRaster(fill: [number, number, number, number]): RawRaster {
    const data = new Uint8ClampedArray(4);
    data.set(fill, 0);
    return { data, width: 1, height: 1, originX: 0, originY: 0, zoom: 14, tileSize: 256 };
}

const CORNERS: LonLat[] = [[0, 0.01], [0.02, 0.01], [0.02, -0.01], [0, -0.01]]; // TL,TR,BR,BL near equator

describe('rectPoint', () => {
    it('returns the corners at the unit-square extremes', () => {
        expect(rectPoint(CORNERS, 0, 0)).toEqual(CORNERS[0]); // TL
        expect(rectPoint(CORNERS, 1, 0)).toEqual(CORNERS[1]); // TR
        expect(rectPoint(CORNERS, 1, 1)).toEqual(CORNERS[2]); // BR
        expect(rectPoint(CORNERS, 0, 1)).toEqual(CORNERS[3]); // BL
    });
    it('bilinearly interpolates the centre', () => {
        expect(rectPoint(CORNERS, 0.5, 0.5)).toEqual([0.01, 0]);
    });
});

describe('lonLatToWorldPx', () => {
    it('puts (0,0) at the centre of the world at zoom 0', () => {
        expect(lonLatToWorldPx(0, 0, 0, 256)).toEqual([128, 128]);
    });
    it('doubles resolution per zoom level', () => {
        const [x1] = lonLatToWorldPx(45, 0, 1, 256);
        const [x0] = lonLatToWorldPx(45, 0, 0, 256);
        expect(x1).toBeCloseTo(x0 * 2, 6);
    });
    it('scales with tileSize (512px tiles are twice as fine)', () => {
        const [x512] = lonLatToWorldPx(45, 0, 5, 512);
        const [x256] = lonLatToWorldPx(45, 0, 5, 256);
        expect(x512).toBeCloseTo(x256 * 2, 6);
    });
});

describe('sampleHeights', () => {
    it('produces a cols×rows grid of a constant height', () => {
        const data = new TerrariumMapData(flatRaster(encode(123.5)));
        const g = sampleHeights(CORNERS, data, 5, 4, 200, 100);
        expect(g.cols).toBe(5);
        expect(g.rows).toBe(4);
        expect(g.heights).toHaveLength(20);
        expect([...g.heights].every(h => Math.abs(h - 123.5) < 1e-2)).toBe(true);
        expect(g.minHeight).toBeCloseTo(123.5, 2);
        expect(g.maxHeight).toBeCloseTo(123.5, 2);
        expect(g.widthMeters).toBe(200);
        expect(g.heightMeters).toBe(100);
        expect(g.zoom).toBe(14);
    });

    it('fills all-no-data with a flat zero floor', () => {
        const data = new TerrariumMapData(flatRaster([0, 0, 0, 0])); // transparent
        const g = sampleHeights(CORNERS, data, 3, 3, 10, 10);
        expect([...g.heights].every(h => h === 0)).toBe(true);
        expect(g.minHeight).toBe(0);
        expect(g.maxHeight).toBe(0);
    });

    it('samples varying data: a north→south gradient increases down the rows', () => {
        // Build a raster covering the selection's pixel bbox, each pixel encoding its own
        // (local) row as a height. South = larger Mercator y = larger height.
        const z = 14, tileSize = 256;
        const px = CORNERS.map(c => lonLatToWorldPx(c[0], c[1], z, tileSize));
        const minX = Math.floor(Math.min(...px.map(p => p[0]))) - 1;
        const minY = Math.floor(Math.min(...px.map(p => p[1]))) - 1;
        const maxX = Math.ceil(Math.max(...px.map(p => p[0]))) + 1;
        const maxY = Math.ceil(Math.max(...px.map(p => p[1]))) + 1;
        const W = maxX - minX, H = maxY - minY;
        const buf = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) buf.set(encode(y), (y * W + x) * 4);
        }
        const data = new TerrariumMapData({ data: buf, width: W, height: H, originX: minX, originY: minY, zoom: z, tileSize });

        const g = sampleHeights(CORNERS, data, 4, 4, 100, 100);
        // Down a fixed column, height must strictly increase (north→south).
        for (let c = 0; c < g.cols; c++) {
            for (let r = 1; r < g.rows; r++) {
                expect(g.heights[r * g.cols + c]).toBeGreaterThan(g.heights[(r - 1) * g.cols + c]);
            }
        }
        expect(g.maxHeight).toBeGreaterThan(g.minHeight);
    });
});
