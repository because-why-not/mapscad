import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Golden-file regression test for the whole pipeline: download a small Dunedin area's DEM,
// sample → build mesh → export STL, and compare the bytes to a stored reference.
//
// The selection + settings are injected via the app's own share-link hash (#c=…), so boot
// restores the selection, samples the real DEM, and renders — exactly the user flow. We
// then click Save and capture the STL download.
//
// The area is intentionally tiny (~150 m square, sampled to a 128×128 grid at z17) so the
// download is a handful of tiles. Pin the zoom so the result is deterministic.
//
// Regenerate the reference after an intentional geometry change:
//     UPDATE_GOLDEN=1 npx playwright test dunedin-download

const CONFIG = {
    v: 1,
    demId: 'dunedin_elevation_raw',
    // [TL, TR, BR, BL] = NW, NE, SE, SW (lon, lat). ~150 m square near the DEM centre.
    selection: [
        [170.512533, -45.833427],
        [170.514467, -45.833427],
        [170.514467, -45.834774],
        [170.512533, -45.834774],
    ],
    model: { heightZoom: 17, resolutionLimit: 128, socketEnabled: true, socketSize: 5, heightScale: 1 },
};

const HASH = '#c=' + Buffer.from(JSON.stringify(CONFIG)).toString('base64url');
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
    await page.goto('/' + HASH);

    // The stats overlay only appears once the DEM has been sampled and the mesh built.
    await expect(page.getByText('Min / Max thickness')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Open 3D menu' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save' }).click();
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
