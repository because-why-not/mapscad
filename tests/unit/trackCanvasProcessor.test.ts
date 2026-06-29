import { describe, it, expect } from 'vitest';
import { addRasterRaise } from '../../src/model/TrackCanvasProcessor';

// Build an RGBA buffer (the form getImageData returns) whose RED channel carries the given
// coverage bytes (0..255); the other channels are irrelevant to addRasterRaise.
function rgba(reds: number[]): Uint8ClampedArray {
    const buf = new Uint8ClampedArray(reds.length * 4);
    for (let i = 0; i < reds.length; i++) buf[i * 4] = reds[i];
    return buf;
}

describe('addRasterRaise', () => {
    it('adds the full raise on white, nothing on black', () => {
        const out = addRasterRaise(rgba([255, 0]), new Float32Array([100, 100]), 10);
        expect(out[0]).toBe(110); // white (full coverage) → +10
        expect(out[1]).toBe(100); // black (no coverage)   → unchanged
    });

    it('scales by coverage and rounds to whole metres', () => {
        const out = addRasterRaise(rgba([128]), new Float32Array([0]), 10);
        expect(out[0]).toBe(5); // 128/255 ≈ 0.502 × 10 ≈ 5.02 → 5
    });

    it('encodes negative values (carving) when raise is negative, rounded to 1 m', () => {
        const out = addRasterRaise(rgba([255, 128]), new Float32Array([100, 100]), -10);
        expect(out[0]).toBe(90); // full coverage → −10
        expect(out[1]).toBe(95); // ~half coverage → round(−5.02) = −5
    });

    it('leaves no-data (NaN) cells untouched', () => {
        const out = addRasterRaise(rgba([255]), new Float32Array([NaN]), 10);
        expect(Number.isNaN(out[0])).toBe(true);
    });

    it('does not mutate the input heights', () => {
        const heights = new Float32Array([100]);
        addRasterRaise(rgba([255]), heights, 10);
        expect(heights[0]).toBe(100);
    });
});
