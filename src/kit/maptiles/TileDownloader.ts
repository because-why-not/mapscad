import type { RawRaster } from './TerrariumMapData';

/**
 * The I/O boundary: fetches DEM tiles over the network and composites them into one RGBA
 * raster. This is the only DOM/network-dependent piece of the height pipeline (Image +
 * canvas), so it's kept thin and separate from the pure decode/sample stages.
 */

/** Hooks for a cancellable, progress-reporting download (one tick per tile fetched). */
export interface DownloadOptions {
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
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

/** Download every tile in `range` and composite them into a single RGBA raster. */
export async function downloadRaster(
    template: string, range: TileRange, opts: DownloadOptions = {},
): Promise<RawRaster> {
    const { z, tileSize, tx0, tx1, ty0, ty1 } = range;
    const { signal, onProgress } = opts;

    const canvas = document.createElement('canvas');
    canvas.width = (tx1 - tx0 + 1) * tileSize;
    canvas.height = (ty1 - ty0 + 1) * tileSize;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
    let loaded = 0;
    onProgress?.(0, total);
    const jobs: Promise<void>[] = [];
    for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
            const url = tileUrl(template, z, tx, ty);
            jobs.push(loadTile(url, signal).then(img => {
                if (img) ctx.drawImage(img, (tx - tx0) * tileSize, (ty - ty0) * tileSize);
                onProgress?.(++loaded, total);
            }));
        }
    }
    await Promise.all(jobs);
    if (signal?.aborted) throw new DOMException('Sampling cancelled', 'AbortError');

    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return {
        data, width: canvas.width, height: canvas.height,
        originX: tx0 * tileSize, originY: ty0 * tileSize, zoom: z, tileSize,
    };
}
