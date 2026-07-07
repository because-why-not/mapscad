// Tiling must reshape the OSM coverage rasters together with the terrain grid, so a feature body
// rides on the relocated tiles and splits at the same cuts. Before the fix the feature was built
// against the pre-tiling grid, so it floated over the compressed original extent instead of the
// spread-apart tiles. We drive `buildModelGeometry` directly (no DOM) with a hand-made coverage.
import { describe, it, expect } from 'vitest';
import { buildModelGeometry, type OsmBody } from '../../src/kit/model/buildGeometry';
import { DEFAULT_MODEL_SETTINGS, SelectionShape, type ModelSettings } from '../../src/kit/MapModel';
import type { HeightGrid } from '../../src/kit/maptiles/HeightSampler';

function flatGrid(cols: number, rows: number, w = 60, h = 30): HeightGrid {
    const heights = new Float32Array(cols * rows); // all 0
    return { heights, cols, rows, widthMeters: w, heightMeters: h, minHeight: 0, maxHeight: 0, zoom: 14, tilesX: 1, tilesY: 1 };
}

function settings(over: Partial<ModelSettings>): ModelSettings {
    return { ...DEFAULT_MODEL_SETTINGS, ...over };
}

// Count disconnected components of a welded body by unioning vertices that share a triangle,
// keyed on rounded position (the mesh is a shared-index solid after weldIndexed).
function components(positions: Float32Array, indices: Uint32Array): number {
    const key = (i: number) => `${positions[i * 3].toFixed(3)},${positions[i * 3 + 1].toFixed(3)},${positions[i * 3 + 2].toFixed(3)}`;
    const parent = new Map<string, string>();
    const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
    const add = (k: string) => { if (!parent.has(k)) parent.set(k, k); };
    const union = (a: string, b: string) => { add(a); add(b); parent.set(find(a), find(b)); };
    for (let t = 0; t < indices.length; t += 3) {
        const a = key(indices[t]), b = key(indices[t + 1]), c = key(indices[t + 2]);
        union(a, b); union(b, c);
    }
    const roots = new Set<string>();
    for (const k of parent.keys()) roots.add(find(k));
    return roots.size;
}

// A feature covering the whole grid (coverage 1 everywhere) with a positive raise.
function fullCoverage(cols: number, rows: number): OsmBody {
    return { id: 'streets', coverage: new Float32Array(cols * rows).fill(1), raise: 5 };
}

describe('tiling reshapes OSM coverage with the terrain', () => {
    it('splits a full-coverage feature into the same number of tiles as the terrain (2×1)', () => {
        const grid = flatGrid(4, 3);
        const s = settings({ tilesEnabled: true, tilesX: 2, tilesY: 1, socketEnabled: true, socketSize: 2 });
        const geo = buildModelGeometry({ grid, settings: s, osmBodies: [fullCoverage(4, 3)] });

        const terrain = geo.bodies.filter(b => b.kind === 'terrain');
        const feature = geo.bodies.filter(b => b.kind === 'streets');
        expect(terrain).toHaveLength(1);
        expect(feature).toHaveLength(1);
        // Terrain is one solid whose disconnected blocks are the 2 tiles; the feature body follows.
        expect(components(terrain[0].positions, terrain[0].indices)).toBe(2);
        expect(components(feature[0].positions, feature[0].indices)).toBe(2);
    });

    it('the feature spans the GROWN metre extent (co-registered with the relocated tiles)', () => {
        const grid = flatGrid(4, 3, 60, 30);
        const noTiles = buildModelGeometry({ grid, settings: settings({}), osmBodies: [fullCoverage(4, 3)] });
        const tiled = buildModelGeometry(
            { grid, settings: settings({ tilesEnabled: true, tilesX: 2, tilesY: 1 }), osmBodies: [fullCoverage(4, 3)] });

        const spanX = (b: { positions: Float32Array }) => {
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < b.positions.length; i += 3) { lo = Math.min(lo, b.positions[i]); hi = Math.max(hi, b.positions[i]); }
            return hi - lo;
        };
        const featUntiled = noTiles.bodies.find(b => b.kind === 'streets')!;
        const featTiled = tiled.bodies.find(b => b.kind === 'streets')!;
        // Tiling grows the width (4 cols → 6), so the feature now reaches the wider terrain, not the
        // old compressed extent it used to float over.
        expect(spanX(featTiled)).toBeGreaterThan(spanX(featUntiled));
    });
});

describe('oval selection clips OSM feature bodies to the footprint', () => {
    it('masks a full-coverage feature to the ellipse — it does NOT run out over the cut-off corners', () => {
        const grid = flatGrid(9, 9, 80, 80);
        const rect = buildModelGeometry({ grid, settings: settings({}), osmBodies: [fullCoverage(9, 9)] });
        const oval = buildModelGeometry(
            { grid, settings: settings({ shape: SelectionShape.Oval }), osmBodies: [fullCoverage(9, 9)] });

        const rectFeat = rect.bodies.find(b => b.kind === 'streets')!;
        const ovalFeat = oval.bodies.find(b => b.kind === 'streets')!;
        // The oval mask drops the corner cells, so the clipped feature has fewer vertices than the
        // full-rectangle one (the bug: it used to keep the whole rectangle).
        expect(ovalFeat.positions.length).toBeLessThan(rectFeat.positions.length);
        // No feature vertex may sit in a cut-off corner (both |x| and |z| near the half-extent — well
        // outside the inscribed ellipse). The rectangle feature does reach those corners.
        const halfX = grid.widthMeters / 2, halfZ = grid.heightMeters / 2;
        const reachesCorner = (b: { positions: Float32Array }) => {
            for (let i = 0; i < b.positions.length; i += 3) {
                if (Math.abs(b.positions[i]) > halfX * 0.9 && Math.abs(b.positions[i + 2]) > halfZ * 0.9) return true;
            }
            return false;
        };
        expect(reachesCorner(rectFeat)).toBe(true);
        expect(reachesCorner(ovalFeat)).toBe(false);
    });
});
