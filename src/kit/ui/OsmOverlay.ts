import OlMap from 'ol/Map';
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Polygon from 'ol/geom/Polygon';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, Stroke, Style } from 'ol/style';
import { fromLonLat } from 'ol/proj';
import type { OsmElement } from '../mapelements/OverpassFeature';
import type { OsmFeatureDef } from '../mapelements/osmFeatures';

/** Highlight colour for the selected element, and for elements the user has ticked (marked). */
const SELECT_COLOR = '#ffd400';
const MARK_COLOR = '#22c55e';
const DISABLED_COLOR = '#9ca3af';

/** A read-only overlay of one OSM feature on the OpenLayers 2D map. `line` features draw as stroked
 *  polylines, `area` features as filled polygons; the feature's `zIndex` orders them under the
 *  selection layer (1000). Each OL Feature carries its element id (`getId()` + `osmElementId`) so a
 *  map click can be mapped back to an element, and the layer is tagged `osmFeatureId` so the click
 *  hit-test can filter to OSM layers. One element can be highlighted as the current selection. */
export class OsmOverlay {
    private source = new VectorSource();
    readonly layer: VectorLayer<VectorSource>;
    private selectedId: number | null = null;
    private hoveredId: number | null = null;
    private markedIds = new Set<number>();
    private base: Style;
    private selected: Style;
    private marked: Style;
    private disabledStyle: Style;

    constructor(map: OlMap, private def: OsmFeatureDef) {
        const fill = def.fillColor ? new Fill({ color: def.fillColor }) : undefined;
        const width = def.geometry === 'area' ? 1 : 2;
        this.base = new Style({ stroke: new Stroke({ color: def.strokeColor, width }), fill });
        this.selected = new Style({
            stroke: new Stroke({ color: SELECT_COLOR, width: width + 2 }),
            fill: def.fillColor ? new Fill({ color: 'rgba(255, 212, 0, 0.45)' }) : undefined,
        });
        this.marked = new Style({
            stroke: new Stroke({ color: MARK_COLOR, width: width + 1 }),
            fill: def.fillColor ? new Fill({ color: 'rgba(34, 197, 94, 0.4)' }) : undefined,
        });
        // Disabled: a thin grey line, no fill — visibly "switched off" but still pickable so it can
        // be re-enabled. Focus/marked still win so the user can find and act on it.
        this.disabledStyle = new Style({ stroke: new Stroke({ color: DISABLED_COLOR, width: 1 }) });
        this.layer = new VectorLayer({
            source: this.source,
            style: (feature) => {
                const id = feature.get('osmElementId');
                if (id === this.selectedId || id === this.hoveredId) return this.selected; // focus wins
                if (this.markedIds.has(id)) return this.marked;
                return feature.get('osmDisabled') ? this.disabledStyle : this.base;
            },
            zIndex: def.zIndex,
        });
        this.layer.set('osmFeatureId', def.id);
        map.addLayer(this.layer);
    }

    /** Replace the drawn elements with a fresh set (after download / upload / delete). */
    setElements(elements: readonly OsmElement[]): void {
        this.source.clear();
        const features = elements.map(el => {
            const coords = el.coords.map(c => fromLonLat(c));
            const geom = this.def.geometry === 'area' ? new Polygon([coords]) : new LineString(coords);
            const feature = new Feature(geom);
            feature.setId(el.id);
            feature.set('osmElementId', el.id);
            feature.set('osmDisabled', !!el.disabled);
            return feature;
        });
        this.source.addFeatures(features);
    }

    /** Highlight one element as selected (or null to clear). Restyles in place. */
    setSelected(elementId: number | null): void {
        if (this.selectedId === elementId) return;
        this.selectedId = elementId;
        this.source.changed(); // re-evaluate the style function for every feature
    }

    /** Transiently highlight one element as hovered (or null to clear), e.g. from a list-row hover. */
    setHovered(elementId: number | null): void {
        if (this.hoveredId === elementId) return;
        this.hoveredId = elementId;
        this.source.changed();
    }

    /** Highlight the set of ticked (marked) elements — the user's staged edit selection. */
    setMarked(ids: readonly number[]): void {
        this.markedIds = new Set(ids);
        this.source.changed();
    }

    /** The map-projection extent of one element's geometry, for fitting the view to it. */
    extentOf(elementId: number): number[] | null {
        const geom = this.source.getFeatureById(elementId)?.getGeometry();
        return geom ? geom.getExtent() : null;
    }

    /** Element ids whose geometry intersects the given map-projection extent — for box-select. */
    elementsInExtent(extent: number[]): number[] {
        const ids: number[] = [];
        this.source.forEachFeatureIntersectingExtent(extent, (feature) => {
            const id = feature.get('osmElementId');
            if (typeof id === 'number') ids.push(id);
        });
        return ids;
    }

    /** Remove all drawn elements (e.g. when the selection changes or is cleared). */
    clear(): void {
        this.selectedId = null;
        this.hoveredId = null;
        this.markedIds.clear();
        this.source.clear();
    }
}
