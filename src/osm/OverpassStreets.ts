import type { LonLat } from '../SelectionArea';
import { Env } from '../Env';
import { cornersToBBox, type BBox } from './OverpassTracks';

/**
 * Fetches streets (car roads) for a selection from the OpenStreetMap Overpass API. The road
 * counterpart of `OverpassTracks`: same pure network + parsing, same polyline shape, but a
 * different `highway` filter — ways a car drives on rather than foot-first tracks. Consumed by
 * the map-view overlay (`StreetOverlay`) and the height-grid pipeline (`StreetCanvasProcessor`).
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// OSM `highway` values that represent the drivable road network, plus their `_link` ramps and
// `living_street`. Deliberately excludes `service` (driveways/parking aisles) and `track`
// (handled by OverpassTracks) to keep this "streets you drive on", not every paved surface.
const STREET_HIGHWAYS = [
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
    'living_street', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
];

/** A single street: a polyline of [lon, lat] points (same shape as a track). */
export type Street = LonLat[];

/** Overpass QL for every street way within the bbox, geometry inlined (`out geom`). */
export function buildQuery(bbox: BBox): string {
    const { south, west, north, east } = bbox;
    const filter = STREET_HIGHWAYS.join('|');
    return `[out:json][timeout:25];
(
  way["highway"~"^(${filter})$"](${south},${west},${north},${east});
);
out geom;`;
}

/** Parse an Overpass JSON response into streets. Each `way` with inlined `geometry` becomes a
 *  [lon,lat] polyline; ways with fewer than two points are dropped. */
export function parseStreets(json: any): Street[] {
    const streets: Street[] = [];
    for (const el of json?.elements ?? []) {
        if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
        const line: Street = el.geometry
            .filter((g: any) => g && typeof g.lon === 'number' && typeof g.lat === 'number')
            .map((g: any) => [g.lon, g.lat] as LonLat);
        if (line.length >= 2) streets.push(line);
    }
    return streets;
}

/** Build streets from either a raw Overpass JSON response (has `.elements` — what a downloaded
 *  file holds) or an already-parsed array of [lon,lat] polylines. Lets the Upload button accept
 *  whatever was saved without the caller knowing which form it is. */
export function streetsFromJson(json: any): Street[] {
    if (Array.isArray(json)) {
        return json.filter((line): line is Street =>
            Array.isArray(line) && line.length >= 2 &&
            line.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number'));
    }
    return parseStreets(json);
}

/** Download the raw Overpass JSON response for the selection (unparsed, so it can be saved to
 *  disk verbatim and re-ingested later). Throws on a non-OK Overpass response. */
export async function fetchStreetsRaw(corners: LonLat[], signal?: AbortSignal): Promise<any> {
    const query = buildQuery(cornersToBBox(corners));
    Env.log('[streets] downloading streets from Overpass…');
    const t0 = performance.now();
    const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        signal,
    });
    if (!res.ok) throw new Error(`Overpass request failed (${res.status})`);
    const json = await res.json();
    Env.log(`[streets] downloaded ${json?.elements?.length ?? 0} elements in ${Math.round(performance.now() - t0)} ms`);
    return json;
}

/** Download all streets within the selection. Throws on a non-OK Overpass response. */
export async function fetchStreets(corners: LonLat[], signal?: AbortSignal): Promise<Street[]> {
    return parseStreets(await fetchStreetsRaw(corners, signal));
}
