import type { ManifestMap } from './TileMapManifest';

/**
 * Custom maps are not served by the manifest directly — we synthesize them by
 * combining two or more manifest sources. This module is pure declarative data; how
 * a custom map is actually rendered lives in the engine that claims it (e.g.
 * MapLibreTerrainEngine for the 3D terrain maps).
 */
export interface CustomMapSpec {
    id: string;
    name: string;
    icon: string;
    imagerySource: string;   // manifest name draped as the surface texture
    demSource: string;       // terrarium-encoded elevation manifest name
    exaggeration: number;    // vertical terrain exaggeration
}

const CUSTOM_MAPS: CustomMapSpec[] = [
    {
        id: 'dunedin_3d',
        name: 'Dunedin 3D',
        icon: '🏔️',
        imagerySource: 'dunedin_aerial',
        demSource: 'dunedin_elevation_raw',
        exaggeration: 1.4,
    },
];

/** Only expose custom maps whose underlying manifest sources actually exist today. */
export function availableCustomMaps(mapsById: Record<string, ManifestMap>): CustomMapSpec[] {
    return CUSTOM_MAPS.filter(c => mapsById[c.imagerySource] && mapsById[c.demSource]);
}
