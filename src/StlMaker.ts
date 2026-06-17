import type { MapModel, ModelGeometry, ModelTile } from './MapModel';

/**
 * Serialises a MapModel's neutral geometry to binary STL. It does no geometry math of
 * its own — it consumes exactly the same buffers the preview renders, so what you see is
 * what you export. When the model is split into tiles, each tile is written as its own
 * file so it can be printed individually.
 */

export function exportModelStl(model: MapModel, baseName = 'mapscad'): void {
    const geo = model.buildGeometry();
    if (!geo || geo.tiles.length === 0) return;
    const multi = geo.tiles.length > 1;
    for (const tile of geo.tiles) {
        const blob = new Blob([tileToBinaryStl(tile)], { type: 'application/octet-stream' });
        const suffix = multi ? `_${tile.ix0}_${tile.iy0}` : '';
        download(blob, `${baseName}${suffix}.stl`);
    }
}

/** Total triangles that would be written (handy for memory/UI checks before export). */
export function triangleCount(geo: ModelGeometry): number {
    return geo.triangleCount;
}

function tileToBinaryStl({ positions, indices }: ModelTile): ArrayBuffer {
    const triCount = indices.length / 3;
    const buffer = new ArrayBuffer(80 + 4 + triCount * 50); // header + count + 50B/tri
    const view = new DataView(buffer);
    view.setUint32(80, triCount, true);

    let offset = 84;
    for (let t = 0; t < triCount; t++) {
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
