/**
 * Pure pixels→heights step shared by the canvas-based grid processors (tracks, buildings): add a
 * signed, whole-metre height delta to each cell from a painted coverage raster. `image` is RGBA
 * bytes (row-major, length `heights.length * 4`); the red channel is the coverage (0..255 → 0..1).
 * The delta is `round(raise · coverage)`, so:
 *   - white (255) → +raise (or −|raise| when `raise` is negative — carving), rounded to 1 m;
 *   - black (0)   → unchanged;
 *   - no-data (NaN) cells are left as holes.
 */
export function addRasterRaise(image: Uint8ClampedArray, heights: Float32Array, raise: number): Float32Array {
    const out = new Float32Array(heights);
    for (let i = 0; i < out.length; i++) {
        if (Number.isNaN(out[i])) continue;          // leave no-data holes alone
        const coverage = image[i * 4] / 255;         // red channel; black=0 … white=1
        const delta = Math.round(raise * coverage);  // signed, rounded to whole metres
        if (delta !== 0) out[i] += delta;
    }
    return out;
}

/**
 * As `addRasterRaise`, but from a pre-decoded `cols × rows` coverage mask (0..1) instead of RGBA
 * bytes. Used for OSM features set to "raise the terrain" rather than emit a separate body: the same
 * coverage the separate-body path drapes is instead folded into the surface here. Returns a NEW array
 * (never mutates `heights`, which may be the model's own grid).
 */
export function addCoverageRaise(heights: Float32Array, coverage: Float32Array, raise: number): Float32Array {
    const out = new Float32Array(heights);
    for (let i = 0; i < out.length; i++) {
        if (Number.isNaN(out[i])) continue;              // leave no-data holes alone
        const delta = Math.round(raise * coverage[i]);   // signed, rounded to whole metres
        if (delta !== 0) out[i] += delta;
    }
    return out;
}
