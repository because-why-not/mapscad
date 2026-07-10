// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas, loadImage } from 'canvas';
import { sampleSelectionHeights, resolutionZoomRange, gridResolution } from '../../src/kit/maptiles/HeightSampler';
import type { TileFetch } from '../../src/kit/maptiles/TileDownloader';
import type { ManifestMap } from '../../src/kit/maptiles/TileMapManifest';
import { MapModel } from '../../src/kit/MapModel';
import { modelToStlBytes } from '../../src/kit/StlMaker';
import { TEST_AREA } from '../testArea';

/**
 * The dunedin golden test, HEADLESS: the same pipeline the e2e drives through the browser —
 * selection → zoom fit → tile decode → composite → bilinear sample → build → STL bytes — run
 * entirely in Node against the SAME golden file (`tests/e2e/fixtures/dunedin-128.stl`). One
 * golden, two harnesses: the e2e proves the app wiring, this proves the kit runs headless and
 * is hermetic (the DEM tiles are checked-in fixtures; no tile server needed).
 *
 * Fixtures (tests/unit/fixtures/dunedin/): the covered DEM tiles as PNGs + `meta.json` recording
 * the real manifest values (tile size, zoom bounds). Regenerate them from the live tile server
 * (requires .env, like the e2e) after the area/settings change:
 *     UPDATE_TILES=1 npx vitest run dunedinGolden
 * The golden STL itself is owned by the e2e (UPDATE_GOLDEN=1) — this test never writes it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'dunedin');
const META = path.join(FIXTURES, 'meta.json');
const GOLDEN = path.join(HERE, '..', 'e2e', 'fixtures', 'dunedin-128.stl');

// Mirrors the e2e's seeded config (dunedin-download.spec.ts) — keep the two in sync. The area is
// tests/testArea.ts, SHARED with the scenario walkthrough, in canonical SW,SE,NE,NW corner order.
const RASTER = 128;
const SELECTION = TEST_AREA;
const MODEL_SETTINGS = { heightZoom: 17, rasterResolution: RASTER, socketEnabled: true, socketSize: 5, heightScale: 1 };

/** Decode PNG bytes/file to RGBA via node-canvas (the Node stand-in for the browser decode). */
async function decodePng(src: string | Buffer) {
    const img = await loadImage(src);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
    return { data, width, height };
}

/** Normal mode: serve tiles from the checked-in fixtures; a missing file fails loudly. */
const fixtureFetch: TileFetch = async (url) => {
    const file = path.join(FIXTURES, url);
    if (!fs.existsSync(file)) {
        throw new Error(`Missing tile fixture ${url} — regenerate with UPDATE_TILES=1 (needs the tile server / .env)`);
    }
    return decodePng(file);
};

/** UPDATE_TILES mode: fetch each tile the pipeline asks for from the real server, saving it as a
 *  fixture on the way through — so the fixture set is exactly the coverage, never hand-computed. */
function recordingFetch(): TileFetch {
    return async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Tile fetch failed: HTTP ${res.status} for ${url}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const name = url.split('/').slice(-3).join('-'); // …/{z}/{x}/{y}.png → z-x-y.png
        fs.mkdirSync(FIXTURES, { recursive: true });
        fs.writeFileSync(path.join(FIXTURES, name), buf);
        return decodePng(buf);
    };
}

/** The DEM manifest entry: recorded real values (meta.json), tiles template per mode. */
async function loadDem(update: boolean): Promise<{ dem: ManifestMap; fetchTile: TileFetch }> {
    if (!update) {
        expect(fs.existsSync(META), 'meta.json fixture missing — run once with UPDATE_TILES=1').toBeTruthy();
        const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
        const dem = {
            name: meta.name, tiles: ['{z}-{x}-{y}.png'], minzoom: meta.minzoom, maxzoom: meta.maxzoom,
            mmapsrv: { type: 'elevation', tileSize: meta.tileSize, minStoredZoom: meta.minStoredZoom },
        } as ManifestMap;
        return { dem, fetchTile: fixtureFetch };
    }
    // Refresh mode: read the REAL manifest entry (so tileSize/zoom bounds can never drift from the
    // server) and record it into meta.json alongside the tiles.
    const { default: dotenv } = await import('dotenv');
    dotenv.config({ path: path.join(HERE, '..', '..', '.env'), quiet: true });
    const server = process.env.LOCAL_TILE_SERVER_URL || process.env.TILE_SERVER_URL;
    expect(server, 'UPDATE_TILES needs the tile server URL in .env').toBeTruthy();
    const manifest: ManifestMap[] = (await (await fetch(`${server}/maps`)).json()).maps ?? [];
    const dem = manifest.find(m => m.name === 'dunedin_elevation_raw');
    expect(dem, 'dunedin_elevation_raw not in the server manifest').toBeTruthy();
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(META, JSON.stringify({
        name: dem!.name,
        attribution: dem!.attribution, // LINZ CC BY 4.0 — the tiles below derive from this source
        minzoom: dem!.minzoom, maxzoom: dem!.maxzoom,
        tileSize: dem!.mmapsrv.tileSize, minStoredZoom: dem!.mmapsrv.minStoredZoom,
    }, null, 1));
    return { dem: dem!, fetchTile: recordingFetch() };
}

// Binary STL → triangle count + the flat array of all floats (normals + vertices).
// (Same parser as the e2e spec — duplicated because vitest must not import @playwright/test.)
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

describe('dunedin golden, headless', () => {
    it('samples the fixture DEM and matches the e2e golden STL', async () => {
        const { dem, fetchTile } = await loadDem(!!process.env.UPDATE_TILES);

        // The zoom the app really samples at: the boot cap (index.ts) limits the saved heightZoom
        // to the resolution-based default — NOT the saved 17 (the mesh can't use finer detail).
        const zr = resolutionZoomRange(SELECTION, dem, RASTER);
        const heightZoom = Math.min(MODEL_SETTINGS.heightZoom, zr.def);
        const { cols, rows } = gridResolution(SELECTION, RASTER);

        const grid = await sampleSelectionHeights(SELECTION, dem, cols, rows, heightZoom, { fetchTile });
        expect(grid.cols).toBe(cols);
        expect(Number.isNaN(grid.minHeight)).toBe(false); // real terrain, not a no-data fallback

        const model = new MapModel();
        model.applySettings({ ...MODEL_SETTINGS, heightZoom });
        model.setGrid(grid);
        const bytes = modelToStlBytes(model);
        expect(bytes).not.toBeNull();

        expect(fs.existsSync(GOLDEN), 'golden STL missing — run the e2e once with UPDATE_GOLDEN=1').toBeTruthy();
        const golden = parseStl(fs.readFileSync(GOLDEN));
        const got = parseStl(Buffer.from(bytes!));

        // Same triangle count, every coordinate within the e2e's tolerance (absorbs decoder noise;
        // real geometry regressions move vertices by metres, not microns).
        expect(got.triCount).toBe(golden.triCount);
        let maxDiff = 0;
        for (let i = 0; i < golden.floats.length; i++) {
            maxDiff = Math.max(maxDiff, Math.abs(got.floats[i] - golden.floats[i]));
        }
        expect(maxDiff).toBeLessThan(1e-2);
    });
});
