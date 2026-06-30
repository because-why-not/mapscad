import { describe, it, expect } from 'vitest';
import { buildQuery, osmFeature } from '../../src/osm/osmFeatures';
import { parseWays, waysFromJson } from '../../src/osm/OverpassFeature';

const tracks = osmFeature('tracks');
const buildings = osmFeature('buildings');
const streets = osmFeature('streets');

describe('buildQuery (registry-driven)', () => {
    it('embeds the bbox as (south,west,north,east) and the feature selector', () => {
        const q = buildQuery(tracks, { south: 50, west: 9, north: 52, east: 11 });
        expect(q).toContain('(50,9,52,11)');
        expect(q).toContain('way["highway"~"^(path|track|bridleway)$"]');
        expect(q).toContain('out geom;');
    });

    it('uses each feature\'s own selector', () => {
        expect(buildQuery(buildings, { south: 0, west: 0, north: 1, east: 1 })).toContain('way["building"]');
        expect(buildQuery(streets, { south: 0, west: 0, north: 1, east: 1 }))
            .toContain('motorway|trunk|primary|secondary|tertiary|unclassified|residential');
    });
});

describe('parseWays', () => {
    it('turns each geometry-carrying way into a [lon,lat] polyline', () => {
        const json = { elements: [{ type: 'way', geometry: [{ lat: 50, lon: 9 }, { lat: 50.1, lon: 9.1 }] }] };
        expect(parseWays(tracks, json)).toEqual([[[9, 50], [9.1, 50.1]]]);
    });

    it('honours the feature minPoints: a 2-point ring is too short for an area feature', () => {
        const json = { elements: [{ type: 'way', geometry: [{ lat: 50, lon: 9 }, { lat: 50, lon: 9.1 }] }] };
        expect(parseWays(tracks, json)).toEqual([[[9, 50], [9.1, 50]]]); // ok as a line (min 2)
        expect(parseWays(buildings, json)).toEqual([]);                  // dropped as an area (min 3)
    });

    it('drops non-ways and is safe on empty / malformed input', () => {
        expect(parseWays(tracks, { elements: [{ type: 'node', lat: 1, lon: 1 }] })).toEqual([]);
        expect(parseWays(tracks, {})).toEqual([]);
        expect(parseWays(tracks, null)).toEqual([]);
    });
});

describe('waysFromJson', () => {
    it('parses a raw Overpass response (has .elements)', () => {
        const json = { elements: [{ type: 'way', geometry: [{ lat: 50, lon: 9 }, { lat: 50.1, lon: 9.1 }] }] };
        expect(waysFromJson(tracks, json)).toEqual([[[9, 50], [9.1, 50.1]]]);
    });

    it('accepts an already-parsed array, dropping ways under the feature minPoints', () => {
        const lines = [
            [[9, 50]],                                  // single point → too short for any feature
            [[9, 50], [9.1, 50.1]],                     // 2 points
            [[9, 50], [9.1, 50.1], [9.2, 50.2]],        // 3 points
        ];
        expect(waysFromJson(tracks, lines as any)).toEqual([lines[1], lines[2]]); // lines need ≥2
        expect(waysFromJson(buildings, lines as any)).toEqual([lines[2]]);        // areas need ≥3
    });

    it('drops malformed points from an array', () => {
        const lines = [[[9, 50], ['x', 50.1]]];
        expect(waysFromJson(tracks, lines as any)).toEqual([]);
    });
});
