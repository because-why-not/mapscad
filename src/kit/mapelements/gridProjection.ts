import type { LonLat } from '../common/mathHelper';

/** The sampled grid lon/lat vectors are projected against: the selection corners plus the
 *  heightmap resolution. (Metre extents aren't needed for the col/row projection.) */
export interface GridSpace {
    corners: LonLat[];
    cols: number;
    rows: number;
}

/**
 * Project lon/lat polylines (or rings) onto the heightmap's fractional `[col, row]` sample space,
 * using the affine corner basis (SW origin, eU→SE = eastward/+col, eV→NW = northward/+row; corners
 * are ordered SW, SE, NE, NW). Heightmap samples sit at `(c+0.5)/cols`, `(r+0.5)/rows`, so the
 * inverse is `u·cols − 0.5` / `v·rows − 0.5`. Exact for an unrotated rect, a good approximation for
 * the slightly-trapezoidal lon/lat quad of a rotated selection. A degenerate (zero-area) basis
 * yields empty lines. Shared by `Tracks` (polylines) and `Buildings` (rings).
 */
export function projectLonLatLines(lines: readonly LonLat[][], g: GridSpace): LonLat[][] {
    const [SW, SE, , NW] = g.corners;
    const eUx = SE[0] - SW[0], eUy = SE[1] - SW[1]; // eastward basis (u / +col)
    const eVx = NW[0] - SW[0], eVy = NW[1] - SW[1]; // northward basis (v / +row)
    const det = eUx * eVy - eUy * eVx;
    if (!det) return lines.map(() => []);
    return lines.map(line => line.map(([lon, lat]) => {
        const dx = lon - SW[0], dy = lat - SW[1];
        const u = (dx * eVy - dy * eVx) / det;
        const v = (eUx * dy - eUy * dx) / det;
        return [u * g.cols - 0.5, v * g.rows - 0.5] as LonLat; // [col, row], parallel to [lon, lat]
    }));
}
