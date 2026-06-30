import OlMap from 'ol/Map';
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Polygon from 'ol/geom/Polygon';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, Stroke, Style } from 'ol/style';
import { fromLonLat } from 'ol/proj';
import type { OsmElement } from './osm/OverpassFeature';
import type { OsmFeatureDef } from './osm/osmFeatures';

/** Highlight colour for the selected element (shared across features). */
const SELECT_COLOR = '#ffd400';

/** A read-only overlay of one OSM feature on the OpenLayers 2D map. `line` features draw as stroked
 *  polylines, `area` features as filled polygons; the feature's `zIndex` orders them under the
 *  selection layer (1000). Each OL Feature carries its element id (`getId()` + `osmElementId`) so a
 *  map click can be mapped back to an element, and the layer is tagged `osmFeatureId` so the click
 *  hit-test can filter to OSM layers. One element can be highlighted as the current selection. */
export class OsmOverlay {
    private source = new VectorSource();
    readonly layer: VectorLayer<VectorSource>;
    private selectedId: number | null = null;
    private base: Style;
    private selected: Style;

    constructor(map: OlMap, private def: OsmFeatureDef) {
        const fill = def.fillColor ? new Fill({ color: def.fillColor }) : undefined;
        const width = def.geometry === 'area' ? 1 : 2;
        this.base = new Style({ stroke: new Stroke({ color: def.strokeColor, width }), fill });
        this.selected = new Style({
            stroke: new Stroke({ color: SELECT_COLOR, width: width + 2 }),
            fill: def.fillColor ? new Fill({ color: 'rgba(255, 212, 0, 0.45)' }) : undefined,
        });
        this.layer = new VectorLayer({
            source: this.source,
            style: (feature) => (feature.get('osmElementId') === this.selectedId ? this.selected : this.base),
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

    /** The map-projection extent of one element's geometry, for fitting the view to it. */
    extentOf(elementId: number): number[] | null {
        const geom = this.source.getFeatureById(elementId)?.getGeometry();
        return geom ? geom.getExtent() : null;
    }

    /** Remove all drawn elements (e.g. when the selection changes or is cleared). */
    clear(): void {
        this.selectedId = null;
        this.source.clear();
    }
}
