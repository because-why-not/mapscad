import { describe, it, expect } from 'vitest';
import { buildQuery, parseStreets, streetsFromJson } from '../../src/osm/OverpassStreets';

describe('buildQuery (streets)', () => {
    it('embeds the bbox as (south,west,north,east) and the street-highway filter', () => {
        const q = buildQuery({ south: 50, west: 9, north: 52, east: 11 });
        expect(q).toContain('(50,9,52,11)');
        expect(q).toContain('motorway|trunk|primary|secondary|tertiary|unclassified|residential');
        expect(q).toContain('out geom;');
    });
});

describe('parseStreets', () => {
    it('turns each geometry-carrying way into a [lon,lat] polyline', () => {
        const json = {
            elements: [
                { type: 'way', geometry: [{ lat: 50, lon: 9 }, { lat: 50.1, lon: 9.1 }] },
            ],
        };
        expect(parseStreets(json)).toEqual([[[9, 50], [9.1, 50.1]]]);
    });

    it('drops non-ways, geometry-less ways, and single-point ways', () => {
        const json = {
            elements: [
                { type: 'node', lat: 50, lon: 9 },                 // not a way
                { type: 'way', tags: { highway: 'primary' } },     // no geometry (out tags)
                { type: 'way', geometry: [{ lat: 50, lon: 9 }] },  // only one point
            ],
        };
        expect(parseStreets(json)).toEqual([]);
    });

    it('is safe on an empty / malformed response', () => {
        expect(parseStreets({})).toEqual([]);
        expect(parseStreets(null)).toEqual([]);
    });
});

describe('streetsFromJson', () => {
    it('parses a raw Overpass response (has .elements)', () => {
        const json = { elements: [{ type: 'way', geometry: [{ lat: 50, lon: 9 }, { lat: 50.1, lon: 9.1 }] }] };
        expect(streetsFromJson(json)).toEqual([[[9, 50], [9.1, 50.1]]]);
    });

    it('accepts an already-parsed array of [lon,lat] polylines', () => {
        const lines = [[[9, 50], [9.1, 50.1]]];
        expect(streetsFromJson(lines)).toEqual(lines);
    });

    it('drops malformed polylines from an array (too short / bad points)', () => {
        const lines = [
            [[9, 50]],                       // single point
            [[9, 50], [9.1, 50.1]],          // good
            [[9, 50], ['x', 50.1]],          // non-numeric point
        ];
        expect(streetsFromJson(lines as any)).toEqual([[[9, 50], [9.1, 50.1]]]);
    });
});
