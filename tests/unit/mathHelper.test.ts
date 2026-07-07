import { describe, it, expect } from 'vitest';
import { groundResolution, zoomForResolution } from '../../src/kit/common/mathHelper';

describe('groundResolution', () => {
    it('returns ~156.5 km/px at the equator, zoom 0 (full earth across one 256px tile)', () => {
        // 40075016.686 m circumference / 256 px ≈ 156543 m/px
        expect(groundResolution(0, 0)).toBeCloseTo(156543.03, 1);
    });

    it('halves per zoom level', () => {
        expect(groundResolution(0, 1)).toBeCloseTo(groundResolution(0, 0) / 2, 6);
    });

    it('shrinks toward the poles by cos(latitude)', () => {
        expect(groundResolution(60, 5)).toBeCloseTo(groundResolution(0, 5) * Math.cos(60 * Math.PI / 180), 6);
    });

    it('is twice as fine for 512px tiles (e.g. Mapterhorn) at the same zoom', () => {
        expect(groundResolution(0, 10, 512)).toBeCloseTo(groundResolution(0, 10, 256) / 2, 6);
    });
});

describe('zoomForResolution', () => {
    it('is the exact inverse of groundResolution', () => {
        // Pick a zoom, get its resolution, and recover the same (fractional) zoom.
        for (const [lat, zoom, tileSize] of [[0, 12, 256], [45, 8, 256], [-33, 14, 512]] as const) {
            const res = groundResolution(lat, zoom, tileSize);
            expect(zoomForResolution(lat, res, tileSize)).toBeCloseTo(zoom, 9);
        }
    });

    it('drops by one level when the target resolution doubles (coarser)', () => {
        const z = zoomForResolution(0, 10, 256);
        expect(zoomForResolution(0, 20, 256)).toBeCloseTo(z - 1, 9);
    });

    it('needs one level less for 512px tiles (twice as fine per zoom)', () => {
        expect(zoomForResolution(0, 10, 512)).toBeCloseTo(zoomForResolution(0, 10, 256) - 1, 9);
    });

    it('matches the ~10 m/px worked example: z≈13.4 at the equator', () => {
        // C / (256 · 10) ≈ 15654 ; log2 ≈ 13.93 at the equator, less as cos(lat) shrinks it.
        expect(zoomForResolution(0, 10, 256)).toBeCloseTo(13.93, 2);
        expect(zoomForResolution(45, 10, 256)).toBeCloseTo(13.43, 2);
    });
});
