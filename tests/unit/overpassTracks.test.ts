import { describe, it, expect } from 'vitest';
import { cornersToBBox, buildQuery, parseTracks } from '../../src/osm/OverpassTracks';
import type { LonLat } from '../../src/SelectionArea';

describe('cornersToBBox', () => {
    it('takes the axis-aligned bounds of the (possibly rotated) corners', () => {
        // A rotated quad: bounds should be the enclosing box, not any single corner pair.
        const corners: LonLat[] = [[10, 50], [11, 51], [10.5, 52], [9, 51]];
        expect(cornersToBBox(corners)).toEqual({ south: 50, west: 9, north: 52, east: 11 });
    });
});

describe('buildQuery', () => {
    it('embeds the bbox as (south,west,north,east) and the walking-highway filter', () => {
        const q = buildQuery({ south: 50, west: 9, north: 52, east: 11 });
        expect(q).toContain('(50,9,52,11)');
        expect(q).toContain('path|footway|track|steps|bridleway|pedestrian');
        expect(q).toContain('out geom;');
    });
});

describe('parseTracks', () => {
    it('turns each geometry-carrying way into a [lon,lat] polyline', () => {
        const json = {
            elements: [
                { type: 'way', geometry: [{ lat: 50, lon: 9 }, { lat: 50.1, lon: 9.1 }] },
            ],
        };
        expect(parseTracks(json)).toEqual([[[9, 50], [9.1, 50.1]]]);
    });

    it('drops non-ways, geometry-less ways, and single-point ways', () => {
        const json = {
            elements: [
                { type: 'node', lat: 50, lon: 9 },                 // not a way
                { type: 'way', tags: { highway: 'path' } },        // no geometry (out tags)
                { type: 'way', geometry: [{ lat: 50, lon: 9 }] },  // only one point
            ],
        };
        expect(parseTracks(json)).toEqual([]);
    });

    it('is safe on an empty / malformed response', () => {
        expect(parseTracks({})).toEqual([]);
        expect(parseTracks(null)).toEqual([]);
    });
});
