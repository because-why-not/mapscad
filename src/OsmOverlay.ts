import OlMap from 'ol/Map';
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Polygon from 'ol/geom/Polygon';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, Stroke, Style } from 'ol/style';
import { fromLonLat } from 'ol/proj';
import type { OsmWay } from './osm/OverpassFeature';
import type { OsmFeatureDef } from './osm/osmFeatures';

/** A read-only overlay of one OSM feature on the OpenLayers 2D map. `line` features draw as stroked
 *  polylines, `area` features as filled polygons; the feature's `zIndex` orders them under the
 *  selection layer (1000) so the selection handles stay grabbable on top. Replaces the identical
 *  Track/Street/Building overlays. */
export class OsmOverlay {
    private source = new VectorSource();

    constructor(map: OlMap, private def: OsmFeatureDef) {
        const stroke = new Stroke({ color: def.strokeColor, width: def.geometry === 'area' ? 1 : 2 });
        const style = new Style({
            stroke,
            fill: def.fillColor ? new Fill({ color: def.fillColor }) : undefined,
        });
        const layer = new VectorLayer({ source: this.source, style, zIndex: def.zIndex });
        map.addLayer(layer);
    }

    /** Replace the drawn ways (each a [lon,lat] polyline or ring) with a fresh set. */
    setWays(ways: OsmWay[]): void {
        this.source.clear();
        const features = ways.map(line => {
            const coords = line.map(c => fromLonLat(c));
            const geom = this.def.geometry === 'area' ? new Polygon([coords]) : new LineString(coords);
            return new Feature(geom);
        });
        this.source.addFeatures(features);
    }

    /** Remove all drawn ways (e.g. when the selection changes or is cleared). */
    clear(): void {
        this.source.clear();
    }
}
