import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM (package.json "type": "module") has no `__dirname`; derive it from the module URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Golden-file regression test for the whole pipeline: download a small Dunedin area's DEM,
// sample → build mesh → export STL, and compare the bytes to a stored reference.
//
// The selection + settings are seeded into localStorage (the app's own persistence key), so
// boot restores the selection, samples the real DEM, and renders — exactly the user flow. We
// then click Save and capture the STL download.
//
// The area is intentionally tiny (~150 m square) so the download is a handful of tiles. The DEM
// zoom is seeded as 17, but boot caps a saved heightZoom to the resolution-based default — for this
// area at raster 128 that's z16, which is what actually gets sampled — and bilinearly fills the
// model's raster grid. The app forces the raster resolution on load, so we pin it to 128 via the
// `rasterResolution` override (seeded into localStorage below) to keep the golden mesh small.
//
// The HEADLESS twin of this test (tests/unit/dunedinGolden.test.ts) runs the same pipeline in Node
// against checked-in tile fixtures and compares to the SAME golden — keep their configs in sync.
//
// Regenerate the reference after an intentional geometry change:
//     UPDATE_GOLDEN=1 npx playwright test dunedin-download
// …and refresh the unit test's tile fixtures alongside it:
//     UPDATE_TILES=1 npx vitest run dunedinGolden

const RASTER = 128;

const CONFIG = {
    version: 1,
    demId: 'dunedin_elevation_raw',
    // [TL, TR, BR, BL] = NW, NE, SE, SW (lon, lat). ~150 m square near the DEM centre.
    selection: [
        [170.512533, -45.833427],
        [170.514467, -45.833427],
        [170.514467, -45.834774],
        [170.512533, -45.834774],
    ],
    model: { heightZoom: 17, rasterResolution: RASTER, socketEnabled: true, socketSize: 5, heightScale: 1 },
    display: { smoothShading: true },
};

const GOLDEN = path.join(__dirname, 'fixtures', 'dunedin-128.stl');

// Binary STL → triangle count + the flat array of all floats (normals + vertices).
function parseStl(buf: Buffer): { triCount: number; floats: Float32Array } {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const triCount = dv.getUint32(80, true);
    const floats = new Float32Array(triCount * 12);
    let off = 84;
    for (let t = 0; t < triCount; t++) {
        for (let f = 0; f < 12; f++) { floats[t * 12 + f] = dv.getFloat32(off, true); off += 4; }
        off += 2; // attribute byte count
    }
    return { triCount, floats };
}

test('downloads a small Dunedin area and matches the stored STL', async ({ page }) => {
    // Seed the saved config before the app boots, so it restores exactly this selection + settings.
    // Also pin the raster resolution (Env reads this override at load) so the mesh stays small.
    await page.addInitScript(({ cfg, raster }) => {
        localStorage.setItem('previewConfig', JSON.stringify(cfg));
        localStorage.setItem('rasterResolution', String(raster));
    }, { cfg: CONFIG, raster: RASTER });
    await page.goto('/');

    // The stats overlay only appears once the DEM has been sampled and the mesh built.
    await expect(page.getByText('Min / Max thickness')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Open 3D menu' }).click();

    // Guard against a silent DEM fallback. `dunedin_elevation_raw` lives only on the tile server;
    // without it the app quietly falls back to a public DEM (Mapterhorn), which still yields real
    // terrain differing by only ~0.5 m — enough to fail the byte compare below for a baffling
    // reason. Assert the intended source is actually the one selected in the UI.
    await expect(page.getByLabel('Source').locator('option:checked')).toHaveText('Dunedin');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save STL' }).click();
    const download = await downloadPromise;

    const chunks: Buffer[] = [];
    for await (const c of await download.createReadStream()) chunks.push(c as Buffer);
    const bytes = Buffer.concat(chunks);

    if (process.env.UPDATE_GOLDEN) {
        fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
        fs.writeFileSync(GOLDEN, bytes);
        test.info().annotations.push({ type: 'golden', description: `wrote ${bytes.length} bytes` });
        return;
    }

    expect(fs.existsSync(GOLDEN), 'golden STL missing — run with UPDATE_GOLDEN=1 once').toBeTruthy();
    const golden = parseStl(fs.readFileSync(GOLDEN));
    const got = parseStl(bytes);

    // Same triangle count, and every coordinate within a tight tolerance. The tolerance
    // absorbs last-bit float / canvas-decode noise while still catching real geometry
    // regressions (which move vertices by metres, not microns).
    expect(got.triCount).toBe(golden.triCount);
    let maxDiff = 0;
    for (let i = 0; i < golden.floats.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(got.floats[i] - golden.floats[i]));
    }
    expect(maxDiff).toBeLessThan(1e-2);
});
