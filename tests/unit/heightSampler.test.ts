import { describe, it, expect } from 'vitest';
import { groundResolution } from '../../src/HeightSampler';

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
});
