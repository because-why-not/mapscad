import type { HeightGrid } from '../HeightSampler';
import type { ElevationGridProcessor } from './processors';
import type { Tracks } from '../osm/Tracks';
import { addRasterRaise } from './rasterRaise';

/**
 * Raises (or lowers) terrain along OSM tracks by PAINTING them, instead of measuring per-cell
 * distance.
 *
 * Rather than measuring every cell's distance to every segment (a slow O(cells × segments)
 * distance field), this draws the tracks straight onto a `cols × rows` HTML canvas as blurred
 * white strokes and reads the result back: each pixel's coverage (red channel, 0..255 → 0..1)
 * scales `raise` into a signed height delta, rounded to whole metres, which is added to the
 * heightmap. So a cell on the centreline gets the full `raise`, the blurred shoulders taper it to
 * zero, and a NEGATIVE `raise` carves the terrain down instead. The canvas rasteriser does the
 * heavy lifting in native code, so cost scales with track length, not grid area.
 *
 * Consumes `tracks.gridTracks` — the polylines already projected into the heightmap's `[col, row]`
 * sample space — which is why `Tracks` exists and is handed to the processor. DOM-coupled (needs a
 * canvas), so it lives outside the pure `processors.ts`; the pixels→heights step is the pure,
 * unit-tested `addRasterRaise` (in `rasterRaise.ts`, shared with the building processor).
 */
export class TrackCanvasProcessor implements ElevationGridProcessor {
    readonly id = 'trackCanvas';
    constructor(private tracks: Tracks, private raise: number, private radius: number) {}

    process(grid: HeightGrid): HeightGrid {
        const { cols, rows, heights, widthMeters, heightMeters } = grid;
        if (this.raise === 0 || this.radius <= 0 || this.tracks.isEmpty()) return grid;

        // radius is metres; the canvas is in cell space. Cells are ~square, so use the mean
        // cell size to turn the brush radius into a stroke width in pixels (= cells).
        const cellMeters = (widthMeters / cols + heightMeters / rows) / 2;
        const radiusCells = this.radius / cellMeters;

        const canvas = document.createElement('canvas');
        canvas.width = cols;
        canvas.height = rows;
        const ctx = canvas.getContext('2d');
        if (!ctx) return grid; // no 2d context (very old/headless env) → leave heights untouched

        // Black = no change; white = full `raise`. A solid core (lineWidth) gives the saturated
        // centreline, the blur gives the soft falloff out to roughly the brush radius.
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cols, rows);
        ctx.strokeStyle = '#fff';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(1, radiusCells);
        ctx.filter = `blur(${(radiusCells * 0.5).toFixed(2)}px)`;

        // Accumulate EVERY track as a subpath of ONE path (begin once, stroke once). A canvas
        // `filter` allocates a full-canvas layer per draw call, so stroking per-track (thousands
        // of ways) piles up thousands of GPU blur buffers and exhausts host memory — which crashes
        // the shared GPU process and takes the preview's WebGL context down with it. One stroke =
        // one blur pass; overlapping tracks also blur as a union instead of double-compositing.
        ctx.beginPath();
        for (const line of this.tracks.gridTracks) {
            if (line.length < 2) continue;
            // gridTracks are fractional sample indices; pixel centres sit at +0.5, so a point at
            // sample c is drawn at canvas x = c + 0.5 to land in the middle of cell c. moveTo
            // starts a fresh subpath, so the tracks stay disjoint within the single path.
            ctx.moveTo(line[0][0] + 0.5, line[0][1] + 0.5);
            for (let i = 1; i < line.length; i++) ctx.lineTo(line[i][0] + 0.5, line[i][1] + 0.5);
        }
        ctx.stroke();

        const image = ctx.getImageData(0, 0, cols, rows).data;
        return { ...grid, heights: addRasterRaise(image, heights, this.raise) };
    }
}
