import type { ManifestMap } from './TileMapManifest';
import type { LonLat } from './SelectionArea';
import { lonLatToWorldPx, sampleHeights, type HeightGrid } from './dem/Sampler';
import { TerrariumMapData } from './dem/TerrariumMapData';
import { downloadRaster, type DownloadOptions } from './dem/TileDownloader';
import { DEFAULT_TILE_SIZE, haversine, groundResolution } from './MathHelper';

/**
 * Orchestrates the DEM height pipeline: it owns the geometry (which tiles a selection
 * covers at a zoom) and ties the three stages together —
 *
 *   TileDownloader   fetches + composites tiles      -> RawRaster   (I/O, src/dem)
 *   TerrariumMapData decodes a pixel to metres       -> height      (pure,  src/dem)
 *   Sampler          bilinear-samples over the grid  -> HeightGrid  (pure,  src/dem)
 *
 * The grid resolution (cols × rows) is independent of any map zoom: it's whatever detail
 * the caller asks for, which is what lets the export be denser/coarser than the screen.
 */

export type { HeightGrid };
export type SampleOptions = DownloadOptions;

const TILE = DEFAULT_TILE_SIZE;

/** Real-world width (TL→TR) and height (TL→BL) of the selection rectangle, in metres. */
export function rectExtent(corners: LonLat[]): { widthMeters: number; heightMeters: number } {
    return {
        widthMeters: haversine(corners[0], corners[1]),
        heightMeters: haversine(corners[0], corners[3]),
    };
}

/** Clamp a requested zoom to what the DEM actually stores. */
function storedZoom(dem: ManifestMap, zoom: number): number {
    const minStored = dem.mmapsrv.minStoredZoom ?? dem.minzoom;
    return Math.max(minStored, Math.min(dem.maxzoom, Math.round(zoom)));
}

/** The tile range (across × down) a selection covers at a given zoom. */
export function tileCoverage(corners: LonLat[], dem: ManifestMap, zoom: number): { z: number; tilesX: number; tilesY: number } {
    const tileSize = dem.mmapsrv.tileSize ?? TILE;
    const z = storedZoom(dem, zoom);
    const cornerPx = corners.map(c => lonLatToWorldPx(c[0], c[1], z, tileSize));
    const tx0 = Math.floor(Math.min(...cornerPx.map(p => p[0])) / tileSize);
    const tx1 = Math.floor(Math.max(...cornerPx.map(p => p[0])) / tileSize);
    const ty0 = Math.floor(Math.min(...cornerPx.map(p => p[1])) / tileSize);
    const ty1 = Math.floor(Math.max(...cornerPx.map(p => p[1])) / tileSize);
    return { z, tilesX: tx1 - tx0 + 1, tilesY: ty1 - ty0 + 1 };
}

/**
 * @param corners selection rectangle as lon/lat, order TL, TR, BR, BL
 * @param dem     terrarium DEM manifest entry (tiles[0] is the {z}/{x}/{y} template)
 * @param cols    number of samples across the width
 * @param rows    number of samples down the height
 */
export async function sampleSelectionHeights(
    corners: LonLat[], dem: ManifestMap, cols: number, rows: number, zoom: number,
    opts: SampleOptions = {},
): Promise<HeightGrid> {
    const tileSize = dem.mmapsrv.tileSize ?? TILE;
    const { widthMeters, heightMeters } = rectExtent(corners);
    const z = storedZoom(dem, zoom);

    // Pixel bbox of the rectangle at this zoom, then the covering tile range.
    const cornerPx = corners.map(c => lonLatToWorldPx(c[0], c[1], z, tileSize));
    const tx0 = Math.floor(Math.min(...cornerPx.map(p => p[0])) / tileSize);
    const tx1 = Math.floor(Math.max(...cornerPx.map(p => p[0])) / tileSize);
    const ty0 = Math.floor(Math.min(...cornerPx.map(p => p[1])) / tileSize);
    const ty1 = Math.floor(Math.max(...cornerPx.map(p => p[1])) / tileSize);

    const raster = await downloadRaster(dem.tiles[0], { z, tileSize, tx0, tx1, ty0, ty1 }, opts);
    const data = new TerrariumMapData(raster);
    return sampleHeights(corners, data, cols, rows, widthMeters, heightMeters);
}
