import { test, expect } from '@playwright/test';

// A minimal TileJSON manifest so the app boots without a reachable tile server. The app
// needs at least one tile provider and one elevation DEM (mmapsrv.type === 'elevation')
// or init() aborts before mounting. Tile image requests themselves are allowed to fail —
// that doesn't stop the UI from mounting.
const MANIFEST = {
    tileSize: 256,
    tileCrs: 'EPSG:3857',
    maps: [
        {
            name: 'street',
            attribution: '',
            tiles: ['http://localhost:8003/tiles/street/{z}/{x}/{y}.png'],
            minzoom: 0,
            maxzoom: 19,
            mmapsrv: { type: 'street', proxy: false, tileFormat: 'png' },
        },
        {
            name: 'dunedin_elevation_raw',
            attribution: '',
            tiles: ['http://localhost:8003/tiles/dem/{z}/{x}/{y}.png'],
            minzoom: 10,
            maxzoom: 16,
            mmapsrv: { type: 'elevation', proxy: false, tileFormat: 'png' },
        },
    ],
};

// Smoke test: with a stubbed manifest the bundle loads and Svelte mounts. Deliberately
// does not assert on real map/tile content.
test('app loads and mounts', async ({ page }) => {
    await page.route('**/maps', route =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(MANIFEST) }),
    );

    await page.goto('/');
    await expect(page).toHaveTitle('Map');
    // The map panel is always visible on load (the 3D preview is hidden until toggled on),
    // so its menu button is the reliable "Svelte mounted" signal.
    await expect(page.getByRole('button', { name: 'Open map menu' })).toBeVisible();
});
