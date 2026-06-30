import type { HeightGrid } from '../HeightSampler';
import type { ElevationGridProcessor } from './processors';
import type { Streets } from '../osm/Streets';
import { addRasterRaise } from './rasterRaise';

/**
 * Raises (or lowers) terrain along OSM streets by PAINTING them onto a `cols × rows` canvas — the
 * road counterpart of `TrackCanvasProcessor`, identical technique (blurred white strokes whose
 * coverage scales `raise` into a signed whole-metre delta) on a different feature set. A wider
 * brush than tracks suits roads, but that's the caller's `radius`; the code is the same.
 *
 * All streets stroke in ONE `stroke()` call: a canvas `filter` allocates a full-canvas layer per
 * draw, so per-street stroking over a dense network exhausts GPU memory and crashes the shared
 * WebGL context (see the track-processor OOM lesson). Consumes `streets.gridStreets` — polylines
 * already projected into the heightmap's `[col, row]` sample space. DOM-coupled (needs a canvas),
 * so it lives outside the pure `processors.ts`; the pixels→heights step is the shared, unit-tested
 * `addRasterRaise`.
 */
export class StreetCanvasProcessor implements ElevationGridProcessor {
    readonly id = 'streetCanvas';
    constructor(private streets: Streets, private raise: number, private radius: number) {}

    process(grid: HeightGrid): HeightGrid {
        const { cols, rows, heights, widthMeters, heightMeters } = grid;
        if (this.raise === 0 || this.radius <= 0 || this.streets.isEmpty()) return grid;

        // radius is metres; the canvas is in cell space. Cells are ~square, so use the mean
        // cell size to turn the brush radius into a stroke width in pixels (= cells).
        const cellMeters = (widthMeters / cols + heightMeters / rows) / 2;
        const radiusCells = this.radius / cellMeters;

        const canvas = document.createElement('canvas');
        canvas.width = cols;
        canvas.height = rows;
        const ctx = canvas.getContext('2d');
        if (!ctx) return grid; // no 2d context (very old/headless env) → leave heights untouched

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cols, rows);
        ctx.strokeStyle = '#fff';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(1, radiusCells);
        ctx.filter = `blur(${(radiusCells * 0.5).toFixed(2)}px)`;

        // Accumulate EVERY street as a subpath of ONE path (begin once, stroke once) — see the
        // OOM lesson in TrackCanvasProcessor.
        ctx.beginPath();
        for (const line of this.streets.gridStreets) {
            if (line.length < 2) continue;
            // gridStreets are fractional sample indices; pixel centres sit at +0.5, so a point at
            // sample c is drawn at canvas x = c + 0.5 to land in the middle of cell c.
            ctx.moveTo(line[0][0] + 0.5, line[0][1] + 0.5);
            for (let i = 1; i < line.length; i++) ctx.lineTo(line[i][0] + 0.5, line[i][1] + 0.5);
        }
        ctx.stroke();

        const image = ctx.getImageData(0, 0, cols, rows).data;
        return { ...grid, heights: addRasterRaise(image, heights, this.raise) };
    }
}
