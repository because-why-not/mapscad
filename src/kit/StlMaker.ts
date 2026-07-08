import type { MapModel, ModelGeometry, ModelBody } from './MapModel';

/**
 * Serialises a MapModel's neutral geometry to a single binary STL. It does no geometry math
 * of its own — it consumes exactly the same buffers the preview renders, so what you see is
 * what you export. Tiling now produces one solid whose blocks are disconnected bodies (the
 * tile dividers separate them), so the whole model is written to one file; a slicer can
 * "split to objects" to print/colour each body separately.
 */

/** Build the model and serialise it to binary-STL bytes — the pure, headless-safe half of the
 *  export (no DOM). Null when there is no geometry to write. */
export function modelToStlBytes(model: MapModel): ArrayBuffer | null {
    const geo = model.buildGeometry();
    if (!geo || geo.bodies.length === 0) return null;
    return geometryToBinaryStl(geo.bodies);
}

export function exportModelStl(model: MapModel, baseName = 'mapscad'): void {
    const bytes = modelToStlBytes(model);
    if (!bytes) return;
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    download(blob, `${baseName}.stl`);
}

/** Total triangles that would be written (handy for memory/UI checks before export). */
export function triangleCount(geo: ModelGeometry): number {
    return geo.triangleCount;
}

/** All bodies concatenated into one binary STL — each body keeps its own (disconnected)
 *  triangles, so distinct bodies survive as distinct components in the single file. */
function geometryToBinaryStl(bodies: ModelBody[]): ArrayBuffer {
    let triCount = 0;
    for (const b of bodies) triCount += b.indices.length / 3;

    const buffer = new ArrayBuffer(80 + 4 + triCount * 50); // header + count + 50B/tri
    const view = new DataView(buffer);
    view.setUint32(80, triCount, true);

    let offset = 84;
    for (const { positions, indices } of bodies) {
        const tris = indices.length / 3;
        for (let t = 0; t < tris; t++) {
            const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
            const n = unitNormal(positions, ia, ib, ic);
            view.setFloat32(offset, n.x, true);
            view.setFloat32(offset + 4, n.y, true);
            view.setFloat32(offset + 8, n.z, true);
            offset += 12;
            for (const idx of [ia, ib, ic]) {
                view.setFloat32(offset, positions[idx * 3], true);
                view.setFloat32(offset + 4, positions[idx * 3 + 1], true);
                view.setFloat32(offset + 8, positions[idx * 3 + 2], true);
                offset += 12;
            }
            view.setUint16(offset, 0, true); // attribute byte count
            offset += 2;
        }
    }
    return buffer;
}

function unitNormal(p: Float32Array, a: number, b: number, c: number): { x: number; y: number; z: number } {
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
    const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
}

function download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
