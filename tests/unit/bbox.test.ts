import { describe, it, expect } from 'vitest';
import { cornersToBBox } from '../../src/kit/mapelements/bbox';
import type { LonLat } from '../../src/kit/common/mathHelper';

describe('cornersToBBox', () => {
    it('takes the axis-aligned bounds of the (possibly rotated) corners', () => {
        // A rotated quad: bounds should be the enclosing box, not any single corner pair.
        const corners: LonLat[] = [[10, 50], [11, 51], [10.5, 52], [9, 51]];
        expect(cornersToBBox(corners)).toEqual({ south: 50, west: 9, north: 52, east: 11 });
    });
});
