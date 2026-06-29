import type { Building } from './OverpassBuildings';
import { projectLonLatLines, type GridSpace } from './gridProjection';

/**
 * Holds the building footprints downloaded for the current selection and turns them into the form
 * the processor consumes, buffering it so the work happens at most once. Immutable (the buildings
 * and the grid are fixed per instance), mirroring `Tracks`: a fresh download or a new grid is a
 * new `Buildings` and cache invalidation is free.
 *
 * `grid` is optional so a `Buildings` can exist just to feed the map overlay (`list`/`count`)
 * before a preview grid is known; the derived getter requires it.
 */
export class Buildings {
    // Buffered derived form, computed lazily on first access (see the getter below).
    private gridBuffer: Building[] | null = null;

    constructor(private readonly buildings: Building[] = [], private readonly grid?: GridSpace) {}

    /** The raw downloaded rings (lon/lat), for the map overlay. */
    get list(): readonly Building[] { return this.buildings; }
    get count(): number { return this.buildings.length; }
    isEmpty(): boolean { return this.buildings.length === 0; }

    /** A copy bound to a grid, so the overlay (gridless) and the preview (with a grid) can share
     *  one download: `buildings.withGrid(grid).gridBuildings`. */
    withGrid(grid: GridSpace): Buildings {
        return new Buildings(this.buildings, grid);
    }

    /**
     * The same footprints, but with each lon/lat vertex converted to fractional `[col, row]` in the
     * heightmap's sample space (see `projectLonLatLines`). Buffered: computed on first access only.
     */
    get gridBuildings(): Building[] {
        if (this.gridBuffer) return this.gridBuffer;
        if (!this.grid) throw new Error('Buildings.gridBuildings needs a grid; construct with one or use withGrid()');
        this.gridBuffer = projectLonLatLines(this.buildings, this.grid);
        return this.gridBuffer;
    }
}
