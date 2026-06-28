/** Low-level mesh helpers shared by MapModel and the vertex processors. Pure functions over
 *  flat `positions` (x,y,z per vertex) + `indices` (3 per triangle) arrays. */

/** Unnormalised face normal of triangle (a,b,c) from a flat positions array. */
export function triNormal(p: number[], a: number, b: number, c: number): { x: number; y: number; z: number } {
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
    const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
    return { x: uy * vz - uz * vy, y: uz * vx - ux * vz, z: ux * vy - uy * vx };
}

/** Push a triangle, flipping its winding so its normal faces the desired way. */
function pushOriented(
    positions: number[], indices: number[], a: number, b: number, c: number, ref: 'radial' | 'down',
): void {
    const nrm = triNormal(positions, a, b, c);
    let outward: boolean;
    if (ref === 'down') {
        outward = nrm.y < 0;
    } else {
        const cx = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
        const cz = (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3;
        outward = nrm.x * cx + nrm.z * cz > 0;
    }
    if (outward) indices.push(a, b, c);
    else indices.push(a, c, b);
}

/** Push a quad (ring p0→p1→p2→p3) as two triangles wound so its normal faces (ox,oy,oz). */
export function pushQuadOriented(
    positions: number[], indices: number[],
    p0: [number, number, number], p1: [number, number, number],
    p2: [number, number, number], p3: [number, number, number],
    ox: number, oy: number, oz: number,
): void {
    const i0 = positions.length / 3;
    positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
    const i1 = i0 + 1, i2 = i0 + 2, i3 = i0 + 3;
    const n = triNormal(positions, i0, i1, i2);
    if (n.x * ox + n.y * oy + n.z * oz >= 0) indices.push(i0, i1, i2, i0, i2, i3);
    else indices.push(i0, i2, i1, i0, i3, i2);
}

/**
 * Skirt + flat base that closes an open grid top-surface (tcols × trows vertices, the first
 * `tcols*trows` entries of `positions`) into a watertight solid with its floor at `baseY`.
 */
export function addSocket(positions: number[], indices: number[], tcols: number, trows: number, baseY: number): void {
    const topCount = tcols * trows;
    // Perimeter loop of top vertices, CCW-ish: north → east → south → west.
    const loop: number[] = [];
    for (let c = 0; c < tcols; c++) loop.push(c);                              // north edge
    for (let r = 1; r < trows; r++) loop.push(r * tcols + (tcols - 1));        // east edge
    for (let c = tcols - 2; c >= 0; c--) loop.push((trows - 1) * tcols + c);   // south edge
    for (let r = trows - 2; r >= 1; r--) loop.push(r * tcols);                 // west edge
    const n = loop.length;

    // A bottom vertex directly below each perimeter top vertex.
    for (let k = 0; k < n; k++) {
        const ti = loop[k];
        positions.push(positions[ti * 3], baseY, positions[ti * 3 + 2]);
    }
    const bottom = (k: number) => topCount + k;

    // Walls: one quad per perimeter segment, oriented outward (away from the axis).
    for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        pushOriented(positions, indices, loop[k], loop[k1], bottom(k1), 'radial');
        pushOriented(positions, indices, loop[k], bottom(k1), bottom(k), 'radial');
    }
    // Base: fan triangulate the bottom loop, oriented downward (-Y).
    for (let k = 1; k < n - 1; k++) {
        pushOriented(positions, indices, bottom(0), bottom(k), bottom(k + 1), 'down');
    }
}
