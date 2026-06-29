import type { LonLat } from '../SelectionArea';
import { Env } from '../Env';
import { cornersToBBox, type BBox } from './OverpassTracks';

/**
 * Fetches building footprints for a selection from the OpenStreetMap Overpass API. Mirrors
 * `OverpassTracks` (pure network + parsing, no map/DOM coupling) but pulls `building` ways as
 * closed rings instead of `highway` polylines. Consumed by the map-view overlay (`BuildingOverlay`)
 * and the height-grid pipeline (`BuildingCanvasProcessor`, which raises each footprint).
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** A single building footprint: a closed ring of [lon, lat] points. */
export type Building = LonLat[];

/** Overpass QL for every building way within the bbox, geometry inlined (`out geom`). Ways only
 *  (no multipolygon relations) — keeps the parser a single code path; covers the vast majority. */
export function buildQuery(bbox: BBox): string {
    const { south, west, north, east } = bbox;
    return `[out:json][timeout:25];
(
  way["building"](${south},${west},${north},${east});
);
out geom;`;
}

/** Parse an Overpass JSON response into building rings. Each `way` with inlined `geometry`
 *  becomes a [lon,lat] ring; ways with fewer than three points are dropped (not an area). */
export function parseBuildings(json: any): Building[] {
    const buildings: Building[] = [];
    for (const el of json?.elements ?? []) {
        if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
        const ring: Building = el.geometry
            .filter((g: any) => g && typeof g.lon === 'number' && typeof g.lat === 'number')
            .map((g: any) => [g.lon, g.lat] as LonLat);
        if (ring.length >= 3) buildings.push(ring);
    }
    return buildings;
}

/** Build buildings from either a raw Overpass JSON response (has `.elements` — what a downloaded
 *  file holds) or an already-parsed array of [lon,lat] rings. Lets the Upload button accept
 *  whatever was saved without the caller knowing which form it is. */
export function buildingsFromJson(json: any): Building[] {
    if (Array.isArray(json)) {
        return json.filter((ring): ring is Building =>
            Array.isArray(ring) && ring.length >= 3 &&
            ring.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number'));
    }
    return parseBuildings(json);
}

/** Download the raw Overpass JSON response for the selection (unparsed, so it can be saved to
 *  disk verbatim and re-ingested later). Throws on a non-OK Overpass response. */
export async function fetchBuildingsRaw(corners: LonLat[], signal?: AbortSignal): Promise<any> {
    const query = buildQuery(cornersToBBox(corners));
    Env.log('[buildings] downloading buildings from Overpass…');
    const t0 = performance.now();
    const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        signal,
    });
    if (!res.ok) throw new Error(`Overpass request failed (${res.status})`);
    const json = await res.json();
    Env.log(`[buildings] downloaded ${json?.elements?.length ?? 0} elements in ${Math.round(performance.now() - t0)} ms`);
    return json;
}

/** Download all building footprints within the selection. Throws on a non-OK Overpass response. */
export async function fetchBuildings(corners: LonLat[], signal?: AbortSignal): Promise<Building[]> {
    return parseBuildings(await fetchBuildingsRaw(corners, signal));
}
