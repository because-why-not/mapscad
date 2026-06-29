import type { LonLat } from '../SelectionArea';
import type { Track } from './OverpassTracks';

/** The sampled grid the tracks are projected against — the selection corners plus the heightmap
 *  resolution and metre extents (everything the row-col conversion needs). */
export interface TrackGrid {
    corners: LonLat[];
    cols: number;
    rows: number;
    widthMeters: number;
    heightMeters: number;
}

/**
 * Holds the walking tracks downloaded for the current selection and turns them into the forms the
 * model/processor consume, buffering each so the work happens at most once. Immutable: the tracks
 * and the grid are fixed for an instance, so a fresh download or a new grid is a new `Tracks` and
 * cache invalidation is free (a new instance starts with empty buffers).
 *
 * `grid` is optional so a `Tracks` can exist just to feed the map overlay (`list`/`count`) before a
 * preview grid is known; the derived getters require it.
 */
export class Tracks {
    // Buffered derived form, computed lazily on first access (see the getter below).
    private gridTrackBuffer: Track[] | null = null;

    constructor(private readonly tracks: Track[] = [], private readonly grid?: TrackGrid) {}

    /** The raw downloaded polylines (lon/lat), for the map overlay. */
    get list(): readonly Track[] { return this.tracks; }
    get count(): number { return this.tracks.length; }
    isEmpty(): boolean { return this.tracks.length === 0; }

    /** A copy of this track set bound to a grid, so the overlay (gridless) and the preview (with a
     *  grid) can share one download: `tracks.withGrid(grid).gridTracks`. */
    withGrid(grid: TrackGrid): Tracks {
        return new Tracks(this.tracks, grid);
    }

    /**
     * The same tracks, but with each lon/lat vertex converted to fractional `[col, row]` in the
     * heightmap's sample space (heightmap samples sit at `(c+0.5)/cols`, `(r+0.5)/rows`, so the
     * inverse is `u·cols − 0.5` / `v·rows − 0.5`). Buffered: computed on first access only.
     */
    get gridTracks(): Track[] {
        if (this.gridTrackBuffer) return this.gridTrackBuffer;
        this.gridTrackBuffer = this.toGridSpace(this.requireGrid('gridTracks'));
        return this.gridTrackBuffer;
    }

    /** Project every track vertex from lon/lat onto the heightmap's fractional [col, row] grid,
     *  using the affine corner basis (TL origin, eU→TR, eV→BL). */
    private toGridSpace(g: TrackGrid): Track[] {
        const [TL, TR, , BL] = g.corners;
        const eUx = TR[0] - TL[0], eUy = TR[1] - TL[1];
        const eVx = BL[0] - TL[0], eVy = BL[1] - TL[1];
        const det = eUx * eVy - eUy * eVx;
        if (!det) return this.tracks.map(() => []);
        return this.tracks.map(line => line.map(([lon, lat]) => {
            const dx = lon - TL[0], dy = lat - TL[1];
            const u = (dx * eVy - dy * eVx) / det;
            const v = (eUx * dy - eUy * dx) / det;
            return [u * g.cols - 0.5, v * g.rows - 0.5] as LonLat; // [col, row], parallel to [lon, lat]
        }));
    }

    private requireGrid(who: string): TrackGrid {
        if (!this.grid) throw new Error(`Tracks.${who} needs a grid; construct with one or use withGrid()`);
        return this.grid;
    }
}
