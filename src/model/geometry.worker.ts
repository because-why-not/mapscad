import { buildModelGeometry, type BuildInput } from './buildGeometry';

/**
 * Off-main-thread model build. Receives an (already OSM-raised) HeightGrid + ModelSettings, runs the
 * shared pure pipeline (`buildModelGeometry` — the exact same code MapModel uses synchronously), and
 * posts back the neutral geometry, transferring the tile buffers so the main thread gets them without
 * a copy. Progress is streamed so index.ts can drive the shared (cancellable) progress bar; cancel is
 * a `worker.terminate()` from the main thread, so the worker itself needs no abort handling.
 */

const ctx = self as unknown as Worker;

interface BuildRequest extends BuildInput { id: number; }

ctx.onmessage = (e: MessageEvent<BuildRequest>) => {
    const { id, grid, settings } = e.data;
    try {
        const geo = buildModelGeometry({ grid, settings }, {
            onProgress: (fraction) => ctx.postMessage({ type: 'progress', id, fraction }),
        });
        // Transfer the tile buffers (positions + indices) back — they're freshly built here, so the
        // worker has no further use for them.
        const transfer: ArrayBuffer[] = [];
        for (const t of geo.tiles) transfer.push(t.positions.buffer as ArrayBuffer, t.indices.buffer as ArrayBuffer);
        ctx.postMessage({ type: 'done', id, geo }, transfer);
    } catch (err) {
        ctx.postMessage({ type: 'error', id, message: String((err as Error)?.message ?? err) });
    }
};
