import type { HeightGrid } from '../maptiles/HeightSampler';
import type { OsmVectorData } from '../mapelements/OsmVectorData';
import type { OsmFeatureDef } from '../mapelements/osmFeatures';

/**
 * Rasterises one OSM feature into a `cols × rows` COVERAGE mask (0..1) by PAINTING its ways onto a
 * canvas and reading the red channel back. The mask aligns cell-for-cell with the sampled grid; the
 * geometry stage (`buildFeatureBody`) then drapes it onto the terrain as its own solid. Replaces the
 * identical Track/Street/Building canvas processors; the only difference between them is line-vs-area,
 * which `def.geometry` drives:
 *   - 'line'  → blurred white stroke, `radius` (metres) → brush width; coverage tapers off the
 *               centreline so a cell on the line reads ~1 and the shoulders less (→ smooth ramp).
 *   - 'area'  → solid white fill, crisp edges; every covered cell reads ~1 (→ vertical walls).
 *
 * Everything is painted in ONE draw call (one `stroke()` or one `fill()`): a canvas `filter`
 * allocates a full-canvas layer per draw, so per-way drawing over a dense network exhausts GPU
 * memory and crashes the shared WebGL context (the original track-processor OOM lesson). DOM-coupled
 * (needs a canvas), so it stays on the main thread — the mask it returns is a plain, serialisable
 * Float32Array that crosses to the build worker.
 */
export class OsmCanvasProcessor {
    readonly id: string;
    constructor(private data: OsmVectorData, private def: OsmFeatureDef, private radius: number) {
        this.id = `osm:${def.id}`;
    }

    /** Paint the feature's ways and return a `cols × rows` coverage mask (0..1), or null when there's
     *  nothing to paint (empty data, or a line with no width). */
    coverage(grid: HeightGrid): Float32Array | null {
        const { cols, rows, widthMeters, heightMeters } = grid;
        const isLine = this.def.geometry === 'line';
        if (this.data.isEmpty() || (isLine && this.radius <= 0)) return null;

        const canvas = document.createElement('canvas');
        canvas.width = cols;
        canvas.height = rows;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null; // no 2d context (very old/headless env) → no coverage

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
        const out = new Float32Array(cols * rows);
        for (let i = 0; i < out.length; i++) out[i] = image[i * 4] / 255; // red channel → 0..1
        return out;
    }
}
