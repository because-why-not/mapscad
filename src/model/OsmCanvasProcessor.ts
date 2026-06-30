import type { HeightGrid } from '../HeightSampler';
import type { ElevationGridProcessor } from './processors';
import type { OsmVectorData } from '../osm/OsmVectorData';
import type { OsmFeatureDef } from '../osm/osmFeatures';
import { addRasterRaise } from './rasterRaise';

/**
 * Raises (or lowers) terrain over one OSM feature by PAINTING its ways onto a `cols × rows` canvas
 * and reading the coverage back. Replaces the identical Track/Street/Building canvas processors;
 * the only difference between them was line-vs-area, which `def.geometry` now drives:
 *   - 'line'  → blurred white stroke, `radius` (metres) → brush width; coverage tapers off the
 *               centreline so a cell on the line gets the full `raise` and the shoulders less.
 *   - 'area'  → solid white fill, crisp edges; every covered cell steps up by the full `raise`.
 * Coverage (red channel, 0..255 → 0..1) scales `raise` into a signed whole-metre delta via the
 * shared, unit-tested `addRasterRaise`; a NEGATIVE `raise` carves down.
 *
 * Everything is painted in ONE draw call (one `stroke()` or one `fill()`): a canvas `filter`
 * allocates a full-canvas layer per draw, so per-way drawing over a dense network exhausts GPU
 * memory and crashes the shared WebGL context (the original track-processor OOM lesson). DOM-coupled
 * (needs a canvas), so it lives outside the pure `processors.ts`.
 */
export class OsmCanvasProcessor implements ElevationGridProcessor {
    readonly id: string;
    constructor(private data: OsmVectorData, private def: OsmFeatureDef, private raise: number, private radius: number) {
        this.id = `osm:${def.id}`;
    }

    process(grid: HeightGrid): HeightGrid {
        const { cols, rows, heights, widthMeters, heightMeters } = grid;
        const isLine = this.def.geometry === 'line';
        if (this.raise === 0 || this.data.isEmpty() || (isLine && this.radius <= 0)) return grid;

        const canvas = document.createElement('canvas');
        canvas.width = cols;
        canvas.height = rows;
        const ctx = canvas.getContext('2d');
        if (!ctx) return grid; // no 2d context (very old/headless env) → leave heights untouched

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cols, rows);

        if (isLine) {
            // radius is metres; the canvas is in cell space. Cells are ~square, so use the mean
            // cell size to turn the brush radius into a stroke width in pixels (= cells).
            const cellMeters = (widthMeters / cols + heightMeters / rows) / 2;
            const radiusCells = this.radius / cellMeters;
            ctx.strokeStyle = '#fff';
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.lineWidth = Math.max(1, radiusCells);
            ctx.filter = `blur(${(radiusCells * 0.5).toFixed(2)}px)`;
        } else {
            ctx.fillStyle = '#fff';
        }

        // Accumulate EVERY way as a subpath of ONE path; one draw call (see the OOM lesson). Grid
        // ways are fractional sample indices; pixel centres sit at +0.5, so a vertex at sample c is
        // drawn at canvas x = c + 0.5 to land in the middle of cell c.
        ctx.beginPath();
        for (const line of this.data.gridWays) {
            if (line.length < this.def.minPoints) continue;
            ctx.moveTo(line[0][0] + 0.5, line[0][1] + 0.5);
            for (let i = 1; i < line.length; i++) ctx.lineTo(line[i][0] + 0.5, line[i][1] + 0.5);
            if (!isLine) ctx.closePath();
        }
        if (isLine) ctx.stroke(); else ctx.fill();

        const image = ctx.getImageData(0, 0, cols, rows).data;
        return { ...grid, heights: addRasterRaise(image, heights, this.raise) };
    }
}
