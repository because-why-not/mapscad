import type { LonLat } from '../common/mathHelper';

/** Axis-aligned lon/lat bounds of the (possibly rotated) selection corners. */
export interface BBox {
    south: number;
    west: number;
    north: number;
    east: number;
}

/** Bounding box of the selection corners. A rotated selection yields its enclosing box, so an
 *  Overpass query may pull a few features just outside the drawn shape — acceptable for overlays
 *  and for the rasteriser (which clips to the canvas anyway). */
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
