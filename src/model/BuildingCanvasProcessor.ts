import type { HeightGrid } from '../HeightSampler';
import type { ElevationGridProcessor } from './processors';
import type { Buildings } from '../osm/Buildings';
import { addRasterRaise } from './rasterRaise';

/**
 * Raises (or lowers) terrain over OSM building footprints by PAINTING them onto a `cols × rows`
 * canvas — the polygon counterpart of `TrackCanvasProcessor`. Each footprint is filled solid white
 * on a black background; the coverage raster (red channel, 0..255 → 0..1) then scales `raise` into
 * a signed whole-metre delta added to the heightmap, so the whole footprint steps up by `raise`
 * (or down, when `raise` is negative). No blur — buildings have crisp edges, unlike track shoulders.
 *
 * All footprints fill in ONE `fill()` call: a canvas with a `filter` allocates a layer per draw,
 * and even without a filter, batching keeps a dense city to a single rasterisation pass (see the
 * track-processor OOM lesson). Consumes `buildings.gridBuildings` — rings already projected into
 * the heightmap's `[col, row]` sample space. DOM-coupled (needs a canvas), so it lives outside the
 * pure `processors.ts`; the pixels→heights step is the shared, unit-tested `addRasterRaise`.
 */
export class BuildingCanvasProcessor implements ElevationGridProcessor {
    readonly id = 'buildingCanvas';
    constructor(private buildings: Buildings, private raise: number) {}

    process(grid: HeightGrid): HeightGrid {
        const { cols, rows, heights } = grid;
        if (this.raise === 0 || this.buildings.isEmpty()) return grid;

        const canvas = document.createElement('canvas');
        canvas.width = cols;
        canvas.height = rows;
        const ctx = canvas.getContext('2d');
        if (!ctx) return grid; // no 2d context (very old/headless env) → leave heights untouched

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cols, rows);
        ctx.fillStyle = '#fff';

        // Accumulate every footprint as a closed subpath of ONE path and fill once.
        ctx.beginPath();
        for (const ring of this.buildings.gridBuildings) {
            if (ring.length < 3) continue;
            // gridBuildings are fractional sample indices; pixel centres sit at +0.5, so a vertex
            // at sample c is drawn at canvas x = c + 0.5 to land in the middle of cell c.
            ctx.moveTo(ring[0][0] + 0.5, ring[0][1] + 0.5);
            for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0] + 0.5, ring[i][1] + 0.5);
            ctx.closePath();
        }
        ctx.fill();

        const image = ctx.getImageData(0, 0, cols, rows).data;
        return { ...grid, heights: addRasterRaise(image, heights, this.raise) };
    }
}
