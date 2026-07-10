import type { LonLat } from '../src/kit/common/mathHelper';

/**
 * THE shared test area — used by the scenario walkthrough AND both golden STL harnesses (the
 * dunedin-download e2e and its headless twin), so every tier exercises the exact same ground.
 *
 * A coastal box with a diverse OSM mix (streets, tracks, buildings and water). Deliberately not
 * named after a place — it changes now and then; paste the `sel=` corners from any share link to
 * swap it, then rebake the goldens (UPDATE_GOLDEN=1 e2e, UPDATE_TILES=1 twin — see those files).
 *
 * Corner order SW, SE, NE, NW (lon, lat) — corner[0] is the SOUTH-west corner, the order
 * SelectionArea emits / getSelection() returns (grid row 0 = the south edge).
 */
export const TEST_AREA: LonLat[] = [
    [170.53672, -45.90842],
    [170.54391, -45.90842],
    [170.54391, -45.90245],
    [170.53672, -45.90245],
];

/** A share link for eyeballing TEST_AREA in the running app (adjust the host if it isn't local). */
export function selectionLink(corners: LonLat[]): string {
    const lat = corners.reduce((s, c) => s + c[1], 0) / corners.length;
    const lng = corners.reduce((s, c) => s + c[0], 0) / corners.length;
    const sel = corners.map(([lon, la]) => `${lon},${la}`).join(';');
    return `http://localhost:8003/#map=openstreetmap&lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&z=15&shape=rectangle&sel=${sel}`;
}
