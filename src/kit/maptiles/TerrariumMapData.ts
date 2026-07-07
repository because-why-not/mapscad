/**
 * Decoded view over a block of terrarium-encoded DEM pixels. Holds the raw RGBA raster (by
 * reference — no copy) plus the global-pixel origin/zoom it was downloaded at, and turns a
 * pixel into an elevation in metres. This is the ONLY place the terrarium formula lives for
 * the export/preview pipeline; it is pure (no DOM, no network) so it unit-tests trivially.
 */

/** A composited block of RGBA tile pixels and where it sits in global pixel space. */
export interface RawRaster {
    data: Uint8ClampedArray;  // RGBA, row-major, length width*height*4
    width: number;
    height: number;
    originX: number;          // global pixel x of this raster's column 0 (a tile boundary)
    originY: number;
    zoom: number;             // DEM tile zoom the pixels were fetched at
    tileSize: number;         // source pixels per tile (256, or 512 for Mapterhorn)
}

export class TerrariumMapData {
    readonly width: number;
    readonly height: number;
    readonly originX: number;
    readonly originY: number;
    readonly zoom: number;
    readonly tileSize: number;
    private readonly data: Uint8ClampedArray;

    constructor(raster: RawRaster) {
        this.data = raster.data;
        this.width = raster.width;
        this.height = raster.height;
        this.originX = raster.originX;
        this.originY = raster.originY;
        this.zoom = raster.zoom;
        this.tileSize = raster.tileSize;
    }

    /** Tiles fetched across / down (for memory accounting). */
    get tilesX(): number { return Math.round(this.width / this.tileSize); }
    get tilesY(): number { return Math.round(this.height / this.tileSize); }

    /**
     * Elevation in metres at an integer GLOBAL pixel, clamped to this raster's bounds, or
     * NaN for no-data (a fully transparent pixel = a missing tile). Terrarium decode:
     * `R*256 + G + B/256 - 32768`.
     */
    heightAtPixel(gx: number, gy: number): number {
        const W = this.width, H = this.height;
        let x = gx - this.originX;
        let y = gy - this.originY;
        x = x < 0 ? 0 : x > W - 1 ? W - 1 : x;
        y = y < 0 ? 0 : y > H - 1 ? H - 1 : y;
        const i = (y * W + x) * 4;
        const d = this.data;
        if (d[i + 3] === 0) return NaN;            // alpha 0 => no tile / no data
        return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
    }
}
