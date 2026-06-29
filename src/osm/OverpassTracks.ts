import type { LonLat } from '../SelectionArea';
import { Env } from '../Env';

/**
 * Fetches walking tracks for a selection from the OpenStreetMap Overpass API. Pure network +
 * parsing — no map/DOM coupling, so it can be unit-tested and later reused by the height-grid
 * pipeline (see todo.md "Layered vector + raster pipeline"). For now its only consumer is the
 * map-view overlay (`TrackOverlay`).
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// OSM `highway` values that represent walkable tracks/paths (foot-first ways). Kept narrow on
// purpose: this is "walking tracks", not the full road network.
const WALKING_HIGHWAYS = ['path', 'footway', 'track', 'steps', 'bridleway', 'pedestrian'];

/** A single track: a polyline of [lon, lat] points (lon/lat to match the app's LonLat). */
export type Track = LonLat[];

/** Axis-aligned lon/lat bounds of the (possibly rotated) selection corners. */
export interface BBox {
    south: number;
    west: number;
    north: number;
    east: number;
}

/** Bounding box of the selection corners. A rotated selection yields its enclosing box, so the
 *  query may pull a few tracks just outside the drawn shape — acceptable for an overlay. */
export function cornersToBBox(corners: LonLat[]): BBox {
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (const [lon, lat] of corners) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
    }
    return { south, west, north, east };
}

/** Overpass QL for every walking-track way within the bbox, geometry inlined (`out geom`). */
export function buildQuery(bbox: BBox): string {
    const { south, west, north, east } = bbox;
    const filter = WALKING_HIGHWAYS.join('|');
    return `[out:json][timeout:25];
(
  way["highway"~"^(${filter})$"](${south},${west},${north},${east});
);
out geom;`;
}

/** Parse an Overpass JSON response into tracks. Each `way` with inlined `geometry` becomes a
 *  [lon,lat] polyline; ways with fewer than two points are dropped. */
export function parseTracks(json: any): Track[] {
    const tracks: Track[] = [];
    for (const el of json?.elements ?? []) {
        if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
        const line: Track = el.geometry
            .filter((g: any) => g && typeof g.lon === 'number' && typeof g.lat === 'number')
            .map((g: any) => [g.lon, g.lat] as LonLat);
        if (line.length >= 2) tracks.push(line);
    }
    return tracks;
}

/** Download all walking tracks within the selection. Throws on a non-OK Overpass response. */
export async function fetchWalkingTracks(corners: LonLat[], signal?: AbortSignal): Promise<Track[]> {
    const query = buildQuery(cornersToBBox(corners));
    Env.log('[tracks] downloading walking tracks from Overpass…');
    const t0 = performance.now();
    const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        signal,
    });
    if (!res.ok) throw new Error(`Overpass request failed (${res.status})`);
    const json = await res.json();
    const tracks = parseTracks(json);
    Env.log(`[tracks] downloaded ${tracks.length} tracks in ${Math.round(performance.now() - t0)} ms`);
    return tracks;
}
