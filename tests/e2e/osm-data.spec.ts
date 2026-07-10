import { test, expect } from '@playwright/test';
import { stubServer } from './_stub';

// End-to-end coverage of the OSM "Data" tab against a stubbed Overpass endpoint: download populates
// the object list, mark + Disable strikes a row through, and a re-download replaces the list AND
// clears the marks. This guards the OsmDataPanel <-> MapscadSession data flow — which the golden-STL
// e2e does NOT touch (it only exercises the DEM sample → mesh → export path).

// ~150 m square near the Dunedin DEM centre (well under every feature's size limit).
const SELECTION = [
    [170.512533, -45.833427],
    [170.514467, -45.833427],
    [170.514467, -45.834774],
    [170.512533, -45.834774],
];

const CONFIG = {
    version: 1,
    demId: 'dunedin_elevation_raw',
    selection: SELECTION,
    model: { heightZoom: 12, socketEnabled: true, socketSize: 5, heightScale: 1 },
};

// Unnamed 2-point ways → the tracks list shows "Tracks #1", "Tracks #2", …
const overpassBody = (ids: number[]) => JSON.stringify({
    elements: ids.map(id => ({
        type: 'way', id,
        geometry: [{ lon: 170.5131, lat: -45.8338 }, { lon: 170.5138, lat: -45.8342 }],
        tags: {},
    })),
});

test('OSM data tab: download fills the list, disable strikes a row, re-download clears marks', async ({ page }) => {
    await stubServer(page);
    await page.addInitScript((cfg) => localStorage.setItem('previewConfig', JSON.stringify(cfg)), CONFIG);

    // First download returns 3 ways; after `shrink` flips, a re-download returns 2.
    let shrink = false;
    await page.route('**/api/interpreter', route =>
        route.fulfill({ contentType: 'application/json', body: overpassBody(shrink ? [11, 22] : [11, 22, 33]) }),
    );

    await page.goto('/');

    // The Data tab enables once the seeded selection is restored.
    const dataTab = page.getByRole('button', { name: 'Data', exact: true });
    await expect(dataTab).toBeEnabled({ timeout: 30_000 });
    await dataTab.click();

    // Download tracks → 3 rows appear (title-based locator is stable across the button's label change).
    const downloadTracks = page.locator('button[title="Download tracks in the selected area"]');
    await downloadTracks.click();
    const rows = page.locator('li[data-osm-el^="tracks:"]');
    await expect(rows).toHaveCount(3);

    // Mark the first row and Disable it → it renders struck-through (line-through). Disable/Enable/
    // Cancel only exist for tracks here (buildings/streets have no data), so the name is unambiguous.
    await rows.first().getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(rows.first().locator('button.line-through')).toBeVisible();

    // Mark another row, then re-download a smaller set → the list is replaced (2 rows) AND all marks
    // are cleared (setElements resets them). This is the interlock the subscribe-flip must preserve.
    await rows.nth(1).getByRole('checkbox').check();
    shrink = true;
    await downloadTracks.click();
    await expect(page.locator('li[data-osm-el^="tracks:"]')).toHaveCount(2);
    await expect(page.locator('li[data-osm-el^="tracks:"] input[type="checkbox"]:checked')).toHaveCount(0);
});
