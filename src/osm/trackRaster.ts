import type { LonLat } from '../SelectionArea';
import type { Track } from './OverpassTracks';

/**
 * Rasterises OSM tracks into the sampled grid as a per-cell distance field: for each cell, the
 * distance in metres to the nearest track. This is the "vectors → cols×rows grid space" step
 * from the todo's layered pipeline, aligned to the selection via its corners. It's independent
 * of the raise amount/radius, so it's computed once per grid (TrackRaiseProcessor then just
 * thresholds it), and recomputed only when the tracks or the grid resolution change.
 */

/** Per-cell distance (metres) to the nearest track, row-major over cols×rows. Cells with no
 *  track in range are `Infinity`. */
export function trackDistanceField(
    corners: LonLat[], tracks: Track[], cols: number, rows: number,
    widthMeters: number, heightMeters: number,
): Float32Array {
    const field = new Float32Array(cols * rows);
    field.fill(Infinity);

    // Affine basis: TL is the origin, eU points along the width (→TR), eV along the height
    // (→BL). Inverting it maps a lon/lat onto the rectangle's own (u,v) ∈ [0,1] axes. Exact for
    // an unrotated rect; a good approximation for the slightly-trapezoidal lon/lat quad of a
    // rotated selection (the same small-area planar assumption rectExtent already makes).
    const [TL, TR, , BL] = corners;
    const eUx = TR[0] - TL[0], eUy = TR[1] - TL[1];
    const eVx = BL[0] - TL[0], eVy = BL[1] - TL[1];
    const det = eUx * eVy - eUy * eVx;
    if (!det || tracks.length === 0) return field;

    // Project every track vertex into metre space (x east along the width, y south along the
    // height) and collect segments as a flat [x0,y0,x1,y1,…] array for the inner loop.
    const segs: number[] = [];
    for (const line of tracks) {
        let px = NaN, py = NaN;
        for (const [lon, lat] of line) {
            const dx = lon - TL[0], dy = lat - TL[1];
            const u = (dx * eVy - dy * eVx) / det;
            const v = (eUx * dy - eUy * dx) / det;
            const mx = u * widthMeters, my = v * heightMeters;
            if (!Number.isNaN(px)) segs.push(px, py, mx, my);
            px = mx; py = my;
        }
    }
    if (segs.length === 0) return field;

    for (let r = 0; r < rows; r++) {
        const cy = ((r + 0.5) / rows) * heightMeters;
        for (let c = 0; c < cols; c++) {
            const cx = ((c + 0.5) / cols) * widthMeters;
            let best = Infinity;
            for (let s = 0; s < segs.length; s += 4) {
                const d = distToSegment(cx, cy, segs[s], segs[s + 1], segs[s + 2], segs[s + 3]);
                if (d < best) best = d;
            }
            field[r * cols + c] = best;
        }
    }
    return field;
}

/** Euclidean distance from point (px,py) to the segment (ax,ay)→(bx,by). */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const abx = bx - ax, aby = by - ay;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - (ax + t * abx), dy = py - (ay + t * aby);
    return Math.hypot(dx, dy);
}
