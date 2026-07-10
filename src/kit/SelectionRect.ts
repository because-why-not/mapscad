import { haversine, type LonLat } from './common/mathHelper';

/**
 * The selected region as a value object that ENFORCES the canonical corner order, so nothing else
 * in the program has to reason about it: corners are always **SW, SE, NE, NW** — counter-clockwise,
 * with corner[0] the south-west one. Downstream that means grid row 0 = the south edge, col 0 = the
 * west edge, and the built mesh is right-handed (never a N/S-mirrored model).
 *
 * `fromCorners` accepts the four corners in ANY cyclic order or winding (old saved configs and
 * hand-written test literals were N-edge-first) and normalizes:
 *   1. **Winding** — a clockwise ring describes the same rectangle but a mirrored grid; it is
 *      repaired by swapping the two edge rows. This is the chirality invariant that keeps prints
 *      true to the real terrain.
 *   2. **Phase** — the ring is rotated so corner[0] is the southernmost corner (west wins ties).
 *      For an axis-aligned selection that is literally the SW corner; for a rotated one it is the
 *      deterministic "grid SW", and the grid axes follow its edges.
 *
 * `MapscadSession.setSelection` routes every input through this class, so `getSelection()` (and the
 * `selectionChanged` payload) are canonical by construction — the map overlay, share links, boot
 * restore and headless scripts can feed corners in whatever order they have.
 */
export class SelectionRect {
    /** Canonical corners: SW, SE, NE, NW (counter-clockwise, corner[0] = south-west). */
    readonly corners: readonly LonLat[];

    private constructor(corners: readonly LonLat[]) {
        this.corners = corners;
    }

    /** Normalize four lon/lat corners (any cyclic order/winding) into a canonical rect. Throws on
     *  malformed input — a selection either exists as four finite corners or is null, never junk. */
    static fromCorners(input: readonly LonLat[]): SelectionRect {
        if (!Array.isArray(input) || input.length !== 4 || input.some(
            c => !Array.isArray(c) || c.length !== 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1]),
        )) {
            throw new TypeError('SelectionRect needs exactly four [lon, lat] corners of finite numbers');
        }
        let c = input.map(([lon, lat]) => [lon, lat] as LonLat); // defensive copy

        // 1. Winding: signed (shoelace) area in lon/lat. Positive = counter-clockwise = the grid
        // frame is right-handed. A negative ring is the same rectangle wound backwards — i.e. a
        // mirrored grid — repaired by swapping the two edge rows (reverse), which flips v only.
        let area = 0;
        for (let i = 0; i < 4; i++) {
            const [x0, y0] = c[i], [x1, y1] = c[(i + 1) % 4];
            area += x0 * y1 - x1 * y0;
        }
        if (area < 0) c = [c[3], c[2], c[1], c[0]];
        // area === 0 (degenerate) is left as given: unresolvable, and harmless downstream.

        // 2. Phase: cycle so corner[0] is the southernmost corner (west wins ties) — cyclic
        // rotation preserves the winding fixed above.
        let k = 0;
        for (let i = 1; i < 4; i++) {
            if (c[i][1] < c[k][1] || (c[i][1] === c[k][1] && c[i][0] < c[k][0])) k = i;
        }
        if (k) c = [...c.slice(k), ...c.slice(0, k)];

        return new SelectionRect(c);
    }

    get sw(): LonLat { return this.corners[0]; }
    get se(): LonLat { return this.corners[1]; }
    get ne(): LonLat { return this.corners[2]; }
    get nw(): LonLat { return this.corners[3]; }

    /** Real-world length of the SW→SE (south) edge, metres — the grid's column axis. */
    get widthMeters(): number { return haversine(this.sw, this.se); }
    /** Real-world length of the SW→NW (west) edge, metres — the grid's row axis. */
    get heightMeters(): number { return haversine(this.sw, this.nw); }

    /** Centre of the region (corner average — exact for the parallelogram selections we produce). */
    centroid(): LonLat {
        const lon = this.corners.reduce((s, c) => s + c[0], 0) / 4;
        const lat = this.corners.reduce((s, c) => s + c[1], 0) / 4;
        return [lon, lat];
    }

    /** The selection's rotation: angle (radians, CCW) from due east to the SW→SE edge — 0 for an
     *  axis-aligned selection. Lets direction-anchored features (e.g. a sun) stay geographically
     *  true on a rotated grid. */
    bearing(): number {
        const [lon0, lat0] = this.sw, [lon1, lat1] = this.se;
        const midLat = ((lat0 + lat1) / 2) * (Math.PI / 180);
        return Math.atan2(lat1 - lat0, (lon1 - lon0) * Math.cos(midLat));
    }

    /** Mutable copy of the canonical corners — for storage, URLs, and LonLat[]-taking pipeline calls. */
    toCorners(): LonLat[] {
        return this.corners.map(([lon, lat]) => [lon, lat] as LonLat);
    }

    /** JSON form = the corners array, so a persisted selection stays a plain LonLat[]. */
    toJSON(): LonLat[] { return this.toCorners(); }
}
