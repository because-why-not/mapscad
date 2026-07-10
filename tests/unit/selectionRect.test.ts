import { describe, it, expect } from 'vitest';
import { SelectionRect } from '../../src/kit/SelectionRect';
import { MapscadSession } from '../../src/kit/MapscadSession';
import type { LonLat } from '../../src/kit/common/mathHelper';

// Canonical order: SW, SE, NE, NW (counter-clockwise, corner[0] = south-west).
const SW: LonLat = [0, 0], SE: LonLat = [1, 0], NE: LonLat = [1, 1], NW: LonLat = [0, 1];
const CANONICAL: LonLat[] = [SW, SE, NE, NW];

describe('SelectionRect.fromCorners', () => {
    it('keeps already-canonical corners untouched (idempotent)', () => {
        expect(SelectionRect.fromCorners(CANONICAL).corners).toEqual(CANONICAL);
    });

    it('repairs the N-edge-first order that used to mirror models (winding flip)', () => {
        // The order the old golden fixtures / hand-written tests used: NW, NE, SE, SW — the same
        // rectangle wound clockwise, which fed a N/S-mirrored grid into the pipeline.
        const rect = SelectionRect.fromCorners([NW, NE, SE, SW]);
        expect(rect.corners).toEqual(CANONICAL);
    });

    it('normalizes every cyclic rotation of a counter-clockwise ring (phase)', () => {
        expect(SelectionRect.fromCorners([SE, NE, NW, SW]).corners).toEqual(CANONICAL);
        expect(SelectionRect.fromCorners([NE, NW, SW, SE]).corners).toEqual(CANONICAL);
        expect(SelectionRect.fromCorners([NW, SW, SE, NE]).corners).toEqual(CANONICAL);
    });

    it('normalizes every cyclic rotation of a clockwise ring (winding + phase)', () => {
        expect(SelectionRect.fromCorners([SE, SW, NW, NE]).corners).toEqual(CANONICAL);
        expect(SelectionRect.fromCorners([SW, NW, NE, SE]).corners).toEqual(CANONICAL);
        expect(SelectionRect.fromCorners([NE, SE, SW, NW]).corners).toEqual(CANONICAL);
    });

    it('rotated rect: corner[0] is the southernmost corner and the bearing follows the SW→SE edge', () => {
        // A 45°-rotated square (diamond): south, east, north, west points.
        const S: LonLat = [0, -1], E: LonLat = [1, 0], N: LonLat = [0, 1], W: LonLat = [-1, 0];
        const rect = SelectionRect.fromCorners([E, N, W, S]); // arbitrary CCW phase in
        expect(rect.corners).toEqual([S, E, N, W]);           // southernmost first
        expect(rect.bearing()).toBeCloseTo(Math.PI / 4, 2);   // grid east points ~north-east
        // Axis-aligned selections have bearing 0.
        expect(SelectionRect.fromCorners(CANONICAL).bearing()).toBeCloseTo(0, 10);
    });

    it('exposes named corners, metric extents and the centroid', () => {
        const rect = SelectionRect.fromCorners(CANONICAL);
        expect(rect.sw).toEqual(SW);
        expect(rect.se).toEqual(SE);
        expect(rect.ne).toEqual(NE);
        expect(rect.nw).toEqual(NW);
        expect(rect.widthMeters).toBeGreaterThan(100_000);  // ~111 km per degree at the equator
        expect(rect.heightMeters).toBeGreaterThan(100_000);
        expect(rect.centroid()).toEqual([0.5, 0.5]);
    });

    it('serializes to the plain corners array (persistence stays LonLat[][])', () => {
        expect(JSON.parse(JSON.stringify(SelectionRect.fromCorners([NW, NE, SE, SW])))).toEqual(CANONICAL);
    });

    it('copies defensively: mutating the input or toCorners() output cannot corrupt the rect', () => {
        const input: LonLat[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const rect = SelectionRect.fromCorners(input);
        input[0][0] = 999;
        rect.toCorners()[0][0] = 999;
        expect(rect.corners[0]).toEqual([0, 0]);
    });

    it('throws on malformed input instead of propagating junk', () => {
        expect(() => SelectionRect.fromCorners([SW, SE, NE] as any)).toThrow(/four/);
        expect(() => SelectionRect.fromCorners([SW, SE, NE, [0, NaN]] as any)).toThrow(/finite/i);
        expect(() => SelectionRect.fromCorners(null as any)).toThrow();
    });
});

describe('MapscadSession selection normalization', () => {
    it('setSelection normalizes any corner order; getSelection and the event are canonical', () => {
        const session = new MapscadSession();
        let fromEvent: LonLat[] | null = null;
        session.selectionChanged.on(({ corners }) => fromEvent = corners);
        session.setSelection([NW, NE, SE, SW]); // the legacy mirrored order in…
        expect(session.getSelection()).toEqual(CANONICAL); // …canonical out
        expect(fromEvent).toEqual(CANONICAL);
        expect(session.getSelectionRect()!.sw).toEqual(SW);
    });

    it('clearing still works and nulls the rect', () => {
        const session = new MapscadSession();
        session.setSelection(CANONICAL);
        session.setSelection(null);
        expect(session.getSelection()).toBeNull();
        expect(session.getSelectionRect()).toBeNull();
    });
});
