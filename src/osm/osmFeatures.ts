import type { BBox } from './bbox';

/**
 * Registry of OSM vector features. Each entry is the SINGLE place a feature is defined — its
 * Overpass query, how it draws on the 2D map, and how it raises terrain in the preview. The whole
 * pipeline (fetch → overlay → height-grid processor → settings → UI) is generic and driven by this
 * list, so adding a feature (e.g. cycleways) is a new entry here, not a new set of classes.
 *
 * `geometry` picks both representations at once:
 *   - 'line' → ways are polylines; drawn as a stroked OL line and PAINTED as a blurred stroke whose
 *     `radius` (metres) is the brush half-width (tracks, streets).
 *   - 'area' → ways are closed rings; drawn as a filled OL polygon and PAINTED as a solid fill
 *     (buildings). `radius` is unused.
 */
export type OsmGeometry = 'line' | 'area';

export interface OsmFeatureDef {
    /** Stable id; the key everything (settings, overlays, model data) is keyed by. */
    id: string;
    /** Section heading in the menus, e.g. "Tracks". */
    label: string;
    /** Plural noun for button feedback, e.g. "tracks" → "12 tracks". */
    noun: string;
    geometry: OsmGeometry;
    /** Minimum vertex count for a usable way (2 for a line, 3 for a ring). */
    minPoints: number;
    /** The `way[...]` selector body inserted into the Overpass query, e.g. `["building"]` or
     *  `["highway"~"^(path|track)$"]`. Built by `highwaySelector` for highway-based features. */
    selector: string;
    /** OL overlay stroke colour, and (for areas) fill colour. zIndex orders the overlays. */
    strokeColor: string;
    fillColor?: string;
    zIndex: number;
    /** Default terrain raise in metres (negative carves). */
    raise: number;
    /** Default brush radius in metres for `line` features (ignored for `area`). */
    radius: number;
}

/** Build a `["highway"~"^(a|b|c)$"]` anchored-alternation selector from a value list. */
function highwaySelector(values: string[]): string {
    return `["highway"~"^(${values.join('|')})$"]`;
}

// OSM `highway` values that represent foot-first tracks/paths (walking away from roads). Kept
// narrow on purpose: this is "tracks", not the car road network (see STREET_HIGHWAYS).
const TRACK_HIGHWAYS = ['path', 'track', 'bridleway'];//, 'steps','footway', 'pedestrian'];

// OSM `highway` values that represent the drivable road network, plus their `_link` ramps and
// `living_street`. Excludes `service` (driveways/parking aisles) and `track` (a TRACK_HIGHWAY).
const STREET_HIGHWAYS = [
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
    'living_street', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
];

/** The registry, in overlay-stacking order (later = on top via higher zIndex). */
export const OSM_FEATURES: OsmFeatureDef[] = [
    {
        id: 'buildings', label: 'Buildings', noun: 'buildings', geometry: 'area', minPoints: 3,
        selector: '["building"]', strokeColor: '#1f77b4', fillColor: 'rgba(31, 119, 180, 0.35)',
        zIndex: 850, raise: 6, radius: 0,
    },
    {
        id: 'streets', label: 'Streets', noun: 'streets', geometry: 'line', minPoints: 2,
        selector: highwaySelector(STREET_HIGHWAYS), strokeColor: '#ff7f0e',
        zIndex: 880, raise: 2, radius: 12,
    },
    {
        id: 'tracks', label: 'Tracks', noun: 'tracks', geometry: 'line', minPoints: 2,
        selector: highwaySelector(TRACK_HIGHWAYS), strokeColor: '#d62728',
        zIndex: 900, raise: 2, radius: 10,
    },
];

export function osmFeature(id: string): OsmFeatureDef {
    const def = OSM_FEATURES.find(f => f.id === id);
    if (!def) throw new Error(`unknown OSM feature: ${id}`);
    return def;
}

/** Overpass QL for every way matching the feature's selector within the bbox, geometry inlined. */
export function buildQuery(def: OsmFeatureDef, bbox: BBox): string {
    const { south, west, north, east } = bbox;
    return `[out:json][timeout:25];
(
  way${def.selector}(${south},${west},${north},${east});
);
out geom;`;
}
