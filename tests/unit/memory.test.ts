import { describe, it, expect } from 'vitest';
import { estimateMemory, measureMemory } from '../../src/kit/memory';

/**
 * Regression guard (from a code-review bug): memory.ts used to hardcode 256px tiles when
 * turning the fetched tile count into bytes, but tilesX/tilesY are counted in the DEM's OWN
 * tile size — Mapterhorn is 512px (see the tileSize gotcha in CLAUDE.md). One 512px tile
 * holds 4× the pixels of a 256px tile, so the DEM working set was under-reported 4× — both
 * in the stats overlay (measureMemory) and in the safeZoom budget gate (estimateMemory).
 * Both functions now take the source's tileSize (carried on HeightGrid by the sampler),
 * defaulting to 256 when absent.
 */
describe('memory accounting vs DEM tile size', () => {
    // What one composited 512px tile actually costs: the RGBA canvas readback.
    const TILE_512_BYTES = 512 * 512 * 4;

    it('baseline: 256px tiles are counted correctly', () => {
        const grid = { cols: 2, rows: 2, tilesX: 3, tilesY: 2, tileSize: 256 };
        const est = measureMemory({ vertexCount: 0, triangleCount: 0 }, grid);
        expect(est.tileBytes).toBe(3 * 2 * 256 * 256 * 4);
    });

    it('measureMemory: a 512px (Mapterhorn) tile costs 512·512·4 bytes, not 256·256·4', () => {
        const grid = { cols: 2, rows: 2, tilesX: 1, tilesY: 1, tileSize: 512 };
        const est = measureMemory({ vertexCount: 0, triangleCount: 0 }, grid);
        expect(est.tileBytes).toBe(TILE_512_BYTES);
    });

    it('estimateMemory: the pre-sampling budget gate must not under-count 512px tiles 4×', () => {
        const params = { cols: 2, rows: 2, tilesX: 3, tilesY: 2, tileSize: 512 };
        const est = estimateMemory(params);
        expect(est.tileBytes).toBe(3 * 2 * TILE_512_BYTES);
    });
});
