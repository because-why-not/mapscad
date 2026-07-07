import { Env } from '../../Env';

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
    minStoredZoom?: number;   // lowest zoom the server actually has tiles for (below this => 404)
    tileFormat: string;       // 'png' | 'jpeg'
    tileSize?: number;
    tileCrs?: string;
    levels?: ManifestLevel[];
}

/** A run of text in an attribution line that may (or may not) link somewhere. */
export interface AttributionLink {
    text: string;
    url: string;
}

/**
 * Richer attribution shown at the top of the map menu for the selected source. The first three
 * fields are for quick, at-a-glance comparison between maps (who made it, where it lives, under
 * what license); `credit` is the official recommended attribution line (with its required links)
 * we must display to comply with the source's usage terms.
 */
export interface AttributionDetail {
    /** Who provides the map, e.g. "OpenTopoMap". */
    provider: string;
    /** The provider's homepage, shown as a link (e.g. opentopomap.org). */
    homepage: AttributionLink;
    /** The data/rendering license, e.g. "CC BY-SA 3.0", linking to the license text. */
    license: AttributionLink;
    /** The official recommended credit line, as inline text + link spans, rendered joined. */
    credit: (string | AttributionLink)[];
}

export interface ManifestMap {
    name: string;
    /** Human-readable display name with correct casing/spacing. Falls back to a prettified `name`
     *  when absent (the server manifest omits it). */
    prettyName?: string;
    attribution: string;
    /** Optional structured attribution for the menu; falls back to the plain `attribution` string
     *  when absent (e.g. self-hosted server maps). */
    attributionDetail?: AttributionDetail;
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
