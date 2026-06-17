import type { ManifestMap } from './TileMapManifest';
import type { LonLat } from './SelectionArea';

/**
 * Samples a heightmap over a (possibly rotated) selection rectangle from a server's
 * terrarium-encoded DEM tiles. Sampling happens in the rectangle's local frame, so the
 * resulting grid IS the selected region — already clipped, with no notion of "outside".
 *
 * The grid resolution (cols × rows) is independent of any map zoom: it's whatever
 * detail the caller asks for, which is what lets the 3D preview / export be denser or
 * coarser than what's shown on screen.
 */
export interface HeightGrid {
    heights: Float32Array;   // row-major, length cols*rows; metres
    cols: number;
    rows: number;
    widthMeters: number;     // real-world width of the rectangle (TL→TR edge)
    heightMeters: number;    // real-world height of the rectangle (TL→BL edge)
    minHeight: number;
    maxHeight: number;
    zoom: number;            // DEM tile zoom the heights were sampled from
    tilesX: number;          // DEM tiles fetched across / down (for memory accounting)
    tilesY: number;
}

const TILE = 256;
const EARTH_CIRCUMFERENCE = 40075016.686;
const NO_DATA = Number.NaN;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function haversine([lon1, lat1]: LonLat, [lon2, lat2]: LonLat): number {
    const R = 6378137;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/** Lon/lat -> global pixel coordinate at a given zoom (Web Mercator, 256px tiles). */
function lonLatToWorldPx(lon: number, lat: number, z: number): [number, number] {
    const scale = TILE * Math.pow(2, z);
    const x = (lon + 180) / 360 * scale;
    const s = Math.sin(lat * Math.PI / 180);
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
    return [x, y];
}

/** Bilinear interpolation of a point inside the rectangle (u,v in [0,1]). */
function rectPoint(c: LonLat[], u: number, v: number): LonLat {
    const [TL, TR, BR, BL] = c;
    const topLon = lerp(TL[0], TR[0], u), topLat = lerp(TL[1], TR[1], u);
    const botLon = lerp(BL[0], BR[0], u), botLat = lerp(BL[1], BR[1], u);
    return [lerp(topLon, botLon, v), lerp(topLat, botLat, v)];
}

function loadTile(url: string): Promise<HTMLImageElement | null> {
    return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null); // missing tile -> treat as no-data
        img.src = url;
    });
}

/**
 * @param corners selection rectangle as lon/lat, order TL, TR, BR, BL
 * @param dem     terrarium DEM manifest entry (tiles[0] is the {z}/{x}/{y} template)
 * @param cols    number of samples across the width
 * @param rows    number of samples down the height
 */
/** Real-world width (TL→TR) and height (TL→BL) of the selection rectangle, in metres. */
export function rectExtent(corners: LonLat[]): { widthMeters: number; heightMeters: number } {
    return {
        widthMeters: haversine(corners[0], corners[1]),
        heightMeters: haversine(corners[0], corners[3]),
    };
}

export async function sampleSelectionHeights(
    corners: LonLat[], dem: ManifestMap, cols: number, rows: number,
): Promise<HeightGrid> {
    const { widthMeters, heightMeters } = rectExtent(corners);

    // Pick a tile zoom whose pixel size roughly matches the requested sample spacing,
    // clamped to what the server actually stores. Independent of the on-screen zoom.
    const lat0 = corners[0][1];
    const spacing = widthMeters / cols;
    const groundResAtZ0 = EARTH_CIRCUMFERENCE * Math.cos(lat0 * Math.PI / 180) / TILE;
    const minStored = dem.mmapsrv.minStoredZoom ?? dem.minzoom;
    const z = Math.max(minStored, Math.min(dem.maxzoom, Math.round(Math.log2(groundResAtZ0 / spacing))));

    // Pixel bbox of the rectangle at this zoom, then the covering tile range.
    const cornerPx = corners.map(c => lonLatToWorldPx(c[0], c[1], z));
    const minX = Math.min(...cornerPx.map(p => p[0]));
    const maxX = Math.max(...cornerPx.map(p => p[0]));
    const minY = Math.min(...cornerPx.map(p => p[1]));
    const maxY = Math.max(...cornerPx.map(p => p[1]));
    const tx0 = Math.floor(minX / TILE), tx1 = Math.floor(maxX / TILE);
    const ty0 = Math.floor(minY / TILE), ty1 = Math.floor(maxY / TILE);

    const canvas = document.createElement('canvas');
    canvas.width = (tx1 - tx0 + 1) * TILE;
    canvas.height = (ty1 - ty0 + 1) * TILE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    const jobs: Promise<void>[] = [];
    for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
            const url = dem.tiles[0]
                .replace('{z}', String(z)).replace('{x}', String(tx)).replace('{y}', String(ty));
            jobs.push(loadTile(url).then(img => {
                if (img) ctx.drawImage(img, (tx - tx0) * TILE, (ty - ty0) * TILE);
            }));
        }
    }
    await Promise.all(jobs);

    const originX = tx0 * TILE, originY = ty0 * TILE;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const heights = new Float32Array(cols * rows);
    let minHeight = Infinity, maxHeight = -Infinity;
    for (let r = 0; r < rows; r++) {
        const v = (r + 0.5) / rows;
        for (let c = 0; c < cols; c++) {
            const u = (c + 0.5) / cols;
            const [lon, lat] = rectPoint(corners, u, v);
            const [gx, gy] = lonLatToWorldPx(lon, lat, z);
            const px = Math.min(canvas.width - 1, Math.max(0, Math.round(gx - originX)));
            const py = Math.min(canvas.height - 1, Math.max(0, Math.round(gy - originY)));
            const i = (py * canvas.width + px) * 4;
            let h = NO_DATA;
            if (data[i + 3] !== 0) {                 // alpha 0 => no tile / no data
                h = data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768; // terrarium decode
            }
            heights[r * cols + c] = h;
            if (!Number.isNaN(h)) {
                if (h < minHeight) minHeight = h;
                if (h > maxHeight) maxHeight = h;
            }
        }
    }

    // Replace no-data with the lowest valid height so the mesh has a flat floor there.
    if (!Number.isFinite(minHeight)) { minHeight = 0; maxHeight = 0; }
    for (let i = 0; i < heights.length; i++) {
        if (Number.isNaN(heights[i])) heights[i] = minHeight;
    }

    return {
        heights, cols, rows, widthMeters, heightMeters, minHeight, maxHeight,
        zoom: z, tilesX: tx1 - tx0 + 1, tilesY: ty1 - ty0 + 1,
    };
}
