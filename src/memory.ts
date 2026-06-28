/**
 * Central, authoritative memory accounting for the 3D preview / export. Estimates are
 * derived from known buffer sizes (not the unreliable `performance.memory`), so future
 * settings (e.g. a high heightmap zoom over a large region) can be checked against a
 * budget BEFORE they're built and risk crashing the tab.
 */

const BYTES_PER_FLOAT = 4;
const TILE = 256;

// Soft ceiling for a single mesh + its DEM working set. Conservative: browsers vary,
// and there's also the renderer's own overhead on top of this.
export const MEMORY_BUDGET_BYTES = 1_200 * 1024 * 1024; // ~1.2 GB

export interface MemoryParams {
    cols: number;
    rows: number;
    tilesX: number;
    tilesY: number;
}

export interface MemoryEstimate {
    geometryBytes: number;  // Three.js position + normal + index buffers
    heightBytes: number;    // the sampled Float32Array
    tileBytes: number;      // the assembled DEM canvas (RGBA)
    totalBytes: number;
}

/** Geometry buffer bytes for a vertex/triangle count: position(3)+normal(3) floats per vertex,
 *  uint32 index (3 per triangle). The single formula both the prediction and the measurement use. */
export function geometryBytes(vertices: number, triangles: number): number {
    return vertices * (3 + 3) * BYTES_PER_FLOAT + triangles * 3 * 4;
}

/**
 * PREDICTIVE estimate from grid dimensions alone — used to gate a selection against the budget
 * BEFORE anything is sampled or built (there's no mesh yet). Assumes the dense shared-vertex
 * sheet; the real mesh (holes, oval, tiling, socket) differs, so use `measureMemory` once built.
 */
export function estimateMemory({ cols, rows, tilesX, tilesY }: MemoryParams): MemoryEstimate {
    const verts = cols * rows;
    const tris = Math.max(0, cols - 1) * Math.max(0, rows - 1) * 2;
    const geom = geometryBytes(verts, tris);
    const heightBytes = verts * BYTES_PER_FLOAT;
    const tileBytes = tilesX * TILE * tilesY * TILE * 4;
    return { geometryBytes: geom, heightBytes, tileBytes, totalBytes: geom + heightBytes + tileBytes };
}

/**
 * REALISTIC measurement once the geometry exists: geometry bytes from the ACTUAL built mesh
 * (post weld/holes/tiling/socket), height bytes from the retained sampled grid, tile bytes
 * from the DEM working set. This is what the overlay should show.
 */
export function measureMemory(
    geo: { vertexCount: number; triangleCount: number },
    grid: { cols: number; rows: number; tilesX: number; tilesY: number },
): MemoryEstimate {
    const geom = geometryBytes(geo.vertexCount, geo.triangleCount);
    const heightBytes = grid.cols * grid.rows * BYTES_PER_FLOAT;
    const tileBytes = grid.tilesX * TILE * grid.tilesY * TILE * 4;
    return { geometryBytes: geom, heightBytes, tileBytes, totalBytes: geom + heightBytes + tileBytes };
}

export type MemoryLevel = 'ok' | 'warn' | 'high';

export function memoryLevel(totalBytes: number): MemoryLevel {
    if (totalBytes > MEMORY_BUDGET_BYTES) return 'high';
    if (totalBytes > MEMORY_BUDGET_BYTES * 0.6) return 'warn';
    return 'ok';
}

export function isOverBudget(totalBytes: number): boolean {
    return totalBytes > MEMORY_BUDGET_BYTES;
}

export function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
}
