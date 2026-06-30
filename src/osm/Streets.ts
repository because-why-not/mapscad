import type { Street } from './OverpassStreets';
import { projectLonLatLines, type GridSpace } from './gridProjection';

/**
 * Holds the streets downloaded for the current selection and turns them into the form the
 * model/processor consume, buffering it so the work happens at most once. Immutable (the streets
 * and the grid are fixed per instance), mirroring `Tracks`: a fresh download or a new grid is a
 * new `Streets` and cache invalidation is free.
 *
 * `grid` is optional so a `Streets` can exist just to feed the map overlay (`list`/`count`) before
 * a preview grid is known; the derived getter requires it.
 */
export class Streets {
    // Buffered derived form, computed lazily on first access (see the getter below).
    private gridBuffer: Street[] | null = null;

    constructor(private readonly streets: Street[] = [], private readonly grid?: GridSpace) {}

    /** The raw downloaded polylines (lon/lat), for the map overlay. */
    get list(): readonly Street[] { return this.streets; }
    get count(): number { return this.streets.length; }
    isEmpty(): boolean { return this.streets.length === 0; }

    /** A copy bound to a grid, so the overlay (gridless) and the preview (with a grid) can share
     *  one download: `streets.withGrid(grid).gridStreets`. */
    withGrid(grid: GridSpace): Streets {
        return new Streets(this.streets, grid);
    }

    /**
     * The same streets, but with each lon/lat vertex converted to fractional `[col, row]` in the
     * heightmap's sample space (see `projectLonLatLines`). Buffered: computed on first access only.
     */
    get gridStreets(): Street[] {
        if (this.gridBuffer) return this.gridBuffer;
        if (!this.grid) throw new Error('Streets.gridStreets needs a grid; construct with one or use withGrid()');
        this.gridBuffer = projectLonLatLines(this.streets, this.grid);
        return this.gridBuffer;
    }
}
