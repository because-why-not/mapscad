import { describe, it, expect } from 'vitest';
import { buildQuery, parseBuildings, buildingsFromJson } from '../../src/osm/OverpassBuildings';

describe('buildQuery (buildings)', () => {
    it('embeds the bbox as (south,west,north,east) and the building filter', () => {
        const q = buildQuery({ south: 50, west: 9, north: 52, east: 11 });
        expect(q).toContain('(50,9,52,11)');
        expect(q).toContain('way["building"]');
        expect(q).toContain('out geom;');
    });
});

describe('parseBuildings', () => {
    it('turns each geometry-carrying way into a [lon,lat] ring', () => {
        const json = {
            elements: [
                { type: 'way', geometry: [{ lat: 50, lon: 9 }, { lat: 50, lon: 9.1 }, { lat: 50.1, lon: 9.1 }] },
            ],
        };
        expect(parseBuildings(json)).toEqual([[[9, 50], [9.1, 50], [9.1, 50.1]]]);
    });

    it('drops non-ways and rings with fewer than three points', () => {
        const json = {
            elements: [
                { type: 'node', lat: 50, lon: 9 },                                  // not a way
                { type: 'way', geometry: [{ lat: 50, lon: 9 }, { lat: 50, lon: 9.1 }] }, // only two points
            ],
        };
        expect(parseBuildings(json)).toEqual([]);
    });

    it('is safe on an empty / malformed response', () => {
        expect(parseBuildings({})).toEqual([]);
        expect(parseBuildings(null)).toEqual([]);
    });
});

describe('buildingsFromJson', () => {
    it('parses a raw Overpass response (has .elements)', () => {
        const json = { elements: [{ type: 'way', geometry: [{ lat: 50, lon: 9 }, { lat: 50, lon: 9.1 }, { lat: 50.1, lon: 9.1 }] }] };
        expect(buildingsFromJson(json)).toEqual([[[9, 50], [9.1, 50], [9.1, 50.1]]]);
    });

    it('accepts an already-parsed array of [lon,lat] rings, dropping malformed ones', () => {
        const rings = [
            [[9, 50], [9.1, 50]],                       // too few points
            [[9, 50], [9.1, 50], [9.1, 50.1]],          // good
        ];
        expect(buildingsFromJson(rings as any)).toEqual([[[9, 50], [9.1, 50], [9.1, 50.1]]]);
    });
});
