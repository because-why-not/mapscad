import XYZ from 'ol/source/XYZ';
import RasterSource from 'ol/source/Raster';
import type { ManifestMap } from '../maptiles/TileMapManifest';

// Fixed sun for the static 2D shaded relief: top-left light at 45°, the usual
// cartographic convention. (The 2D map has no sun controls — that's the 3D engine.)
const SUN_AZIMUTH = 315;
const SUN_ELEVATION = 45;
const VERT_EXAGGERATION = 2;

/**
 * Per-pixel shaded-relief operation. Runs in OpenLayers' raster Web Worker, so it must
 * be fully self-contained — it may not reference anything outside its own body (module
 * constants, imports, etc.), since OL stringifies it to ship it to the worker. Decodes
 * terrarium elevation from the input DEM image (R*256 + G + B/256 - 32768) and lights it
 * from the sun passed in via `data`. Adapted from OpenLayers' shaded-relief example.
 */
function shade(inputs: ImageData[], data: any): { data: Uint8ClampedArray; width: number; height: number } {
    const elevation = inputs[0];
    const width = elevation.width;
    const height = elevation.height;
    const px = elevation.data;
    const out = new Uint8ClampedArray(px.length);
    const dp = data.resolution * 2;
    const maxX = width - 1;
    const maxY = height - 1;
    const twoPi = 2 * Math.PI;
    const halfPi = Math.PI / 2;
    const sunEl = (Math.PI * data.sunEl) / 180;
    const sunAz = (Math.PI * data.sunAz) / 180;
    const cosSunEl = Math.cos(sunEl);
    const sinSunEl = Math.sin(sunEl);
    const decode = (o: number) => px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768;
    for (let y = 0; y <= maxY; ++y) {
        const y0 = y === 0 ? 0 : y - 1;
        const y1 = y === maxY ? maxY : y + 1;
        for (let x = 0; x <= maxX; ++x) {
            const x0 = x === 0 ? 0 : x - 1;
            const x1 = x === maxX ? maxX : x + 1;
            const zWest = data.vert * decode((y * width + x0) * 4);
            const zEast = data.vert * decode((y * width + x1) * 4);
            const zNorth = data.vert * decode((y0 * width + x) * 4);
            const zSouth = data.vert * decode((y1 * width + x) * 4);
            const dzdx = (zEast - zWest) / dp;
            const dzdy = (zSouth - zNorth) / dp;
            const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
            let aspect = Math.atan2(dzdy, -dzdx);
            if (aspect < 0) aspect = halfPi - aspect;
            else if (aspect > halfPi) aspect = twoPi - aspect + halfPi;
            else aspect = halfPi - aspect;
            const cosIncidence = sinSunEl * Math.cos(slope) + cosSunEl * Math.sin(slope) * Math.cos(sunAz - aspect);
            const o = (y * width + x) * 4;
            const lum = 255 * cosIncidence;
            out[o] = lum;
            out[o + 1] = lum;
            out[o + 2] = lum;
            out[o + 3] = px[o + 3]; // keep the DEM's alpha → no-data tiles stay transparent
        }
    }
    return { data: out, width, height };
}

/**
 * An OpenLayers raster source that renders a live 2D hillshade from a terrarium DEM. The
 * DEM tiles are the worker's input; the sun + exaggeration are injected per render.
 */
export function buildHillshadeSource(dem: ManifestMap): RasterSource {
    const elevation = new XYZ({
        url: dem.tiles[0],
        maxZoom: dem.maxzoom,
        tileSize: dem.mmapsrv.tileSize ?? 256,
        crossOrigin: 'anonymous',
        attributions: dem.attribution || undefined,
        // Sample the DEM nearest-neighbour: bilinear smoothing of terrarium-ENCODED bytes
        // is invalid (G wraps 255→0 with an R carry every 1m), and blending across those
        // wraps produces elevation spikes that show up as contour-line artifacts — most
        // visible while placeholder/overzoom tiles are being resampled during load.
        interpolate: false,
    });
    const raster = new RasterSource({
        sources: [elevation],
        operationType: 'image',
        operation: shade as any,
    });
    raster.on('beforeoperations', (event: any) => {
        event.data.resolution = event.resolution;
        event.data.vert = VERT_EXAGGERATION;
        event.data.sunAz = SUN_AZIMUTH;
        event.data.sunEl = SUN_ELEVATION;
    });
    return raster;
}
