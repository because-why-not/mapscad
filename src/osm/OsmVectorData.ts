import type { OsmWay } from './OverpassFeature';
import { projectLonLatLines, type GridSpace } from './gridProjection';

/**
 * Holds the ways downloaded for one OSM feature and projects them into the heightmap's grid space,
 * buffering the result so the work happens at most once. Immutable (ways + grid fixed per instance):
 * a fresh download or a new grid is a new `OsmVectorData` and cache invalidation is free. Replaces
 * the identical Tracks/Streets/Buildings holders.
 *
 * `grid` is optional so an instance can feed the map overlay (`list`/`count`) before a preview grid
 * is known; the derived getter requires it.
 */
export class OsmVectorData {
    private gridBuffer: OsmWay[] | null = null;

    constructor(private readonly ways: OsmWay[] = [], private readonly grid?: GridSpace) {}

    /** The raw downloaded ways (lon/lat), for the map overlay. */
    get list(): readonly OsmWay[] { return this.ways; }
    get count(): number { return this.ways.length; }
    isEmpty(): boolean { return this.ways.length === 0; }

    /** A copy bound to a grid, so the overlay (gridless) and the preview (with a grid) can share
     *  one download: `data.withGrid(grid).gridWays`. */
    withGrid(grid: GridSpace): OsmVectorData {
        return new OsmVectorData(this.ways, grid);
    }

    /**
     * The same ways, each lon/lat vertex converted to fractional `[col, row]` in the heightmap's
     * sample space (see `projectLonLatLines`). Buffered: computed on first access only.
     */
    get gridWays(): OsmWay[] {
        if (this.gridBuffer) return this.gridBuffer;
        if (!this.grid) throw new Error('OsmVectorData.gridWays needs a grid; construct with one or use withGrid()');
        this.gridBuffer = projectLonLatLines(this.ways, this.grid);
        return this.gridBuffer;
    }
}
