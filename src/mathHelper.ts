/** A geographic point as `[longitude, latitude]` in degrees — the base coordinate type the
 *  whole app passes around (selections, OSM geometry, sampling). */
export type LonLat = [number, number];

/**
 * Geodesy + Web-Mercator tile math — the raw formulas the DEM pipeline is built on, gathered
 * in one documented place. Everything here is pure (no DOM, no manifest types) so it's trivial
 * to test and reuse.
 *
 * Web Mercator (EPSG:3857) maps the globe onto a square divided into 2^zoom × 2^zoom tiles of
 * `tileSize` pixels each. One more zoom level doubles the tile count per axis, so it halves the
 * ground distance a pixel covers. Because the projection stretches toward the poles, the true
 * ground resolution also scales with cos(latitude).
 */

/** Equatorial circumference of the WGS-84 ellipsoid, metres (2·π·a). Sets the Mercator scale. */
export const EARTH_CIRCUMFERENCE = 40075016.686;
/** WGS-84 semi-major axis (equatorial radius), metres. Used for great-circle distance. */
export const EARTH_RADIUS = 6378137;
/** Standard tile edge in pixels; some sources differ (Mapterhorn is 512) and pass their own. */
export const DEFAULT_TILE_SIZE = 256;

const DEG = Math.PI / 180;

/** Great-circle distance between two lon/lat points, in metres (haversine formula). */
export function haversine([lon1, lat1]: LonLat, [lon2, lat2]: LonLat): number {
    const dLat = (lat2 - lat1) * DEG;
    const dLon = (lon2 - lon1) * DEG;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
}

/**
 * Web-Mercator ground resolution — metres covered by one pixel — at a given zoom and latitude.
 * `res = C·cos(lat) / (tileSize · 2^zoom)`. Each zoom step halves it; a larger `tileSize`
 * packs more pixels into the same span, so it's proportionally finer.
 */
export function groundResolution(lat: number, zoom: number, tileSize = DEFAULT_TILE_SIZE): number {
    return EARTH_CIRCUMFERENCE * Math.cos(lat * DEG) / (tileSize * Math.pow(2, zoom));
}

/**
 * Inverse of {@link groundResolution}: the (fractional) zoom at which one pixel spans
 * `metresPerPixel` at the given latitude — `log2( C·cos(lat) / (tileSize · res) )`.
 *
 * The result is fractional; round to a real zoom depending on intent — `Math.ceil` for "at
 * least this fine" (never coarser than asked, downloads more), `Math.floor` for "no finer than
 * this" (fewer tiles), `Math.round` for nearest. Callers should also clamp to the zooms a DEM
 * actually stores.
 */
export function zoomForResolution(lat: number, metresPerPixel: number, tileSize = DEFAULT_TILE_SIZE): number {
    return Math.log2(EARTH_CIRCUMFERENCE * Math.cos(lat * DEG) / (tileSize * metresPerPixel));
}

/**
 * Lon/lat → global pixel coordinate at a given zoom (Web Mercator, `tileSize`-px tiles). The
 * global pixel plane is `tileSize · 2^zoom` wide; x is linear in longitude, y follows the
 * Mercator latitude projection.
 */
export function lonLatToWorldPx(lon: number, lat: number, z: number, tileSize: number): [number, number] {
    const scale = tileSize * Math.pow(2, z);
    const x = (lon + 180) / 360 * scale;
    const s = Math.sin(lat * DEG);
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
    return [x, y];
}
