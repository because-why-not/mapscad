import type { ManifestMap } from './TileMapManifest';
import { LOCAL_MAP_PREFIX } from './mapMeta';

/**
 * Custom maps are not served by the manifest directly — we synthesize them by
 * combining manifest sources. This module is pure declarative data; how a custom map
 * is actually rendered lives in the engine that claims it (e.g. MapLibreTerrainEngine
 * for these 3D terrain maps).
 */

/** What gets painted onto the 3D terrain surface. */
export type CustomSurface =
    | { type: 'imagery'; source: string }   // drape a raster source (e.g. aerial) over the terrain
    | { type: 'hillshade' }                 // 3D computed shaded relief from the DEM itself (MapLibre)
    | { type: 'hillshade-2d' };             // flat shaded relief computed from the DEM (OpenLayers)

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
    // External global DEMs (see externalDems.ts): a 2D + 3D hillshade beside each one's raw
    // tile layer in its own map-menu category. The 2D hillshade is the useful one for
    // picking an area — it renders on the OpenLayers map, which carries the selection tool.
    {
        id: 'mapterhorn_2d_hillshade',
        name: '2D Hillshade',
        icon: '🗺️',
        surface: { type: 'hillshade-2d' },
        demSource: 'mapterhorn_elevation',
        exaggeration: 1.4,
        category: 'Mapterhorn',
    },
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
        id: 'aws_terrain_2d_hillshade',
        name: '2D Hillshade',
        icon: '🗺️',
        surface: { type: 'hillshade-2d' },
        demSource: 'aws_terrain_elevation',
        exaggeration: 1.4,
        category: 'AWS Terrain',
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
    // NZ server DEMs: 3D hillshade to sit beside the server's raw + pre-rendered 2D
    // hillshade tile layers (those two are plain tile providers, see mapCategories.ts).
    // The "(computed)" entries render OUR in-browser hillshade from the same raw DEM, kept
    // for now so we can eyeball it against the server's pre-rendered 8m hillshade.
    {
        id: 'north_island_2d_hillshade_computed',
        name: '2D Hillshade (computed)',
        icon: '🧪',
        surface: { type: 'hillshade-2d' },
        demSource: 'north_island_elevation_raw',
        exaggeration: 1.4,
        category: 'North Island',
    },
    {
        id: 'north_island_3d_hillshade',
        name: '3D Hillshade',
        icon: '⛰️',
        surface: { type: 'hillshade' },
        demSource: 'north_island_elevation_raw',
        exaggeration: 1.4,
        category: 'North Island',
    },
    {
        id: 'south_island_2d_hillshade_computed',
        name: '2D Hillshade (computed)',
        icon: '🧪',
        surface: { type: 'hillshade-2d' },
        demSource: 'south_island_elevation_raw',
        exaggeration: 1.4,
        category: 'South Island',
    },
    {
        id: 'south_island_3d_hillshade',
        name: '3D Hillshade',
        icon: '⛰️',
        surface: { type: 'hillshade' },
        demSource: 'south_island_elevation_raw',
        exaggeration: 1.4,
        category: 'South Island',
    },
];

/**
 * Only expose custom maps whose underlying manifest sources actually exist today. The specs
 * reference sources by their bare name; a self-hosted-server source lives under the
 * `LOCAL_MAP_PREFIX`, so resolve each reference to the actual map id (bare or prefixed) and
 * return a spec carrying the resolved ids, so everything downstream (demBySource, the engines)
 * looks up the map that really exists.
 */
export function availableCustomMaps(mapsById: Record<string, ManifestMap>): CustomMapSpec[] {
    const resolve = (name: string): string | null =>
        mapsById[name] ? name : (mapsById[LOCAL_MAP_PREFIX + name] ? LOCAL_MAP_PREFIX + name : null);
    const out: CustomMapSpec[] = [];
    for (const c of CUSTOM_MAPS) {
        const demSource = resolve(c.demSource);
        if (!demSource) continue;
        if (c.surface.type === 'imagery') {
            const source = resolve(c.surface.source);
            if (!source) continue;
            out.push({ ...c, demSource, surface: { ...c.surface, source } });
        } else {
            out.push({ ...c, demSource });
        }
    }
    return out;
}
