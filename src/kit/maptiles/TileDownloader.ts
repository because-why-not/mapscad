import type { RawRaster } from './TerrariumMapData';

/**
 * The I/O boundary of the height pipeline: fetches DEM tiles and composites them into one RGBA
 * raster. The per-tile fetch+decode is a first-class injectable port (`TileFetch`) — the browser
 * default uses `Image` + a canvas, a headless caller (tests, scripts) injects its own decoder —
 * while the compositing below is pure typed-array code that runs anywhere.
 */

/** One decoded tile: tightly-packed RGBA pixels. */
export interface TilePixels {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}

/** The port: fetch + decode one tile image, or null for a missing tile (→ no-data). */
export type TileFetch = (url: string, signal?: AbortSignal) => Promise<TilePixels | null>;

/** Hooks for a cancellable, progress-reporting download (one tick per tile fetched). */
export interface DownloadOptions {
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
    /** Fetch+decode one tile; defaults to the browser Image+canvas implementation. */
    fetchTile?: TileFetch;
}

/** The tile block to fetch, in tile indices at a given zoom. */
export interface TileRange {
    z: number;
    tileSize: number;
    tx0: number;
    tx1: number;
    ty0: number;
    ty1: number;
}

/** Fill a `{z}/{x}/{y}` template. */
export function tileUrl(template: string, z: number, x: number, y: number): string {
    return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

function loadTile(url: string, signal?: AbortSignal): Promise<HTMLImageElement | null> {
    return new Promise(resolve => {
        if (signal?.aborted) { resolve(null); return; }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const onAbort = () => { img.src = ''; resolve(null); }; // stop the in-flight request
        img.onload = () => { signal?.removeEventListener('abort', onAbort); resolve(img); };
        img.onerror = () => { signal?.removeEventListener('abort', onAbort); resolve(null); }; // missing tile -> no-data
        signal?.addEventListener('abort', onAbort, { once: true });
        img.src = url;
    });
}

/** The browser `TileFetch`: fetch via `Image`, decode via a throwaway canvas. Terrarium tiles are
 *  opaque, so reading the pixels back is exact (no premultiplied-alpha loss). */
const browserFetchTile: TileFetch = async (url, signal) => {
    const img = await loadTile(url, signal);
    if (!img) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data, width, height };
};

/** Copy a decoded tile into the composite at (dx, dy), clipped to the composite's bounds —
 *  the same result `ctx.drawImage` used to produce, without a canvas. */
function blit(dst: Uint8ClampedArray, dstW: number, dstH: number, tile: TilePixels, dx: number, dy: number): void {
    const copyW = Math.min(tile.width, dstW - dx);
    const copyH = Math.min(tile.height, dstH - dy);
    for (let row = 0; row < copyH; row++) {
        const src = tile.data.subarray(row * tile.width * 4, (row * tile.width + copyW) * 4);
        dst.set(src, ((dy + row) * dstW + dx) * 4);
    }
}

/** Download every tile in `range` and composite them into a single RGBA raster. */
export async function downloadRaster(
    template: string, range: TileRange, opts: DownloadOptions = {},
): Promise<RawRaster> {
    const { z, tileSize, tx0, tx1, ty0, ty1 } = range;
    const { signal, onProgress, fetchTile = browserFetchTile } = opts;

    const width = (tx1 - tx0 + 1) * tileSize;
    const height = (ty1 - ty0 + 1) * tileSize;
    const data = new Uint8ClampedArray(width * height * 4); // zeroed = alpha 0 = no-data

    const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
    let loaded = 0;
    onProgress?.(0, total);
    const jobs: Promise<void>[] = [];
    for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
            const url = tileUrl(template, z, tx, ty);
            jobs.push(fetchTile(url, signal).then(tile => {
                if (tile) blit(data, width, height, tile, (tx - tx0) * tileSize, (ty - ty0) * tileSize);
                onProgress?.(++loaded, total);
            }));
        }
    }
    await Promise.all(jobs);
    if (signal?.aborted) throw new DOMException('Sampling cancelled', 'AbortError');

    return {
        data, width, height,
        originX: tx0 * tileSize, originY: ty0 * tileSize, zoom: z, tileSize,
    };
}
