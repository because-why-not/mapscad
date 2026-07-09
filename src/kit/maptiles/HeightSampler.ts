import type { ManifestMap } from './TileMapManifest';
import { sampleHeights, type HeightGrid } from './Sampler';
import { TerrariumMapData } from './TerrariumMapData';
import { downloadRaster, type DownloadOptions } from './TileDownloader';
import { DEFAULT_TILE_SIZE, haversine, groundResolution, zoomForResolution, lonLatToWorldPx, type LonLat } from '../common/mathHelper';

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

/** Real-world width (SW→SE, the south edge) and height (SW→NW, the west edge) of the selection
 *  rectangle, in metres. Corners are ordered SW, SE, NE, NW. */
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

/** Heightmap zoom range a DEM supports: lowest stored level to its native max. */
export function demZoomRange(dem: ManifestMap | undefined): { min: number; max: number } {
    if (!dem) return { min: 0, max: 17 };
    return { min: dem.mmapsrv.minStoredZoom ?? dem.minzoom, max: dem.maxzoom };
}

/**
 * Zoom slider range + default for a selection, derived from the resolution the mesh will
 * actually use. The grid is capped to `raster` samples on its long side, so its finest useful
 * sample spacing is longSideMetres / raster; the (fractional) DEM zoom matching that spacing is
 * the "natural" zoom — beyond it, finer tiles only add detail the grid discards (slower, and
 * harder on the external tile servers). We round the natural zoom UP, then:
 *   - `max`: one level finer than that (a little bilinear headroom) — the user can't pick higher.
 *   - `def`: one level coarser — the preview opens fast and light.
 * Both clamped to the zooms the DEM actually stores.
 */
export function resolutionZoomRange(corners: LonLat[], dem: ManifestMap, raster: number): { min: number; max: number; def: number } {
    const { min: dMin, max: dMax } = demZoomRange(dem);
    const { widthMeters, heightMeters } = rectExtent(corners);
    const longSide = Math.max(widthMeters, heightMeters);
    // The zoom at which one DEM pixel ≈ one raster cell — the natural match. Above it the DEM is
    // finer than the grid can hold (wasted downloads); below it the grid interpolates the DEM.
    const natural = Math.ceil(zoomForResolution(corners[0][1], longSide / raster, dem.mmapsrv.tileSize));
    const max = Math.min(dMax, natural + 1);
    const def = Math.max(dMin, Math.min(max, natural - 1));
    return { min: dMin, max, def };
}

/** Model grid size: exactly `raster` samples on the long side, the short side scaled to the
 *  selection's aspect ratio. Independent of the DEM zoom — the DEM is bilinearly sampled (and
 *  interpolated when it's coarser) to fill this grid, so the raster resolution alone sets mesh
 *  density. That lets OSM feature bodies carry finer detail than the heightmap provides. */
export function gridResolution(corners: LonLat[], raster: number): { cols: number; rows: number } {
    const { widthMeters, heightMeters } = rectExtent(corners);
    const long = Math.max(widthMeters, heightMeters);
    const cols = Math.max(2, Math.round(raster * widthMeters / long));
    const rows = Math.max(2, Math.round(raster * heightMeters / long));
    return { cols, rows };
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
 * @param corners selection rectangle as lon/lat, order SW, SE, NE, NW (corner[0] = south-west)
 * @param dem     terrarium DEM manifest entry (tiles[0] is the {z}/{x}/{y} template)
 * @param cols    number of samples across the width (west→east)
 * @param rows    number of samples down the height (south→north; row 0 = the south edge)
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
