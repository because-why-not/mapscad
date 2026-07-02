import type { LonLat } from '../mathHelper';
import { Env } from '../Env';
import { cornersToBBox } from './bbox';
import { buildQuery, type OsmFeatureDef } from './osmFeatures';
import { OSM_DATA_API } from './dataSources';

/**
 * Generic OSM-feature fetcher: pure network + parsing, no map/DOM coupling. Replaces the old
 * per-feature OverpassTracks/Streets/Buildings modules — the only thing that varied between them
 * was the query selector and the minimum vertex count, both of which now live on `OsmFeatureDef`.
 *
 * Each way becomes an `OsmElement`: its OSM id (stable identity for the object list + selection +
 * deletion), its `name` tag if present, and its `[lon, lat]` geometry (a ring for area features).
 */

const OVERPASS_URL = OSM_DATA_API.endpoint;

/** One OSM way: identity (id + optional name) plus its geometry (a closed ring for area features). */
export interface OsmElement {
    id: number;
    name?: string;
    coords: LonLat[];
    /** User-disabled: kept in the list (shown struck-through / grey on the map) but excluded from
     *  the preview. Absent/false = enabled. Persisted in the saved JSON so it round-trips. */
    disabled?: boolean;
}

function coordsFromGeometry(geometry: any[]): LonLat[] {
    return geometry
        .filter((g: any) => g && typeof g.lon === 'number' && typeof g.lat === 'number')
        .map((g: any) => [g.lon, g.lat] as LonLat);
}

/** Parse an Overpass JSON response into elements. Each `way` with inlined `geometry` (and tags,
 *  from `out geom`) becomes an element; ways with fewer than `def.minPoints` points are dropped. */
export function parseWays(def: OsmFeatureDef, json: any): OsmElement[] {
    const out: OsmElement[] = [];
    for (const el of json?.elements ?? []) {
        if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
        const coords = coordsFromGeometry(el.geometry);
        if (coords.length < def.minPoints) continue;
        const name = typeof el.tags?.name === 'string' ? el.tags.name : undefined;
        out.push({ id: Number(el.id), name, coords });
    }
    return out;
}

function validCoords(coords: any, minPoints: number): coords is LonLat[] {
    return Array.isArray(coords) && coords.length >= minPoints &&
        coords.every((p: any) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number');
}

/** Build elements from either a raw Overpass JSON response (has `.elements`), an array of saved
 *  `OsmElement` objects (what Download now writes), or a legacy array of bare `[lon,lat]` polylines
 *  (older saved files). Synthetic negative ids are assigned where none exist, so they never collide
 *  with real (positive) OSM ids. Lets Upload accept whatever was saved. */
export function waysFromJson(def: OsmFeatureDef, json: any): OsmElement[] {
    if (Array.isArray(json)) {
        const out: OsmElement[] = [];
        let synthetic = -1;
        for (const item of json) {
            if (validCoords(item, def.minPoints)) {                 // legacy bare polyline
                out.push({ id: synthetic--, coords: item });
            } else if (item && validCoords(item.coords, def.minPoints)) { // OsmElement object
                const id = Number.isFinite(item.id) ? item.id : synthetic--;
                const name = typeof item.name === 'string' ? item.name : undefined;
                const disabled = item.disabled === true ? true : undefined;
                out.push({ id, name, coords: item.coords, disabled });
            }
        }
        return out;
    }
    return parseWays(def, json);
}

/** Download the raw Overpass JSON response for the selection (unparsed). Throws on a non-OK response. */
export async function fetchFeatureRaw(def: OsmFeatureDef, corners: LonLat[], signal?: AbortSignal): Promise<any> {
    const query = buildQuery(def, cornersToBBox(corners));
    Env.log(`[osm] downloading ${def.noun} from Overpass…`);
    const t0 = performance.now();
    const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        signal,
    });
    if (!res.ok) throw new Error(`Overpass request failed (${res.status})`);
    const json = await res.json();
    Env.log(`[osm] downloaded ${json?.elements?.length ?? 0} ${def.noun} elements in ${Math.round(performance.now() - t0)} ms`);
    return json;
}

/** Download all elements for the feature within the selection. Throws on a non-OK Overpass response. */
export async function fetchFeature(def: OsmFeatureDef, corners: LonLat[], signal?: AbortSignal): Promise<OsmElement[]> {
    return parseWays(def, await fetchFeatureRaw(def, corners, signal));
}
