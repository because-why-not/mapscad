import OlMap from 'ol/Map';
import Feature from 'ol/Feature';
import Polygon from 'ol/geom/Polygon';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import PointerInteraction from 'ol/interaction/Pointer';
import { Circle as CircleStyle, Fill, Icon, Stroke, Style } from 'ol/style';
import { fromLonLat, toLonLat } from 'ol/proj';
import type { Coordinate } from 'ol/coordinate';
import { SelectionShape } from './MapModel';

/** A rotatable rectangular selection drawn on the OpenLayers 2D map.
 *
 * Geometry is kept in the map's view projection (planar metres) as a centre,
 * half-extents and a rotation, mirroring the original Leaflet tool but zoom-stable.
 * It's exposed/stored to the rest of the app only as four lon/lat corners. */
export type LonLat = [number, number];

interface SelectionAreaOptions {
    onChange?: (corners: LonLat[] | null) => void;
}

const HANDLE_HIT_PX = 12;   // pixel radius for grabbing a handle
const MOVE_HIT_PX = 16;     // pixel radius for grabbing the (larger) move handle
const MIN_HALF = 1;         // minimum half-extent (projection units) to avoid degenerate rects
const ROTATE_PUSH = 1.25;   // how far past the top edge the rotation handle sits

// View-only ("locked") mode: dim everything outside the selection with this grey wash, so the
// selected area reads as a spotlight and it's clear the selection can't be edited from here.
const DIM_STYLE = new Style({ fill: new Fill({ color: 'rgba(90, 90, 90, 0.45)' }) });
// Half-extent of the dimming backdrop ring (projection units). Covers many wrapped world copies
// (world is ~4e7 wide) so the wash fills the viewport at any zoom; the selection is its hole.
const DIM_EXTENT = 1e8;

type Mode = 'none' | 'create' | 'resize' | 'rotate' | 'move';

