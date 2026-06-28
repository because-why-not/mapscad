import type { HeightGrid } from '../HeightSampler';
import { addSocket } from './geometry';

/**
 * Pluggable model processors, in three families that match the stages of MapModel:
 *
 *   ElevationGridProcessor — reshapes the WHOLE height grid (may change its dimensions:
 *     insert/drop rows & columns, crop, resample, composite extra sources). Runs first, so
 *     everything downstream sees the reshaped grid (e.g. TileDividerProcessor).
 *
 *   ElevationValueProcessor — transforms a height VALUE per grid cell, before any geometry
 *     exists. This is where elevation-domain tools live (vertical exaggeration, water
 *     cutoff, and future per-cell ops like "lower the terrain where a road is").
 *
 *   VertexProcessor — mutates the assembled mesh (vertices + triangles) of one solid, after
 *     the surface is built. This is where geometry-domain tools live (the socket; future
 *     ops like extruding building footprints).
 *
 * All are small, stateless-per-call, and ordered: MapModel runs the grid chain, then the
 * value chain into a processed height field, then the vertex chain on each emitted solid.
 * Custom processors implement the same interface and slot into the matching chain.
 */

// --- elevation grid stage ----------------------------------------------------

/** Reshapes the whole height grid before any per-cell value processing or geometry. Unlike
 *  ElevationValueProcessor it may change the grid's DIMENSIONS (insert/drop rows & columns,
 *  crop, resample, composite sources), so it runs first and the rest of the pipeline sees
 *  the result. */
export interface ElevationGridProcessor {
    readonly id: string;
    process(grid: HeightGrid): HeightGrid;
}

/**
 * Splits the grid into blocksX×blocksY printable tiles by injecting no-data (NaN) divider
 * lines, so the existing hole-carving emits each block as its own watertight body with walls.
 * The seam line is DUPLICATED on both sides of each divider (`duplicateSeam`) so neither block
 * loses the strip of surface at the cut — the dividers add separation, not data loss. The
 * metre extents grow with the inserted columns/rows so per-cell spacing (and thus the terrain
 * scale) is preserved; the gutters take real space rather than compressing the model.
 */
export class TileDividerProcessor implements ElevationGridProcessor {
    readonly id = 'tileDivider';
    constructor(private blocksX: number, private blocksY: number, private duplicateSeam = true) {}

    process(grid: HeightGrid): HeightGrid {
        const { heights, cols, rows } = grid;
        if (cols < 2 || rows < 2) return grid;
        const colPlan = this.axisPlan(cols, this.blocksX);
        const rowPlan = this.axisPlan(rows, this.blocksY);
        const newCols = colPlan.length, newRows = rowPlan.length;
        const out = new Float32Array(newCols * newRows);
        for (let nr = 0; nr < newRows; nr++) {
            const sr = rowPlan[nr];                // source row, or -1 for a divider line
            for (let nc = 0; nc < newCols; nc++) {
                const sc = colPlan[nc];            // source col, or -1 for a divider line
                out[nr * newCols + nc] = sr < 0 || sc < 0 ? NaN : heights[sr * cols + sc];
            }
        }
        // Keep per-cell metre spacing constant: the extra columns/rows add real width/height.
        const widthMeters = grid.widthMeters * (newCols - 1) / (cols - 1);
        const heightMeters = grid.heightMeters * (newRows - 1) / (rows - 1);
        return { ...grid, heights: out, cols: newCols, rows: newRows, widthMeters, heightMeters };
    }

    /** Output→source index map for one axis: a divider (-1) every `cut` cells, with the seam
     *  index duplicated on both sides of the gap so the cut loses no surface. Mirrors the
     *  reference `addGridToHeightMap` (import/StlMaker.ts). */
    private axisPlan(n: number, blocks: number): number[] {
        const cut = Math.max(1, Math.ceil(n / Math.max(1, blocks)));
        const plan: number[] = [];
        for (let i = 0; i < n; i++) {
            if (i > 0 && i % cut === 0) {
                if (this.duplicateSeam) plan.push(i); // copy of the seam before the gap
                plan.push(-1);                        // the no-data divider
            }
            plan.push(i);
        }
        return plan;
    }
}

// --- elevation value stage ---------------------------------------------------

/** Per-cell context handed to an ElevationValueProcessor. `raw` is the original sampled
 *  height (metres) so a processor can branch on the true elevation even after earlier
 *  processors have changed the running value (e.g. water keeps its cutoff on the
 *  un-exaggerated height). */
export interface ElevationContext {
    raw: number;
    col: number;
    row: number;
    cols: number;
    rows: number;
    grid: HeightGrid;
}

export interface ElevationValueProcessor {
    readonly id: string;
    /** Return the new height value (metres) for this cell. */
    process(value: number, ctx: ElevationContext): number;
}

/** Vertical exaggeration: scales the (running) height. Terrain only — water/socket stay
 *  literal metres, which is why water runs AFTER this in the default chain. */
export class HeightScaleProcessor implements ElevationValueProcessor {
    readonly id = 'heightScale';
    constructor(private scale: number) {}
    process(value: number): number {
        return value * this.scale;
    }
}

/** Flatten everything below `cutoff` (tested on the RAW height, so exaggeration can't move
 *  the waterline) to a fixed, literal `level`. */
export class WaterProcessor implements ElevationValueProcessor {
    readonly id = 'water';
    constructor(private cutoff: number, private level: number) {}
    process(value: number, ctx: ElevationContext): number {
        return ctx.raw < this.cutoff ? this.level : value;
    }
}

// --- vertex / mesh stage -----------------------------------------------------

/** A single solid under construction, handed to a VertexProcessor to mutate in place. */
export interface VertexMesh {
    positions: number[];   // x,y,z per vertex (metres)
    indices: number[];     // 3 per triangle
    tcols: number;         // grid dimensions of the open top surface (its first tcols*trows verts)
    trows: number;
    minY: number;          // lowest model-space surface across the whole model (socket floor anchor)
}

export interface VertexProcessor {
    readonly id: string;
    process(mesh: VertexMesh): void;
}

/** Close the open top surface into a watertight solid by adding a flat base + walls, with
 *  the floor `size` metres (literal, min `floorOffset`) below the lowest surface. */
export class SocketProcessor implements VertexProcessor {
    readonly id = 'socket';
    constructor(private size: number, private floorOffset: number) {}
    process(mesh: VertexMesh): void {
        const baseY = mesh.minY - Math.max(this.size, this.floorOffset);
        addSocket(mesh.positions, mesh.indices, mesh.tcols, mesh.trows, baseY);
    }
}
