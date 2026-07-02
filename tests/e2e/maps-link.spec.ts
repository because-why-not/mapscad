import { test, expect } from '@playwright/test';
import { stubServer } from './_stub';

// The "map-only" link: the URL hash carries human-readable map state (map name + view) and
// NO selection params until an area is selected. Opening such a link should position the
// map and select the named source, with the URL staying human-readable.

test('a map-only link applies map name + view, with no selection params', async ({ page }) => {
    await stubServer(page);

    // Open with only the readable params — a specific (non-default) source + view.
    await page.goto('/#map=opentopomap&lat=-41.27000&lng=174.78000&z=8.40');
    await expect(page.getByRole('button', { name: 'Open map menu' })).toBeVisible();

    // The z= param drove the initial zoom readout (the badge over the map).
    await expect(page.getByText(/^z8/)).toBeVisible();

    // The link actually positioned the map: the live URL is rebuilt from the map's real
    // centre/zoom (composeShareUrl reads getView()), so it must echo the exact coordinates
    // we opened with — not the default Dunedin view. A broken link→view path would show
    // different lat/lng here.
    await expect.poll(() => page.url()).toContain('map=opentopomap');
    expect(page.url()).toContain('lat=-41.27');
    expect(page.url()).toContain('lng=174.78');
    expect(page.url()).toContain('z=8.4');

    // …but with no selection, no selection params must appear.
    expect(page.url()).not.toContain('sel=');
});

test('the active source is highlighted in the menu', async ({ page }) => {
    await stubServer(page);
    await page.goto('/#map=opentopomap&lat=-41.27&lng=174.78&z=8');
    await page.getByRole('button', { name: 'Open map menu' }).click();
    // The accordion auto-opens the section holding the active layer; its button is active.
    await expect(page.getByRole('button', { name: /Opentopomap/ })).toHaveClass(/active/);
});
