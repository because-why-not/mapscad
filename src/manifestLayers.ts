import TileLayer from 'ol/layer/Tile';
import XYZ from 'ol/source/XYZ';
import type { ManifestMap } from './TileMapManifest';

export interface LayerEntry {
    id: string;          // ManifestMap.name
    name: string;        // prettified display name
    icon: string;        // emoji by map type
    layer: TileLayer<XYZ>;
}

// Highest zoom the view allows; above the source's native maxzoom OpenLayers upscales tiles (overzoom).
const VIEW_MAX_ZOOM = 22;

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
        default:
            return '🗺️';
    }
}

export function layerFromManifest(map: ManifestMap): LayerEntry {
    const source = new XYZ({
        url: map.tiles[0],                          // template already contains {z}/{x}/{y}
        maxZoom: map.maxzoom,                        // native max; OL overzooms beyond this
        tileSize: map.mmapsrv.tileSize ?? 256,
        attributions: map.attribution || undefined,
        crossOrigin: 'anonymous',
    });
    const layer = new TileLayer({ source, visible: false });
    return {
        id: map.name,
        name: prettifyMapName(map.name),
        icon: iconForMapType(map.mmapsrv.type),
        layer,
    };
}

export { VIEW_MAX_ZOOM };
