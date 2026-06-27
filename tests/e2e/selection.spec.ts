import { test, expect } from '@playwright/test';
import { stubServer, dragOnMap, configFromUrl } from './_stub';

// Exercises the selection mechanisms themselves — drawing a rectangle, drawing an oval, and
// moving an existing selection — WITHOUT any real download (tiles are stubbed blank). We
// assert on the selection state the app exposes in the URL `c=` slice, not on geometry.

// Wait until the OpenLayers map (and thus the selection tool created in its onReady) exists.
async function waitForMap(page: import('@playwright/test').Page): Promise<void> {
    await expect(page.getByRole('button', { name: 'Open map menu' })).toBeVisible();
    await expect(page.locator('#map-mount canvas')).toBeVisible();
}

test('the rectangle tool creates a four-corner selection', async ({ page }) => {
    await stubServer(page);
    await page.goto('/');
    await waitForMap(page);

    await page.getByRole('button', { name: 'Select rectangular area' }).click();
    await dragOnMap(page, [-60, -40], [60, 40]);

    // A selection makes the 3D preview appear and adds the c= blob to the URL.
    await expect(page.getByRole('button', { name: 'Open 3D menu' })).toBeVisible();
    await expect.poll(() => page.url()).toContain('c=');

    const cfg = configFromUrl(page.url());
    expect(cfg.selection).toHaveLength(4);
    expect(cfg.model.shape).toBe('rectangle');
});

test('the oval tool records an oval-shaped selection', async ({ page }) => {
    await stubServer(page);
    await page.goto('/');
    await waitForMap(page);

    await page.getByRole('button', { name: 'Select oval area' }).click();
    await dragOnMap(page, [-60, -40], [60, 40]);

    await expect(page.getByRole('button', { name: 'Open 3D menu' })).toBeVisible();
    await expect.poll(() => configFromUrl(page.url())?.model.shape).toBe('oval');
    expect(configFromUrl(page.url()).selection).toHaveLength(4);
});

test('the move handle translates an existing selection', async ({ page }) => {
    await stubServer(page);
    await page.goto('/');
    await waitForMap(page);

    await page.getByRole('button', { name: 'Select rectangular area' }).click();
    await dragOnMap(page, [-60, -40], [60, 40]);
    await expect.poll(() => page.url()).toContain('c=');
    const before = configFromUrl(page.url()).selection;

    // The move handle sits at the selection centre (the midpoint of the draw above). Drag it
    // east and the corners should shift, but it stays a four-corner selection.
    await dragOnMap(page, [0, 0], [50, 0]);
    await expect
        .poll(() => configFromUrl(page.url())?.selection?.[0]?.[0])
        .not.toBe(before[0][0]);

    const after = configFromUrl(page.url()).selection;
    expect(after).toHaveLength(4);
    // Centre longitude moved east (the drag direction).
    const lon = (s: number[][]) => s.reduce((a, c) => a + c[0], 0) / s.length;
    expect(lon(after)).toBeGreaterThan(lon(before));
});
