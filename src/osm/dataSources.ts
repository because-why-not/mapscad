import type { AttributionDetail } from '../TileMapManifest';

/**
 * A vector-DATA source (as opposed to the raster map/DEM sources in `externalMaps`/`externalDems`).
 * Same idea as a `ManifestMap`: one entry describes an endpoint we query plus the attribution its
 * data requires. Kept separate because data sources have an `endpoint` (queried, not tiled) rather
 * than tile URLs, and drive the Data menu instead of the map source list.
 */
export interface DataApiManifest {
    /** Stable id. */
    id: string;
    /** Display name for the menu. */
    name: string;
    /** The endpoint queries are sent to. */
    endpoint: string;
    /** Structured attribution shown at the bottom of the Data menu. */
    attribution: AttributionDetail;
}

/**
 * OpenStreetMap vector data, fetched through the public Overpass API. The features we download
 * (buildings/streets/tracks) are OSM data under the ODbL — baking them into an exported model makes
 * a "produced work" that must credit OpenStreetMap, so the credit line below is a requirement, not
 * a courtesy. The Overpass instance itself is a free, shared service under an acceptable-use policy
 * (light/interactive use only); our per-feature size limits keep queries within that.
 */
export const OSM_DATA_API: DataApiManifest = {
    id: 'osm-overpass',
    name: 'OpenStreetMap via Overpass API',
    endpoint: 'https://overpass-api.de/api/interpreter',
    attribution: {
        provider: 'OpenStreetMap (via Overpass API)',
        homepage: { text: 'openstreetmap.org', url: 'https://www.openstreetmap.org' },
        license: { text: 'Open Database License (ODbL) 1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/' },
        credit: [
            'Data © ',
            { text: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' },
            ' contributors, ODbL. Served by ',
            { text: 'Overpass API', url: 'https://overpass-api.de/' },
            '.',
        ],
    },
};
