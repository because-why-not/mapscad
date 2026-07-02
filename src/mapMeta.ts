/** Generic (engine-independent) display helpers for map sources. */

// Self-hosted tile-server maps are namespaced with this prefix so their ids can't collide with
// the public sources (OpenStreetMap, Mapterhorn, …). The prefix is an implementation detail of
// the id — strip it for display and for deriving a map's menu group from its bare name.
export const LOCAL_MAP_PREFIX = 'local:';

export function stripLocalPrefix(name: string): string {
    return name.startsWith(LOCAL_MAP_PREFIX) ? name.slice(LOCAL_MAP_PREFIX.length) : name;
}

export function prettifyMapName(name: string): string {
    return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function iconForMapType(type: string): string {
    switch (type) {
        case 'topo':
        case 'hillshade':
            return '⛰️';
        case 'aerial':
        case 'aerial-contour':
            return '🛰️';
        case 'elevation':
            return '🗻';
        default:
            return '🗺️';
    }
}
