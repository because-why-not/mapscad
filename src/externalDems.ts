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
export const EXTERNAL_DEMS: ManifestMap[] = [
    {
        name: 'mapterhorn_elevation',
        attribution: "© Mapterhorn · Copernicus GLO-30",
        attributionDetail: {
            // Mapterhorn composites many regional datasets, each with its own licensing terms, so
            // there is no single license — point at their per-region attribution page instead.
            provider: 'Mapterhorn',
            homepage: { text: 'mapterhorn.com', url: 'https://mapterhorn.com' },
            license: { text: 'Varies by region', url: 'https://mapterhorn.com/attribution' },
            credit: [
                '© ',
                { text: 'Mapterhorn', url: 'https://mapterhorn.com' },
                ' — see ',
                { text: 'mapterhorn.com/attribution', url: 'https://mapterhorn.com/attribution' },
                ' for per-region data sources and licenses',
            ],
        },
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
        attributionDetail: {
            // Terrain Tiles composite many national/global datasets, each with its own terms, so
            // the full source list below is the required attribution (per Tilezen/Joerd).
            provider: 'Mapzen / Tilezen Terrain Tiles',
            homepage: { text: 'registry.opendata.aws/terrain-tiles', url: 'https://registry.opendata.aws/terrain-tiles/' },
            license: { text: 'Varies by source', url: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md' },
            credit: [
                'Mapzen\n'
                + 'ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;\n'
                + 'Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;\n'
                + 'Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;\n'
                + 'Canada terrain data contains information licensed under the Open Government Licence – Canada;\n'
                + 'Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers;\n'
                + 'Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration;\n'
                + 'Mexico terrain data source: INEGI, Continental relief, 2016;\n'
                + 'New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved);\n'
                + 'Norway terrain data © Kartverket;\n'
                + 'United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved;\n'
                + 'United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.',
            ],
        },
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
