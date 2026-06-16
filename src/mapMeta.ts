/** Generic (engine-independent) display helpers for map sources. */

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
