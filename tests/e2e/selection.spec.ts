import { test, expect } from '@playwright/test';
import { stubServer, dragOnMap, configFromUrl, haversineMeters } from './_stub';

// Exercises the selection mechanisms themselves — drawing a rectangle, drawing an oval, and
// moving an existing selection — WITHOUT any real download (tiles are stubbed blank). We
// assert on the selected area the app exposes in the readable URL hash (sel/shape), not geometry.

// Wait until the OpenLayers map (and thus the selection tool created in its onReady) exists.
async function waitForMap(page: import('@playwright/test').Page): Promise<void> {
    await expect(page.getByRole('button', { name: 'Selection' })).toBeVisible();
    await expect(page.locator('#map-mount canvas')).toBeVisible();
}

test('the rectangle tool creates a four-corner selection', async ({ page }) => {
    await stubServer(page);
    await page.goto('/');
    await waitForMap(page);

    await page.getByRole('button', { name: 'Select rectangular area' }).click();
    await dragOnMap(page, [-60, -40], [60, 40]);

    // A selection makes the 3D preview appear and adds the readable sel/shape to the URL.
    await expect(page.getByRole('button', { name: 'Open 3D menu' })).toBeVisible();
    await expect.poll(() => page.url()).toContain('sel=');

    const cfg = configFromUrl(page.url())!;
    expect(cfg.selection).toHaveLength(4);
    expect(cfg.shape).toBe('rectangle');
});

test('the oval tool records an oval-shaped selection', async ({ page }) => {
    await stubServer(page);
    await page.goto('/');
    await waitForMap(page);

    await page.getByRole('button', { name: 'Select oval area' }).click();
    await dragOnMap(page, [-60, -40], [60, 40]);

    await expect(page.getByRole('button', { name: 'Open 3D menu' })).toBeVisible();
    await expect.poll(() => configFromUrl(page.url())?.shape).toBe('oval');
    expect(configFromUrl(page.url())!.selection).toHaveLength(4);
});

test('the 1:1 aspect lock squares up a wide drag', async ({ page }) => {
    await stubServer(page);
    await page.goto('/');
    await waitForMap(page);

    await page.getByRole('button', { name: 'Select rectangular area' }).click();
    // Lock to 1:1 (the ratio dropdown appears once a selection tool is active).
    await page.getByLabel('Lock aspect ratio').selectOption('1:1');
    // Draw a deliberately wide box; the lock shrinks the long axis so it ends up square.
    await dragOnMap(page, [-90, -40], [90, 40]);

    await expect.poll(() => page.url()).toContain('sel=');
    const sel = configFromUrl(page.url())!.selection;       // [TL, TR, BR, BL]
    const width = haversineMeters(sel[0], sel[1]);          // TL→TR
    const height = haversineMeters(sel[0], sel[3]);         // TL→BL
    expect(width / height).toBeGreaterThan(0.9);
    expect(width / height).toBeLessThan(1.1);
});

test('the move handle translates an existing selection', async ({ page }) => {
    await stubServer(page);
    await page.goto('/');
    await waitForMap(page);

    await page.getByRole('button', { name: 'Select rectangular area' }).click();
    await dragOnMap(page, [-60, -40], [60, 40]);
    await expect.poll(() => page.url()).toContain('sel=');
    const before = configFromUrl(page.url())!.selection;

    // The move handle sits at the selection centre (the midpoint of the draw above). Drag it
    // east and the corners should shift, but it stays a four-corner selection.
    await dragOnMap(page, [0, 0], [50, 0]);
    await expect
        .poll(() => configFromUrl(page.url())?.selection?.[0]?.[0])
        .not.toBe(before[0][0]);

    const after = configFromUrl(page.url())!.selection;
    expect(after).toHaveLength(4);
    // Centre longitude moved east (the drag direction).
    const lon = (s: number[][]) => s.reduce((a, c) => a + c[0], 0) / s.length;
    expect(lon(after)).toBeGreaterThan(lon(before));
});
