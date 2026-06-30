import type { LonLat } from '../SelectionArea';
import { Env } from '../Env';
import { cornersToBBox } from './bbox';
import { buildQuery, type OsmFeatureDef } from './osmFeatures';

/**
 * Generic OSM-feature fetcher: pure network + parsing, no map/DOM coupling. Replaces the old
 * per-feature OverpassTracks/Streets/Buildings modules — the only thing that varied between them
 * was the query selector and the minimum vertex count, both of which now live on `OsmFeatureDef`.
 * A way's inlined `geometry` becomes a `[lon, lat]` polyline (a ring for area features).
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** A single OSM way: a `[lon, lat]` polyline (a closed ring for area features). */
export type OsmWay = LonLat[];

/** Parse an Overpass JSON response into ways. Each `way` with inlined `geometry` becomes a
 *  `[lon,lat]` polyline; ways with fewer than `def.minPoints` points are dropped. */
export function parseWays(def: OsmFeatureDef, json: any): OsmWay[] {
    const ways: OsmWay[] = [];
    for (const el of json?.elements ?? []) {
        if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
        const line: OsmWay = el.geometry
            .filter((g: any) => g && typeof g.lon === 'number' && typeof g.lat === 'number')
            .map((g: any) => [g.lon, g.lat] as LonLat);
        if (line.length >= def.minPoints) ways.push(line);
    }
    return ways;
}

/** Build ways from either a raw Overpass JSON response (has `.elements` — what a downloaded file
 *  holds) or an already-parsed array of `[lon,lat]` polylines. Lets the Upload button accept
 *  whatever was saved without the caller knowing which form it is. */
export function waysFromJson(def: OsmFeatureDef, json: any): OsmWay[] {
    if (Array.isArray(json)) {
        return json.filter((line): line is OsmWay =>
            Array.isArray(line) && line.length >= def.minPoints &&
            line.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number'));
    }
    return parseWays(def, json);
}

/** Download the raw Overpass JSON response for the selection (unparsed, so it can be saved to disk
 *  verbatim and re-ingested later). Throws on a non-OK Overpass response. */
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

/** Download all ways for the feature within the selection. Throws on a non-OK Overpass response. */
export async function fetchFeature(def: OsmFeatureDef, corners: LonLat[], signal?: AbortSignal): Promise<OsmWay[]> {
    return parseWays(def, await fetchFeatureRaw(def, corners, signal));
}
