import { describe, it, expect } from 'vitest';
import { TerrariumMapData, type RawRaster } from '../../src/dem/TerrariumMapData';

// Build a raster from per-pixel [R,G,B,A] tuples (row-major, width*height of them).
function raster(width: number, height: number, px: number[][], origin = [0, 0], tileSize = 256): RawRaster {
    const data = new Uint8ClampedArray(width * height * 4);
    px.forEach((p, i) => data.set(p, i * 4));
    return { data, width, height, originX: origin[0], originY: origin[1], zoom: 14, tileSize };
}

// Terrarium: height = R*256 + G + B/256 - 32768. Encode a target metres value back to RGB.
function encode(m: number): [number, number, number, number] {
    const v = m + 32768;
    const r = Math.floor(v / 256);
    const g = Math.floor(v - r * 256);
    const b = Math.round((v - r * 256 - g) * 256);
    return [r, g, b, 255];
}

describe('TerrariumMapData.heightAtPixel', () => {
    it('decodes the terrarium formula', () => {
        // R=128 => 128*256 - 32768 = 0 m exactly.
        const d = new TerrariumMapData(raster(1, 1, [[128, 0, 0, 255]]));
        expect(d.heightAtPixel(0, 0)).toBe(0);
    });

    it('decodes G (1 m steps) and B (sub-metre)', () => {
        const d = new TerrariumMapData(raster(1, 1, [[128, 10, 128, 255]]));
        expect(d.heightAtPixel(0, 0)).toBeCloseTo(10.5, 6);
    });

    it('round-trips a range of encoded heights', () => {
        for (const m of [-400, -1, 0, 1, 250.5, 1234, 8848]) {
            const d = new TerrariumMapData(raster(1, 1, [encode(m)]));
            expect(d.heightAtPixel(0, 0)).toBeCloseTo(m, 2);
        }
    });

    it('returns NaN for a fully transparent (no-data) pixel', () => {
        const d = new TerrariumMapData(raster(1, 1, [[200, 5, 5, 0]]));
        expect(d.heightAtPixel(0, 0)).toBeNaN();
    });

    it('clamps out-of-bounds reads to the edge pixel', () => {
        // 2×1: left = 0 m, right = 256 m. Reads past either side clamp in.
        const d = new TerrariumMapData(raster(2, 1, [encode(0), encode(256)]));
        expect(d.heightAtPixel(-5, 0)).toBeCloseTo(0, 2);   // clamp to x=0
        expect(d.heightAtPixel(99, 0)).toBeCloseTo(256, 2); // clamp to x=1
    });

    it('maps global pixels through the raster origin', () => {
        // A 1×1 raster whose pixel sits at global (256, 0).
        const d = new TerrariumMapData(raster(1, 1, [encode(42)], [256, 0]));
        expect(d.heightAtPixel(256, 0)).toBeCloseTo(42, 2); // global 256 -> local 0
        expect(d.heightAtPixel(0, 0)).toBeCloseTo(42, 2);   // global 0 clamps to local 0
    });

    it('reports tiles fetched from raster size', () => {
        const d = new TerrariumMapData(raster(512, 256, [], [0, 0], 256));
        expect(d.tilesX).toBe(2);
        expect(d.tilesY).toBe(1);
    });
});
