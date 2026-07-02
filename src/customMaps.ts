import type { ManifestMap } from './TileMapManifest';
import { stripLocalPrefix, prettifyMapName } from './mapMeta';

/**
 * Custom maps are not served by the manifest directly — we synthesize them from manifest sources.
 * They are DERIVED at runtime from whatever elevation DEMs the manifest advertises (never hardcoded
 * by name — the tile-server maps are private): each `mmapsrv.type === 'elevation'` entry gets a 2D
 * hillshade (OpenLayers, so the selection tool works over it) and a 3D hillshade (MapLibre), both
 * driven by that same DEM, grouped in the menu beside the DEM's own raw tile layer. How a spec is
 * actually rendered lives in the engine that claims it (MapLibreTerrainEngine / OpenLayers Raster op).
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

/** Menu-group heading for an elevation DEM: its prettified name minus the `_elevation[_raw]` tail
 *  (e.g. `mapterhorn_elevation` → "Mapterhorn", `north_island_elevation_raw` → "North Island"). The
 *  raw tile layer, the 2D hillshade and the 3D hillshade all carry this so they group together. */
export function elevationGroup(name: string): string {
    return prettifyMapName(stripLocalPrefix(name).replace(/_elevation(_raw)?$/i, ''));
}

/**
 * Derive the custom maps from the manifest: for every elevation DEM it advertises, synthesize a 2D
 * hillshade (OpenLayers) and a 3D hillshade (MapLibre) driven by that DEM. Nothing is hardcoded by
 * name — the tile-server maps are private, so they must be discovered at runtime — and each pair is
 * grouped (via `elevationGroup`) beside the DEM's own raw tile layer.
 */
export function availableCustomMaps(mapsById: Record<string, ManifestMap>): CustomMapSpec[] {
    const out: CustomMapSpec[] = [];
    for (const map of Object.values(mapsById)) {
        if (map.mmapsrv?.type !== 'elevation') continue;
        const demSource = map.name;
        const category = elevationGroup(demSource);
        out.push({
            id: `${demSource}__hillshade2d`, name: '2D Hillshade', icon: '🗺️',
            surface: { type: 'hillshade-2d' }, demSource, exaggeration: 1.4, category,
        });
        out.push({
            id: `${demSource}__hillshade3d`, name: '3D Hillshade', icon: '⛰️',
            surface: { type: 'hillshade' }, demSource, exaggeration: 1.4, category,
        });
    }
    return out;
}
