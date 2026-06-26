import type { ManifestMap } from './TileMapManifest';

/**
 * Custom maps are not served by the manifest directly — we synthesize them by
 * combining manifest sources. This module is pure declarative data; how a custom map
 * is actually rendered lives in the engine that claims it (e.g. MapLibreTerrainEngine
 * for these 3D terrain maps).
 */

/** What gets painted onto the 3D terrain surface. */
export type CustomSurface =
    | { type: 'imagery'; source: string }   // drape a raster source (e.g. aerial) over the terrain
    | { type: 'hillshade' }                 // computed shaded relief from the DEM itself (MapLibre)
    | { type: 'shaded-relief' };            // solid-toned terrain lit by the sun w/ cast shadows (deck.gl)

export interface CustomMapSpec {
    id: string;
    name: string;
    icon: string;
    surface: CustomSurface;
    demSource: string;       // terrarium-encoded elevation manifest name (drives the terrain)
    exaggeration: number;    // vertical terrain exaggeration
    category?: string;       // map-menu group; undefined => the generic "Custom Maps" section
}

const CUSTOM_MAPS: CustomMapSpec[] = [
    {
        id: 'dunedin_3d',
        name: 'Dunedin 3D',
        icon: '🏔️',
        surface: { type: 'imagery', source: 'dunedin_aerial' },
        demSource: 'dunedin_elevation_raw',
        exaggeration: 1.4,
    },
    {
        id: 'dunedin_3d_hillshade',
        name: 'Dunedin 3D Hillshade',
        icon: '⛰️',
        surface: { type: 'hillshade' },
        demSource: 'dunedin_elevation_raw',
        exaggeration: 1.4,
    },
    {
        id: 'dunedin_3d_shadows',
        name: 'Dunedin 3D Shadows',
        icon: '🌄',
        surface: { type: 'shaded-relief' },
        demSource: 'dunedin_elevation_raw',
        exaggeration: 1.4,
    },
    // External global DEMs (see externalDems.ts): a 3D hillshade to sit beside each one's
    // raw tile layer in its own map-menu category.
    {
        id: 'mapterhorn_3d_hillshade',
        name: '3D Hillshade',
        icon: '⛰️',
        surface: { type: 'hillshade' },
        demSource: 'mapterhorn_elevation',
        exaggeration: 1.4,
        category: 'Mapterhorn',
    },
    {
        id: 'aws_terrain_3d_hillshade',
        name: '3D Hillshade',
        icon: '⛰️',
        surface: { type: 'hillshade' },
        demSource: 'aws_terrain_elevation',
        exaggeration: 1.4,
        category: 'AWS Terrain',
    },
];

/** Only expose custom maps whose underlying manifest sources actually exist today. */
export function availableCustomMaps(mapsById: Record<string, ManifestMap>): CustomMapSpec[] {
    return CUSTOM_MAPS.filter(c => {
        if (!mapsById[c.demSource]) return false;
        if (c.surface.type === 'imagery' && !mapsById[c.surface.source]) return false;
        return true;
    });
}

/** Whether a custom map is lit by the sun (so the Sun date/time controls apply). */
export function isSunCapable(spec: CustomMapSpec): boolean {
    return spec.surface.type === 'hillshade' || spec.surface.type === 'shaded-relief';
}
