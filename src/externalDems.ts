import type { ManifestMap } from './TileMapManifest';

/**
 * Public, internet-hosted elevation DEMs that aren't served by our own tile server.
 * Appended to the manifest at startup so they show up as ordinary elevation sources in
 * the preview's DEM toggle (and the 2D layer switcher). Both are terrarium-encoded — the
 * exact decode HeightSampler already uses — and both send `Access-Control-Allow-Origin: *`,
 * so the sampler can read their tiles onto a canvas without tainting it.
 *
 * Mapterhorn ships 512px WebP tiles; HeightSampler / OpenLayersEngine read
 * `mmapsrv.tileSize`, so the pixel↔zoom math stays correct for non-256 sources.
 */
/**
 * Menu category each external DEM gets grouped under (keyed by manifest name). The raw
 * tile layer and the matching 3D hillshade custom map share the category so they appear
 * together in the map menu instead of scattered across "Map Source" / "Custom Maps".
 */
export const EXTERNAL_DEM_CATEGORY: Record<string, string> = {
    mapterhorn_elevation: 'Mapterhorn',
    aws_terrain_elevation: 'AWS Terrain',
};

export const EXTERNAL_DEMS: ManifestMap[] = [
    {
        name: 'mapterhorn_elevation',
        attribution: "© Mapterhorn · Copernicus GLO-30",
        tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
        minzoom: 0,
        // Global coverage is Copernicus GLO-30 to z12. Above that the endpoint has data
        // ONLY in high-res regions (national LiDAR, e.g. swissALTI3D to ~z17/0.5m) and 404s
        // everywhere else — it does not overzoom. We expose up to z17 so covered areas reach
        // native detail; a 404 sampled outside coverage is no-data → filled flat, so a
        // selection straddling a coverage edge shows flat patches in the preview (lower the
        // zoom, or stay ≤z12 for guaranteed-global). 512px tiles also double detail per zoom.
        maxzoom: 17,
        bounds: [-180, -85.0511287, 180, 85.0511287],
        mmapsrv: {
            type: 'elevation',
            proxy: false,
            tileFormat: 'webp',
            tileSize: 512,
            minStoredZoom: 0,
        },
    },
    {
        name: 'aws_terrain_elevation',
        attribution: 'Terrain Tiles © Mapzen/Tilezen, hosted on AWS Open Data',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        minzoom: 0,
        maxzoom: 15,
        bounds: [-180, -85.0511287, 180, 85.0511287],
        mmapsrv: {
            type: 'elevation',
            proxy: false,
            tileFormat: 'png',
            tileSize: 256,
            minStoredZoom: 0,
        },
    },
];
