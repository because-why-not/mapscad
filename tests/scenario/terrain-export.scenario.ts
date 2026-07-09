import { describe, it, expect } from 'vitest';
import { MapscadSession } from '../../src/kit/MapscadSession';
import { MapModel } from '../../src/kit/MapModel';
import { fetchTileMapManifest } from '../../src/kit/maptiles/TileMapManifest';
import { sampleSelectionHeights, resolutionZoomRange, gridResolution } from '../../src/kit/maptiles/HeightSampler';
import { OsmVectorData } from '../../src/kit/mapelements/OsmVectorData';
import { OsmFeatureId } from '../../src/kit/mapelements/osmFeatures';
import { modelToStlBytes } from '../../src/kit/StlMaker';
import type { LonLat } from '../../src/kit/common/mathHelper';

/**
 * SCENARIO (the third test tier — see vitest.scenario.config.ts): a real-world walkthrough of driving
 * the mapscad kit as a headless API, with NO Svelte and NO app shell — just the kit objects a script,
 * server, or batch job would use. It runs in a real headless browser so the browser-only stages (DEM
 * tile Image-decode, the OSM `<canvas>` raise) behave exactly as in the app. "Headless" here means
 * *no interactive UI*, not *no browser APIs* — which is the project's own definition.
 *
 * Fully live (not hermetic): the DEM comes from the tile server in `.env` and the OSM overlay from the
 * real Overpass API. Trigger it on demand with `npm run scenario`; it is deliberately NOT in `npm test`.
 *
 * Read the body top-to-bottom as the recipe — it is the eight-step flow, one step per block.
 */

// A ~400 m box over central Dunedin (the Octagon), corners [TL, TR, BR, BL] = NW, NE, SE, SW (lon, lat).
// Central CBD, so the real Overpass query reliably returns named streets to overlay.
const DUNEDIN_CBD: LonLat[] = [
    [170.5010, -45.8724],
    [170.5062, -45.8724],
    [170.5062, -45.8760],
    [170.5010, -45.8760],
];

describe('scenario: turn a map area + OSM into a printable STL, headless', () => {
    it('runs the whole eight-step user flow through the kit API', async () => {
        // 1. INIT — the objects a caller holds onto. The session is the source of truth; the model
        //    carries the print/geometry settings. (No ProcessorConfigStore — that's just persistence.)
        const session = new MapscadSession();
        const model = new MapModel();

        // 2. SELECT — set the print area from corner coordinates, in code (the map is just one producer
        //    of this in the app).
        session.setSelection(DUNEDIN_CBD);
        const corners = session.getSelection()!;

        // 3. PICK SOURCE + RESOLUTION + ZOOM → download + sample the DEM. The source is an elevation
        //    entry from the live tile-server manifest; resolution + zoom are model settings; sampling
        //    downloads the covering tiles and bilinearly fills the grid. The HeightGrid is the artifact
        //    an advanced caller could run their own code over.
        const manifest = await fetchTileMapManifest();
        const dem = manifest.find(m => m.name === 'dunedin_elevation_raw' && m.mmapsrv.type === 'elevation');
        expect(dem, 'tile server must serve dunedin_elevation_raw — check .env TILE_SERVER_URL').toBeTruthy();

        const raster = 256;
        const { def: heightZoom } = resolutionZoomRange(corners, dem!, raster); // the zoom the mesh needs
        model.applySettings({ rasterResolution: raster, heightZoom });
        const { cols, rows } = gridResolution(corners, raster);
        const grid = await sampleSelectionHeights(corners, dem!, cols, rows, heightZoom);
        model.setGrid(grid);
        expect(grid.maxHeight - grid.minHeight).toBeGreaterThan(2); // real relief, not a no-data slab

        // 4. DOWNLOAD OVERLAY DATA — real Overpass, through the session's element manager.
        const streets = OsmFeatureId.Streets;
        const downloaded = await session.mapElements.download(streets);
        expect(downloaded).toBeGreaterThan(0); // central Dunedin has streets

        // 5. FILTER — the caller has full access to the downloaded list and writes their OWN predicate
        //    (here: keep only NAMED streets). The kit just provides the data; the filtering is user code.
        const all = session.mapElements.getElements(streets)!.list;
        const chosen = all.filter(e => !!e.name);
        expect(chosen.length).toBeGreaterThan(0);
        //    Bind the chosen subset onto the sampled grid and hand it to the model as this feature's data.
        const overlay = new OsmVectorData(chosen).withGrid({ corners, cols: grid.cols, rows: grid.rows });
        model.setOsmData(streets, overlay);

        // 6. CONFIGURE THE DEFAULT PROCESSORS — settings drive which built-in processors run and how:
        //    a socket (vertex stage), height exaggeration (elevation stage), and the OSM raise for the
        //    overlaid streets as their own separate body (multi-part printing).
        model.applySettings({
            socketEnabled: true, socketSize: 4,
            heightScale: 1.5,
            osm: { [streets]: { enabled: true, raise: 8, radius: 6, separate: true } },
        });

        // 7. GENERATE — build the neutral 3D geometry; this runs the processor chain, including the
        //    canvas-based OSM raise (real browser canvas here). Terrain + the streets body = 2+ bodies.
        const geo = model.buildGeometry();
        expect(geo).not.toBeNull();
        expect(geo!.bodies.length).toBeGreaterThan(1);

        // 8. EXPORT — binary STL bytes. In the app, exportModelStl(model) wraps these in a download.
        const stl = modelToStlBytes(model);
        expect(stl).not.toBeNull();
        const triangleCount = new DataView(stl!).getUint32(80, true);
        expect(triangleCount).toBeGreaterThan(0);
    });
});
