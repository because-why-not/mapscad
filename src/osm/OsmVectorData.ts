import type { LonLat } from '../SelectionArea';
import type { OsmElement } from './OverpassFeature';
import { projectLonLatLines, type GridSpace } from './gridProjection';

/**
 * Holds the elements downloaded for one OSM feature and projects their geometry into the heightmap's
 * grid space, buffering the result so the work happens at most once. Immutable (elements + grid fixed
 * per instance): a fresh download, an edit (delete), or a new grid is a new `OsmVectorData` and cache
 * invalidation is free.
 *
 * `list` carries the full elements (id + name + coords) for the overlay and the object list; the
 * processor only needs geometry, exposed as `gridWays` (projected `[col,row]` polylines). `grid` is
 * optional so an instance can feed the overlay before a preview grid is known.
 */
export class OsmVectorData {
    private gridBuffer: LonLat[][] | null = null;

    constructor(private readonly elements: OsmElement[] = [], private readonly grid?: GridSpace) {}

    /** The full elements (id/name/coords), for the map overlay and the object list. */
    get list(): readonly OsmElement[] { return this.elements; }
    get count(): number { return this.elements.length; }
    isEmpty(): boolean { return this.elements.length === 0; }

    /** A copy bound to a grid, so the overlay (gridless) and the preview (with a grid) can share one
     *  download: `data.withGrid(grid).gridWays`. */
    withGrid(grid: GridSpace): OsmVectorData {
        return new OsmVectorData(this.elements, grid);
    }

    /**
     * Each element's geometry projected to fractional `[col, row]` in the heightmap's sample space
     * (see `projectLonLatLines`) — the only thing the canvas processor needs. Buffered.
     */
    get gridWays(): LonLat[][] {
        if (this.gridBuffer) return this.gridBuffer;
        if (!this.grid) throw new Error('OsmVectorData.gridWays needs a grid; construct with one or use withGrid()');
        this.gridBuffer = projectLonLatLines(this.elements.map(e => e.coords), this.grid);
        return this.gridBuffer;
    }
}
