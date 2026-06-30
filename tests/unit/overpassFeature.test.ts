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
    it('turns each geometry-carrying way into an element with id, name and coords', () => {
        const json = { elements: [
            { type: 'way', id: 42, tags: { name: 'River Track' }, geometry: [{ lat: 50, lon: 9 }, { lat: 50.1, lon: 9.1 }] },
        ] };
        expect(parseWays(tracks, json)).toEqual([{ id: 42, name: 'River Track', coords: [[9, 50], [9.1, 50.1]] }]);
    });

    it('leaves name undefined when the way has no name tag', () => {
        const json = { elements: [{ type: 'way', id: 7, geometry: [{ lat: 50, lon: 9 }, { lat: 50.1, lon: 9.1 }] }] };
        expect(parseWays(tracks, json)).toEqual([{ id: 7, name: undefined, coords: [[9, 50], [9.1, 50.1]] }]);
    });

    it('honours the feature minPoints: a 2-point way is too short for an area feature', () => {
        const json = { elements: [{ type: 'way', id: 1, geometry: [{ lat: 50, lon: 9 }, { lat: 50, lon: 9.1 }] }] };
        expect(parseWays(tracks, json)).toHaveLength(1);   // ok as a line (min 2)
        expect(parseWays(buildings, json)).toEqual([]);     // dropped as an area (min 3)
    });

    it('drops non-ways and is safe on empty / malformed input', () => {
        expect(parseWays(tracks, { elements: [{ type: 'node', lat: 1, lon: 1 }] })).toEqual([]);
        expect(parseWays(tracks, {})).toEqual([]);
        expect(parseWays(tracks, null)).toEqual([]);
    });
});

describe('waysFromJson', () => {
    it('parses a raw Overpass response (has .elements)', () => {
        const json = { elements: [{ type: 'way', id: 5, geometry: [{ lat: 50, lon: 9 }, { lat: 50.1, lon: 9.1 }] }] };
        expect(waysFromJson(tracks, json)).toEqual([{ id: 5, name: undefined, coords: [[9, 50], [9.1, 50.1]] }]);
    });

    it('accepts an array of saved OsmElement objects, keeping id + name', () => {
        const saved = [{ id: 9, name: 'Lane', coords: [[9, 50], [9.1, 50.1]] }];
        expect(waysFromJson(tracks, saved as any)).toEqual([{ id: 9, name: 'Lane', coords: [[9, 50], [9.1, 50.1]] }]);
    });

    it('accepts a legacy array of bare [lon,lat] polylines, assigning synthetic negative ids', () => {
        const legacy = [[[9, 50], [9.1, 50.1]], [[8, 40], [8.1, 40.1]]];
        const out = waysFromJson(tracks, legacy as any);
        expect(out.map(e => e.coords)).toEqual(legacy);
        expect(out.every(e => e.id < 0)).toBe(true);
        expect(out[0].id).not.toBe(out[1].id); // unique
    });

    it('drops entries under the feature minPoints (lines need ≥2, areas ≥3)', () => {
        const items = [
            { id: 1, coords: [[9, 50]] },                          // too short
            { id: 2, coords: [[9, 50], [9.1, 50.1]] },             // 2 points
            { id: 3, coords: [[9, 50], [9.1, 50.1], [9.2, 50.2]] },// 3 points
        ];
        expect(waysFromJson(tracks, items as any).map(e => e.id)).toEqual([2, 3]);
        expect(waysFromJson(buildings, items as any).map(e => e.id)).toEqual([3]);
    });
});
