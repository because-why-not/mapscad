import { describe, it, expect } from 'vitest';
import { weldIndexed } from '../../src/model/geometry';

describe('weldIndexed', () => {
    it('collapses coincident vertices and remaps the triangles to them', () => {
        // Two triangles forming a quad, emitted as soup: the shared edge (1,0,0)+(0,1,0)
        // is duplicated, so there are 6 vertices for 4 distinct positions.
        const positions = [
            0, 0, 0, 1, 0, 0, 0, 1, 0, // tri A
            1, 0, 0, 1, 1, 0, 0, 1, 0, // tri B (reuses (1,0,0) and (0,1,0))
        ];
        const indices = [0, 1, 2, 3, 4, 5];
        const w = weldIndexed(positions, indices);
        expect(w.positions.length / 3).toBe(4);   // 4 unique positions
        expect(w.indices.length).toBe(6);          // both triangles preserved
        // Index 3 (a duplicate of vertex 1) must remap to the same id as vertex 1.
        expect(w.indices[3]).toBe(w.indices[1]);
    });

    it('leaves an already-unique mesh unchanged in count and order', () => {
        const positions = [0, 0, 0, 2, 0, 0, 0, 2, 0];
        const w = weldIndexed(positions, [0, 1, 2]);
        expect(w.positions.length / 3).toBe(3);
        expect([...w.indices]).toEqual([0, 1, 2]);
    });
});
