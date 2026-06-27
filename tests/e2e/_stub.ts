import type { Page } from '@playwright/test';

// Shared offline stubs so interaction tests run hermetically (no real tile downloads).

// 1×1 transparent PNG — stands in for every tile (we never assert on tile content).
export const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64',
);

// A small but realistic manifest: a couple of base layers + one elevation DEM (the app
// aborts before mounting without ≥1 provider and ≥1 mmapsrv.type === 'elevation').
export const MANIFEST = {
    tileSize: 256,
    tileCrs: 'EPSG:3857',
    maps: [
        {
            name: 'street', attribution: '',
            tiles: ['http://localhost:8003/tiles/street/{z}/{x}/{y}.png'],
            minzoom: 0, maxzoom: 19,
            mmapsrv: { type: 'street', proxy: false, tileFormat: 'png' },
        },
        {
            name: 'opentopomap', attribution: '',
            tiles: ['http://localhost:8003/tiles/topo/{z}/{x}/{y}.png'],
            minzoom: 0, maxzoom: 17,
            mmapsrv: { type: 'topo', proxy: false, tileFormat: 'png' },
        },
        {
            name: 'dunedin_elevation_raw', attribution: '',
            tiles: ['http://localhost:8003/tiles/dem/{z}/{x}/{y}.png'],
            minzoom: 10, maxzoom: 16,
            mmapsrv: { type: 'elevation', proxy: false, tileFormat: 'png' },
        },
    ],
};

/** Stub the manifest and every tile request (local + external DEM hosts) so a test never
 *  touches the network. */
export async function stubServer(page: Page): Promise<void> {
    await page.route('**/maps', route =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(MANIFEST) }),
    );
    const blank = (type: string) => (route: import('@playwright/test').Route) =>
        route.fulfill({ contentType: type, body: BLANK_PNG });
    await page.route('**/tiles/**', blank('image/png'));
    await page.route('**/tiles.mapterhorn.com/**', blank('image/webp'));
    await page.route('**/elevation-tiles-prod/**', blank('image/png'));
}

/** Decode the export config from a URL's `c=` hash param (null if there's no selection). */
export function configFromUrl(url: string): any | null {
    const hash = new URL(url).hash.replace(/^#/, '');
    const c = new URLSearchParams(hash).get('c');
    if (!c) return null;
    return JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
}

/** Drag a box on the 2D map, in pixels measured from its centre. Drives the OL pointer
 *  interaction the selection tool listens on. */
export async function dragOnMap(
    page: Page, from: [number, number], to: [number, number],
): Promise<void> {
    const box = (await page.locator('#map-mount').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx + from[0], cy + from[1]);
    await page.mouse.down();
    await page.mouse.move(cx + to[0], cy + to[1], { steps: 8 });
    await page.mouse.up();
}
