import type { HeightGrid } from '../HeightSampler';
import { addSocket } from './geometry';

/**
 * Pluggable model processors, in two families that match the two stages of MapModel:
 *
 *   ElevationProcessor — transforms a height VALUE per grid cell, before any geometry
 *     exists. This is where elevation-domain tools live (vertical exaggeration, water
 *     cutoff, and future per-cell ops like "lower the terrain where a road is").
 *
 *   VertexProcessor — mutates the assembled mesh (vertices + triangles) of one solid, after
 *     the surface is built. This is where geometry-domain tools live (the socket; future
 *     ops like extruding building footprints).
 *
 * Both are small, stateless-per-call, and ordered: MapModel runs the elevation chain to
 * build a processed height field, then the vertex chain on each emitted solid. Custom
 * processors implement the same interface and slot into either chain.
 */

// --- elevation stage ---------------------------------------------------------

/** Per-cell context handed to an ElevationProcessor. `raw` is the original sampled height
 *  (metres) so a processor can branch on the true elevation even after earlier processors
 *  have changed the running value (e.g. water keeps its cutoff on the un-exaggerated height). */
export interface ElevationContext {
    raw: number;
    col: number;
    row: number;
    cols: number;
    rows: number;
    grid: HeightGrid;
}

export interface ElevationProcessor {
    readonly id: string;
    /** Return the new height value (metres) for this cell. */
    process(value: number, ctx: ElevationContext): number;
}

/** Vertical exaggeration: scales the (running) height. Terrain only — water/socket stay
 *  literal metres, which is why water runs AFTER this in the default chain. */
export class HeightScaleProcessor implements ElevationProcessor {
    readonly id = 'heightScale';
    constructor(private scale: number) {}
    process(value: number): number {
        return value * this.scale;
    }
}

/** Flatten everything below `cutoff` (tested on the RAW height, so exaggeration can't move
 *  the waterline) to a fixed, literal `level`. */
export class WaterProcessor implements ElevationProcessor {
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
