import { describe, it, expect } from 'vitest';
import { MapModel } from '../../src/MapModel';
import type { HeightGrid } from '../../src/HeightSampler';

function makeGrid(): HeightGrid {
    return {
        heights: new Float32Array([0, 10, 0, 10]),
        cols: 2, rows: 2, widthMeters: 100, heightMeters: 100,
        minHeight: 0, maxHeight: 10, zoom: 14, tilesX: 1, tilesY: 1,
    };
}

/**
 * Bug repro (code review): applySettings() notifies and invalidates the geometry cache
 * unconditionally, even when the merged settings are identical. The export flow
 * (index.ts onPreviewSave/onPreviewSave3mf) does applySettings(currentUiSettings) and then
 * exportModelStl → model.buildGeometry(), so EVERY export re-runs the full build
 * synchronously on the main thread — the exact freeze the worker build was added to avoid —
 * and the notify() additionally kicks a redundant worker rebuild of the same geometry.
 *
 * Cache identity is the rebuild detector here: a cache hit returns the same object.
 * (An alternative fix — exporting the last worker-built geometry instead of calling
 * buildGeometry() — would make this test moot rather than green; revisit it then.)
 * When fixing, drop the `.fails` marker.
 */
describe('MapModel settings cache', () => {
    it.fails('re-applying identical settings neither notifies nor rebuilds', () => {
        const model = new MapModel({ socketEnabled: true, socketSize: 2 });
        model.setGrid(makeGrid());
        const first = model.buildGeometry();

        let notified = 0;
        model.onChange(() => notified++);
        model.applySettings(model.getSettings()); // a no-op merge — nothing changed

        expect(notified).toBe(0);                  // currently 1: unconditional notify()
        expect(model.buildGeometry()).toBe(first); // currently a fresh rebuild (cache dropped)
    });
});
