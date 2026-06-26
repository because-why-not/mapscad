/**
 * Map-menu grouping for specific tile sources: manifest source name -> { category, label }.
 * A categorized source is pulled out of the generic "Map Source" section and shown under
 * its own heading, together with the matching 3D map (a custom map carrying the same
 * `category`, see customMaps.ts). `label` overrides the displayed name within the group
 * (the heading already names the source); `icon` optionally overrides the type icon so the
 * raw / 2D / 3D entries read consistently across groups.
 */
export interface ProviderCategory {
    category: string;
    label: string;
    icon?: string;
    dem?: string;   // elevation DEM this layer represents (so selecting an area on a server
                    // hillshade can default the preview to its DEM); omit for raw DEM layers
}

export const PROVIDER_CATEGORY: Record<string, ProviderCategory> = {
    // External global DEMs (externalDems.ts) — no server-rendered hillshade, so their 2D
    // hillshade is computed in-browser (a hillshade-2d custom map), not listed here.
    mapterhorn_elevation: { category: 'Mapterhorn', label: 'Raw' },
    aws_terrain_elevation: { category: 'AWS Terrain', label: 'Raw' },
    // NZ server DEMs — the server already ships a pre-rendered 8m hillshade tile layer, so
    // that IS the 2D hillshade (a plain raster layer); the raw DEM drives the 3D map.
    north_island_elevation_raw: { category: 'North Island', label: 'Raw' },
    north_island_hillshade_8m: { category: 'North Island', label: '2D Hillshade', icon: '🗺️', dem: 'north_island_elevation_raw' },
    south_island_elevation_raw: { category: 'South Island', label: 'Raw' },
    south_island_hillshade_8m: { category: 'South Island', label: '2D Hillshade', icon: '🗺️', dem: 'south_island_elevation_raw' },
};
