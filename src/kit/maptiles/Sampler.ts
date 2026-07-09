import { lonLatToWorldPx, type LonLat } from '../common/mathHelper';
import type { TerrariumMapData } from './TerrariumMapData';

/**
 * Samples a height field over a (possibly rotated) selection rectangle into a grid. Pure:
 * it reads elevations from a TerrariumMapData and produces metre-space heights, with no
 * notion of where the pixels came from. Bilinear interpolation, no-data aware.
 */
export interface HeightGrid {
    heights: Float32Array;   // row-major, length cols*rows; metres
    cols: number;
    rows: number;
    widthMeters: number;     // real-world width of the rectangle (SW→SE edge, i.e. the south edge)
    heightMeters: number;    // real-world height of the rectangle (SW→NW edge, i.e. the west edge)
    minHeight: number;
    maxHeight: number;
    zoom: number;            // DEM tile zoom the heights were sampled from
    tilesX: number;          // DEM tiles fetched across / down (for memory accounting)
    tilesY: number;
    tileSize?: number;       // source pixels per tile edge (256, or 512 for Mapterhorn) — the
                             // tile counts above are only meaningful in bytes together with this
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Bilinear interpolation of a point inside the rectangle (u,v in [0,1]). Corners are ordered
 * SW, SE, NE, NW, so u runs west→east and v runs south→north (v=0 is the south edge, v=1 the north
 * edge). The TL/TR/BR/BL names below are the legacy screen-convention labels for those same corners.
 */
export function rectPoint(c: LonLat[], u: number, v: number): LonLat {
    const [TL, TR, BR, BL] = c; // = SW, SE, NE, NW
    const sLon = lerp(TL[0], TR[0], u), sLat = lerp(TL[1], TR[1], u); // south edge (v=0): SW→SE
    const nLon = lerp(BL[0], BR[0], u), nLat = lerp(BL[1], BR[1], u); // north edge (v=1): NW→NE
    return [lerp(sLon, nLon, v), lerp(sLat, nLat, v)];
}

/**
 * Walk a cols×rows grid over the rectangle, bilinear-sampling the DEM at each cell centre.
 * No-data corners are skipped in the blend so edges stay graceful; any cell with no valid
 * neighbour stays NaN so MapModel carves a hole there (no vertices over no-data).
 */
export function sampleHeights(
    corners: LonLat[], data: TerrariumMapData, cols: number, rows: number,
    widthMeters: number, heightMeters: number,
): HeightGrid {
    const z = data.zoom, tileSize = data.tileSize;
    const heights = new Float32Array(cols * rows);
    let minHeight = Infinity, maxHeight = -Infinity;

    for (let r = 0; r < rows; r++) {
        const v = (r + 0.5) / rows;
        for (let c = 0; c < cols; c++) {
            const u = (c + 0.5) / cols;
            const [lon, lat] = rectPoint(corners, u, v);
            const [gx, gy] = lonLatToWorldPx(lon, lat, z, tileSize);
            // Pixel centres sit at .5; sample the 4 pixels surrounding the sample point.
            const fx = gx - 0.5, fy = gy - 0.5;
            const x0 = Math.floor(fx), y0 = Math.floor(fy);
            const tx = fx - x0, ty = fy - y0;
            const h00 = data.heightAtPixel(x0, y0), h10 = data.heightAtPixel(x0 + 1, y0);
            const h01 = data.heightAtPixel(x0, y0 + 1), h11 = data.heightAtPixel(x0 + 1, y0 + 1);
            // Weighted blend, skipping any no-data corners (no per-cell allocation).
            let sum = 0, wsum = 0;
            if (!Number.isNaN(h00)) { const w = (1 - tx) * (1 - ty); sum += h00 * w; wsum += w; }
            if (!Number.isNaN(h10)) { const w = tx * (1 - ty); sum += h10 * w; wsum += w; }
            if (!Number.isNaN(h01)) { const w = (1 - tx) * ty; sum += h01 * w; wsum += w; }
            if (!Number.isNaN(h11)) { const w = tx * ty; sum += h11 * w; wsum += w; }
            const h = wsum > 0 ? sum / wsum : NaN;
            heights[r * cols + c] = h;
            if (!Number.isNaN(h)) {
                if (h < minHeight) minHeight = h;
                if (h > maxHeight) maxHeight = h;
            }
        }
    }

    // No-data cells are left as NaN (MapModel skips them, carving a hole). Only the reported
    // range collapses to 0 when the whole selection is no-data.
    if (!Number.isFinite(minHeight)) { minHeight = 0; maxHeight = 0; }

    return {
        heights, cols, rows, widthMeters, heightMeters, minHeight, maxHeight,
        zoom: z, tilesX: data.tilesX, tilesY: data.tilesY, tileSize,
    };
}