// Centre handle: a four-way move arrow, so the whole selection can be dragged as one.
const MOVE_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="11" fill="#007bff" stroke="#ffffff" stroke-width="1.5"/>
        <g stroke="#ffffff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 4.5 V19.5 M4.5 12 H19.5"/>
            <path d="M12 4.5 l-2 2.2 M12 4.5 l2 2.2"/>
            <path d="M12 19.5 l-2 -2.2 M12 19.5 l2 -2.2"/>
            <path d="M4.5 12 l2.2 -2 M4.5 12 l2.2 2"/>
            <path d="M19.5 12 l-2.2 -2 M19.5 12 l-2.2 2"/>
        </g>
    </svg>`);

export class SelectionArea {
    private map: OlMap;
    private onChange?: (corners: LonLat[] | null) => void;
    private source = new VectorSource();
    private layer: VectorLayer<VectorSource>;
    private interaction: PointerInteraction;

    // View-only mode (the Data tab): edit interaction off, handles hidden, normal cursor, and a
    // grey wash over everything but the selection. `wasActive` remembers the editing state so it
    // can be restored when returning to the Selection tab.
    private viewOnly = false;
    private wasActive = false;
    // wrapX off: with world-wrap on, OL draws the huge backdrop once per world copy, and a
    // neighbouring copy's backdrop still covers the centre while its hole is shifted away — so the
    // overlapping copies repaint grey over the selection. One copy → the hole stays clear.
    private dimSource = new VectorSource({ wrapX: false });
    private dimLayer: VectorLayer<VectorSource>;
    private dimFeature = new Feature<Polygon>();
    private dimAdded = false;

    // rectangle state, in the map view projection
    private center: Coordinate | null = null;
    private halfX = 0;
    private halfY = 0;
    private rotation = 0; // radians
    // Oval draws the inscribed ellipse but keeps the same bounding box, handles and the
    // four emitted corners — the model masks the sampled rectangle to the ellipse.
    private shape: SelectionShape = SelectionShape.Rectangle;
    // Locked width:height (halfX/halfY) for create + resize, or null for free aspect.
    // Mercator is conformal, so a fixed projection-unit ratio is the same ratio on the
    // ground locally — i.e. 1:1 really is a square / circle.
    private aspect: number | null = null;

    private featuresAdded = false;
    private rectFeature = new Feature<Polygon>();
    private cornerFeatures = [0, 1, 2, 3].map(() => new Feature<Point>());
    private rotateFeature = new Feature<Point>();
    private moveFeature = new Feature<Point>();

    // interaction state
    private mode: Mode = 'none';
    private createStart: Coordinate | null = null;
    private resizeFixed: Coordinate | null = null;
    private rotateStartPointer = 0;
    private rotateStartRotation = 0;
    private moveStartPointer: Coordinate | null = null;
    private moveStartCenter: Coordinate | null = null;

    constructor(map: OlMap, options: SelectionAreaOptions = {}) {
        this.map = map;
        this.onChange = options.onChange;

        this.rectFeature.set('role', 'rect');
        this.cornerFeatures.forEach(f => f.set('role', 'corner'));
        this.rotateFeature.set('role', 'rotate');
        this.moveFeature.set('role', 'move');

        this.layer = new VectorLayer({ source: this.source, style: f => this.styleFor(f), zIndex: 1000 });
        map.addLayer(this.layer);

        // Sits above the tiles + OSM overlays but below the selection outline (1000), so outside
        // the selection everything greys out while the selection itself stays crisp on top.
        this.dimLayer = new VectorLayer({ source: this.dimSource, style: DIM_STYLE, zIndex: 950, visible: false });
        map.addLayer(this.dimLayer);

        this.interaction = new PointerInteraction({
            handleDownEvent: e => this.onDown(e),
            handleDragEvent: e => this.onDrag(e),
            handleUpEvent: () => this.onUp(),
        });
        this.interaction.setActive(false);
        map.addInteraction(this.interaction);
    }

    /** Enter selection mode: enable editing and let the user draw if nothing exists yet. */
    activate(): void {
        this.interaction.setActive(true);
        this.map.getTargetElement()?.classList.add('map-crosshair');
    }

    /** Leave selection mode and clear the rectangle. */
    deactivate(): void {
        this.interaction.setActive(false);
        this.map.getTargetElement()?.classList.remove('map-crosshair');
        this.clear();
    }

    /** Enter/leave view-only ("locked") mode used by the Data tab: the selection stays drawn but
     *  can't be edited — handles hidden, edit interaction off, normal cursor — and everything
     *  outside it is dimmed grey so it reads as a spotlight. */
    setViewOnly(on: boolean): void {
        if (on === this.viewOnly) return;
        this.viewOnly = on;
        if (on) {
            this.wasActive = this.interaction.getActive();
            this.interaction.setActive(false);
            this.map.getTargetElement()?.classList.remove('map-crosshair');
            this.updateDim();
            this.dimLayer.setVisible(true);
        } else {
            this.dimLayer.setVisible(false);
            if (this.wasActive) {
                this.interaction.setActive(true);
                this.map.getTargetElement()?.classList.add('map-crosshair');
            }
        }
        this.source.changed(); // restyle: show/hide handles and the rect fill
    }

    /** Build the grey wash: a huge backdrop ring with the selection outline punched out as a hole.
     *  The hole ring is reversed so its winding opposes the backdrop (canvas nonzero fill → hole). */
    private updateDim(): void {
        if (!this.center) { this.dimSource.clear(); this.dimAdded = false; return; }
        const L = DIM_EXTENT;
        const backdrop: Coordinate[] = [[-L, -L], [L, -L], [L, L], [-L, L], [-L, -L]];
        const hole = [...this.outline(this.corners())].reverse();
        const polygon = new Polygon([backdrop, hole]);
        this.dimFeature.setGeometry(polygon);
        if (!this.dimAdded) { this.dimSource.addFeature(this.dimFeature); this.dimAdded = true; }
    }

    /** Per-feature style. In view-only mode the interactive handles are hidden and the rect shows
     *  as an outline only (no fill) so the selected area keeps the map's normal colours. */
    private styleFor(feature: any): Style | undefined {
        const role = feature.get('role');
        if (this.viewOnly) {
            if (role === 'corner' || role === 'rotate' || role === 'move') return undefined;
            return new Style({ stroke: new Stroke({ color: '#007bff', width: 2, lineDash: [5, 5] }) });
        }
        return styleForFeature(feature);
    }

    /** Rebuild a selection from four saved lon/lat corners (order TL, TR, BR, BL). */
    restore(corners: LonLat[]): void {
        if (!corners || corners.length !== 4) return;
        const pts = corners.map(c => fromLonLat(c));
        const [p0, p1, , p3] = pts;
        this.center = [
            (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4,
            (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4,
        ];
        this.rotation = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        this.halfX = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 2;
        this.halfY = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / 2;
        this.updateGeometry();
        this.activate();
    }

    /** Switch the drawn footprint between a rectangle and its inscribed ellipse. */
    setShape(shape: SelectionShape): void {
        if (shape === this.shape) return;
        this.shape = shape;
        if (this.center) this.updateGeometry();
    }

    /** Lock the width:height ratio (e.g. 1 for a square/circle), or null for free aspect.
     *  An existing selection keeps its width and snaps its height to the new ratio. */
    setAspect(aspect: number | null): void {
        this.aspect = aspect && aspect > 0 ? aspect : null;
        if (this.center && this.aspect) {
            this.halfY = Math.max(this.halfX / this.aspect, MIN_HALF);
            this.updateGeometry();
            this.emitChange();
        }
    }

    /** Current selection as four lon/lat corners, or null if there is no selection. */
    getCorners(): LonLat[] | null {
        if (!this.center) return null;
        return this.corners().map(c => toLonLat(c) as LonLat);
    }

    // --- pointer handling -------------------------------------------------

    private onDown(e: any): boolean {
        if (this.center) {
            const ci = this.hitCorner(e.pixel);
            if (ci >= 0) {
                this.mode = 'resize';
                this.resizeFixed = this.corners()[(ci + 2) % 4];
                return true;
            }
            if (this.hitRotate(e.pixel)) {
                this.mode = 'rotate';
                this.rotateStartPointer = Math.atan2(e.coordinate[1] - this.center[1], e.coordinate[0] - this.center[0]);
                this.rotateStartRotation = this.rotation;
                return true;
            }
            if (this.hitMove(e.pixel)) {
                this.mode = 'move';
                this.moveStartPointer = e.coordinate;
                this.moveStartCenter = [...this.center];
                return true;
            }
            return false; // outside handles with an existing rect — let the map pan
        }
        this.mode = 'create';
        this.createStart = e.coordinate;
        return true;
    }

    private onDrag(e: any): void {
        if (this.mode === 'create' && this.createStart) {
            this.fromDrag(this.createStart, e.coordinate);
        } else if (this.mode === 'resize' && this.resizeFixed) {
            this.fromResize(this.resizeFixed, e.coordinate);
        } else if (this.mode === 'rotate' && this.center) {
            const a = Math.atan2(e.coordinate[1] - this.center[1], e.coordinate[0] - this.center[0]);
            this.rotation = this.rotateStartRotation + (a - this.rotateStartPointer);
            this.updateGeometry();
        } else if (this.mode === 'move' && this.moveStartPointer && this.moveStartCenter) {
            // Translate the whole selection: shift the centre by the pointer delta.
            this.center = [
                this.moveStartCenter[0] + (e.coordinate[0] - this.moveStartPointer[0]),
                this.moveStartCenter[1] + (e.coordinate[1] - this.moveStartPointer[1]),
            ];
            this.updateGeometry();
        }
    }

    private onUp(): boolean {
        if (this.mode !== 'none') this.emitChange();
        this.mode = 'none';
        this.createStart = null;
        this.resizeFixed = null;
        this.moveStartPointer = null;
        this.moveStartCenter = null;
        return false;
    }

    // --- geometry ---------------------------------------------------------

    private fromDrag(start: Coordinate, current: Coordinate): void {
        const sx = Math.sign(current[0] - start[0]) || 1;
        const sy = Math.sign(current[1] - start[1]) || 1;
        let hx = Math.abs(current[0] - start[0]) / 2;
        let hy = Math.abs(current[1] - start[1]) / 2;
        [hx, hy] = this.applyAspect(hx, hy);
        // Anchor the start corner (where the drag began) and fit the box toward the cursor.
        this.center = [start[0] + sx * hx, start[1] + sy * hy];
        this.halfX = hx;
        this.halfY = hy;
        this.rotation = 0;
        this.updateGeometry();
    }

    private fromResize(fixed: Coordinate, dragged: Coordinate): void {
        // Work in the rectangle's own (un-rotated) frame: the full fixed→dragged extent.
        const cw = Math.cos(-this.rotation), sw = Math.sin(-this.rotation);
        const dxw = dragged[0] - fixed[0], dyw = dragged[1] - fixed[1];
        const lx = cw * dxw - sw * dyw;
        const ly = sw * dxw + cw * dyw;
        let [hx, hy] = this.applyAspect(Math.abs(lx) / 2, Math.abs(ly) / 2);
        // Place the centre so the FIXED corner stays put, in the rotated direction of drag.
        const sx = Math.sign(lx) || 1, sy = Math.sign(ly) || 1;
        const cl = Math.cos(this.rotation), sl = Math.sin(this.rotation);
        const ox = sx * hx, oy = sy * hy;
        this.center = [fixed[0] + cl * ox - sl * oy, fixed[1] + sl * ox + cl * oy];
        this.halfX = hx;
        this.halfY = hy;
        this.updateGeometry();
    }

    /** Clamp half-extents to the minimum and, if locked, to the target width:height ratio. */
    private applyAspect(hx: number, hy: number): [number, number] {
        hx = Math.max(hx, MIN_HALF);
        hy = Math.max(hy, MIN_HALF);
        if (this.aspect) {
            // Shrink the longer axis to honour the ratio so it fits within what was dragged.
            if (hx > hy * this.aspect) hx = hy * this.aspect;
            else hy = hx / this.aspect;
            hx = Math.max(hx, MIN_HALF);
            hy = Math.max(hy, MIN_HALF);
        }
        return [hx, hy];
    }

    /** Four rotated corners in projection coords: TL, TR, BR, BL. */
    private corners(): Coordinate[] {
        const [cx, cy] = this.center!;
        const cos = Math.cos(this.rotation);
        const sin = Math.sin(this.rotation);
        const locals: Coordinate[] = [
            [-this.halfX, -this.halfY], [this.halfX, -this.halfY],
            [this.halfX, this.halfY], [-this.halfX, this.halfY],
        ];
        return locals.map(([lx, ly]) => [cx + cos * lx - sin * ly, cy + sin * lx + cos * ly]);
    }

    private rotateHandleCoord(c: Coordinate[]): Coordinate {
        const [cx, cy] = this.center!;
        const topMid: Coordinate = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
        return [cx + (topMid[0] - cx) * ROTATE_PUSH, cy + (topMid[1] - cy) * ROTATE_PUSH];
    }

    /** Outline ring for the current shape: the four corners, or an ellipse through them. */
    private outline(c: Coordinate[]): Coordinate[] {
        if (this.shape !== SelectionShape.Oval) return [...c, c[0]];
        const [cx, cy] = this.center!;
        const cos = Math.cos(this.rotation), sin = Math.sin(this.rotation);
        const STEPS = 64;
        const ring: Coordinate[] = [];
        for (let i = 0; i <= STEPS; i++) {
            const t = (i / STEPS) * 2 * Math.PI;
            const lx = this.halfX * Math.cos(t), ly = this.halfY * Math.sin(t);
            ring.push([cx + cos * lx - sin * ly, cy + sin * lx + cos * ly]);
        }
        return ring;
    }

    private updateGeometry(): void {
        if (!this.center) return;
        const c = this.corners();
        this.rectFeature.setGeometry(new Polygon([this.outline(c)]));
        c.forEach((coord, i) => this.cornerFeatures[i].setGeometry(new Point(coord)));
        this.rotateFeature.setGeometry(new Point(this.rotateHandleCoord(c)));
        this.moveFeature.setGeometry(new Point(this.center));
        if (!this.featuresAdded) {
            this.source.addFeatures([this.rectFeature, ...this.cornerFeatures, this.rotateFeature, this.moveFeature]);
            this.featuresAdded = true;
        }
        if (this.viewOnly) this.updateDim();
    }

    private clear(): void {
        this.source.clear();
        this.dimSource.clear();
        this.dimAdded = false;
        this.featuresAdded = false;
        this.center = null;
        this.halfX = this.halfY = this.rotation = 0;
        this.emitChange();
    }

    // --- hit testing ------------------------------------------------------

    private hitCorner(pixel: number[]): number {
        const c = this.corners();
        for (let i = 0; i < 4; i++) {
            if (this.withinHandle(pixel, c[i])) return i;
        }
        return -1;
    }

    private hitRotate(pixel: number[]): boolean {
        return this.withinHandle(pixel, this.rotateHandleCoord(this.corners()));
    }

    private hitMove(pixel: number[]): boolean {
        return !!this.center && this.withinHandle(pixel, this.center, MOVE_HIT_PX);
    }

    private withinHandle(pixel: number[], coord: Coordinate, radius = HANDLE_HIT_PX): boolean {
        const hp = this.map.getPixelFromCoordinate(coord);
        if (!hp) return false;
        return Math.hypot(pixel[0] - hp[0], pixel[1] - hp[1]) <= radius;
    }

    private emitChange(): void {
        this.onChange?.(this.getCorners());
    }
}

function styleForFeature(feature: any): Style {
    const role = feature.get('role');
    if (role === 'corner') {
        return new Style({
            image: new CircleStyle({
                radius: 6,
                fill: new Fill({ color: '#007bff' }),
                stroke: new Stroke({ color: '#ffffff', width: 1 }),
            }),
        });
    }
    if (role === 'rotate') {
        return new Style({
            image: new CircleStyle({
                radius: 6,
                fill: new Fill({ color: '#ffffff' }),
                stroke: new Stroke({ color: '#007bff', width: 2 }),
            }),
        });
    }
    if (role === 'move') {
        return new Style({ image: new Icon({ src: MOVE_ICON }) });
    }
    return new Style({
        stroke: new Stroke({ color: '#007bff', width: 2, lineDash: [5, 5] }),
        fill: new Fill({ color: 'rgba(0, 123, 255, 0.2)' }),
    });
}
