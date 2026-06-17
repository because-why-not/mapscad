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

export function estimateMemory({ cols, rows, tilesX, tilesY }: MemoryParams): MemoryEstimate {
    const verts = cols * rows;
    const tris = Math.max(0, cols - 1) * Math.max(0, rows - 1) * 2;
    // position(3) + normal(3) floats per vertex, uint32 index (3 per triangle).
    const geometryBytes = verts * (3 + 3) * BYTES_PER_FLOAT + tris * 3 * 4;
    const heightBytes = verts * BYTES_PER_FLOAT;
    const tileBytes = tilesX * TILE * tilesY * TILE * 4;
    return { geometryBytes, heightBytes, tileBytes, totalBytes: geometryBytes + heightBytes + tileBytes };
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
