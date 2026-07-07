import type { ManifestMap } from '../maptiles/TileMapManifest';

/**
 * Public, internet-hosted base maps used when no self-hosted tile server is configured
 * (see webpack `__TILE_SERVER_URL__`). Appended to the manifest at startup so the app has a
 * usable 2D map out of the box — pick an area over OpenStreetMap or OpenTopoMap, then sample
 * elevation from the public DEMs in `externalDems.ts`.
 *
 * Both send `Access-Control-Allow-Origin: *` so OpenLayers can render them with
 * `crossOrigin: 'anonymous'`. These are the standard community tile servers; their usage
 * policies ask that heavy/production traffic run against your own server — configure a tile
 * server via `.env` for that.
 */
export const EXTERNAL_MAPS: ManifestMap[] = [
    {
        name: 'openstreetmap',
        prettyName: 'OpenStreetMap',
        attribution: '© OpenStreetMap contributors',
        attributionDetail: {
            provider: 'OpenStreetMap',
            homepage: { text: 'openstreetmap.org', url: 'https://www.openstreetmap.org' },
            license: { text: 'Open Database License (ODbL)', url: 'https://opendatacommons.org/licenses/odbl/' },
            credit: [
                '© ',
                { text: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' },
                ' contributors',
            ],
        },
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        minzoom: 0,
        maxzoom: 19,
        bounds: [-180, -85.0511287, 180, 85.0511287],
        mmapsrv: {
            type: 'street',
            proxy: false,
            tileFormat: 'png',
            tileSize: 256,
        },
    },
    {
        name: 'opentopomap',
        prettyName: 'OpenTopoMap',
        attribution: '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap contributors',
        attributionDetail: {
            provider: 'OpenTopoMap',
            homepage: { text: 'opentopomap.org', url: 'https://opentopomap.org' },
            license: { text: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' },
            credit: [
                'Kartendaten: © ',
                { text: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' },
                '-Mitwirkende, SRTM | Kartendarstellung: © ',
                { text: 'OpenTopoMap', url: 'https://opentopomap.org' },
                ' (',
                { text: 'CC-BY-SA', url: 'https://creativecommons.org/licenses/by-sa/3.0/' },
                ')',
            ],
        },
        tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
        minzoom: 0,
        maxzoom: 17,
        bounds: [-180, -85.0511287, 180, 85.0511287],
        mmapsrv: {
            type: 'topo',
            proxy: false,
            tileFormat: 'png',
            tileSize: 256,
        },
    },
];
