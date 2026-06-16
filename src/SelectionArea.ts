import OlMap from 'ol/Map';
import Feature from 'ol/Feature';
import Polygon from 'ol/geom/Polygon';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import PointerInteraction from 'ol/interaction/Pointer';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style';
import { fromLonLat, toLonLat } from 'ol/proj';
import type { Coordinate } from 'ol/coordinate';

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
const MIN_HALF = 1;         // minimum half-extent (projection units) to avoid degenerate rects
const ROTATE_PUSH = 1.25;   // how far past the top edge the rotation handle sits

type Mode = 'none' | 'create' | 'resize' | 'rotate';

export class SelectionArea {
    private map: OlMap;
    private onChange?: (corners: LonLat[] | null) => void;
    private source = new VectorSource();
    private layer: VectorLayer<VectorSource>;
    private interaction: PointerInteraction;

    // rectangle state, in the map view projection
    private center: Coordinate | null = null;
    private halfX = 0;
    private halfY = 0;
    private rotation = 0; // radians

    private featuresAdded = false;
    private rectFeature = new Feature<Polygon>();
    private cornerFeatures = [0, 1, 2, 3].map(() => new Feature<Point>());
    private rotateFeature = new Feature<Point>();

    // interaction state
    private mode: Mode = 'none';
    private createStart: Coordinate | null = null;
    private resizeFixed: Coordinate | null = null;
    private rotateStartPointer = 0;
    private rotateStartRotation = 0;

    constructor(map: OlMap, options: SelectionAreaOptions = {}) {
        this.map = map;
        this.onChange = options.onChange;

        this.rectFeature.set('role', 'rect');
        this.cornerFeatures.forEach(f => f.set('role', 'corner'));
        this.rotateFeature.set('role', 'rotate');

        this.layer = new VectorLayer({ source: this.source, style: styleForFeature, zIndex: 1000 });
        map.addLayer(this.layer);

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
        }
    }

    private onUp(): boolean {
        if (this.mode !== 'none') this.emitChange();
        this.mode = 'none';
        this.createStart = null;
        this.resizeFixed = null;
        return false;
    }

    // --- geometry ---------------------------------------------------------

    private fromDrag(start: Coordinate, current: Coordinate): void {
        this.center = [(start[0] + current[0]) / 2, (start[1] + current[1]) / 2];
        this.halfX = Math.max(Math.abs(current[0] - start[0]) / 2, MIN_HALF);
        this.halfY = Math.max(Math.abs(current[1] - start[1]) / 2, MIN_HALF);
        this.rotation = 0;
        this.updateGeometry();
    }

    private fromResize(fixed: Coordinate, dragged: Coordinate): void {
        const center: Coordinate = [(fixed[0] + dragged[0]) / 2, (fixed[1] + dragged[1]) / 2];
        const cos = Math.cos(-this.rotation);
        const sin = Math.sin(-this.rotation);
        const dx = dragged[0] - center[0];
        const dy = dragged[1] - center[1];
        this.halfX = Math.max(Math.abs(cos * dx - sin * dy), MIN_HALF);
        this.halfY = Math.max(Math.abs(sin * dx + cos * dy), MIN_HALF);
        this.center = center;
        this.updateGeometry();
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

    private updateGeometry(): void {
        if (!this.center) return;
        const c = this.corners();
        this.rectFeature.setGeometry(new Polygon([[...c, c[0]]]));
        c.forEach((coord, i) => this.cornerFeatures[i].setGeometry(new Point(coord)));
        this.rotateFeature.setGeometry(new Point(this.rotateHandleCoord(c)));
        if (!this.featuresAdded) {
            this.source.addFeatures([this.rectFeature, ...this.cornerFeatures, this.rotateFeature]);
            this.featuresAdded = true;
        }
    }

    private clear(): void {
        this.source.clear();
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

    private withinHandle(pixel: number[], coord: Coordinate): boolean {
        const hp = this.map.getPixelFromCoordinate(coord);
        if (!hp) return false;
        return Math.hypot(pixel[0] - hp[0], pixel[1] - hp[1]) <= HANDLE_HIT_PX;
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
    return new Style({
        stroke: new Stroke({ color: '#007bff', width: 2, lineDash: [5, 5] }),
        fill: new Fill({ color: 'rgba(0, 123, 255, 0.2)' }),
    });
}
