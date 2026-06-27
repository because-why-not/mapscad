import { test, expect } from '@playwright/test';
import { stubServer } from './_stub';

// The "map-only" link: the URL hash carries human-readable map state (map name + view) and
// NO opaque `c=` blob until an area is selected. Opening such a link should position the
// map and select the named source, with the URL staying human-readable.

test('a map-only link applies map name + view, with no c= blob', async ({ page }) => {
    await stubServer(page);

    // Open with only the readable params — a specific (non-default) source + view.
    await page.goto('/#map=opentopomap&lat=-41.27000&lng=174.78000&z=8.40');
    await expect(page.getByRole('button', { name: 'Open map menu' })).toBeVisible();

    // The z= param drove the initial zoom readout (the badge over the map).
    await expect(page.getByText(/^z8/)).toBeVisible();

    // The map= param selected that source (proven by it round-tripping back into the live
    // URL via the active id), and the view params are present…
    await expect.poll(() => page.url()).toContain('map=opentopomap');
    expect(page.url()).toContain('lat=');
    expect(page.url()).toContain('z=');

    // …but with no selection, the opaque export blob must NOT appear.
    expect(page.url()).not.toContain('c=');
});

test('the active source is highlighted in the menu', async ({ page }) => {
    await stubServer(page);
    await page.goto('/#map=opentopomap&lat=-41.27&lng=174.78&z=8');
    await page.getByRole('button', { name: 'Open map menu' }).click();
    // The accordion auto-opens the section holding the active layer; its button is active.
    await expect(page.getByRole('button', { name: /Opentopomap/ })).toHaveClass(/active/);
});
