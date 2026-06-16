import { Env } from './Env';

/**
 * TileJSON 3.0.0 manifest served by the tile server at `${tileServerPrefix}/maps`,
 * extended with an `mmapsrv` block describing server-side specifics.
 */

export interface ManifestLevel {
    factor: number;
    pixelSizeM: number;
    cellSizeM: number;
    nativeZoom: number;
    cellCount: number;
}

export interface MmapSrv {
    type: string;            // 'street' | 'topo' | 'aerial' | 'aerial-contour' | 'hillshade' | ...
    proxy: boolean;          // true => proxied public upstream (rate-limit, single-stream download)
    downloadable?: boolean;
    minDownloadZoom?: number; // lowest zoom with natively stored tiles (== floor of coarsest level)
    tileFormat: string;       // 'png' | 'jpeg'
    tileSize?: number;
    tileCrs?: string;
    levels?: ManifestLevel[];
}

export interface ManifestMap {
    name: string;
    attribution: string;
    tiles: string[];          // URL templates, e.g. ".../{z}/{x}/{y}.jpg"
    minzoom: number;
    maxzoom: number;
    bounds?: number[];
    center?: number[];
    mmapsrv: MmapSrv;
}

export interface TileMapManifest {
    tileSize: number;
    tileCrs: string;
    maps: ManifestMap[];
}

/**
 * Fetch the list of maps advertised by the tile server.
 * Returns an empty array on any failure (e.g. offline) so callers can fall back
 * to the hardcoded provider list without special-casing.
 */
export async function fetchTileMapManifest(): Promise<ManifestMap[]> {
    const url = `${Env.tileServerPrefix}/maps`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            Env.warn(`Tile map manifest fetch failed: HTTP ${res.status}`);
            return [];
        }
        const data: TileMapManifest = await res.json();
        return data.maps ?? [];
    } catch (e) {
        Env.warn('Tile map manifest unavailable (offline?):', e);
        return [];
    }
}
