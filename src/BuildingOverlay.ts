import OlMap from 'ol/Map';
import Feature from 'ol/Feature';
import Polygon from 'ol/geom/Polygon';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, Stroke, Style } from 'ol/style';
import { fromLonLat } from 'ol/proj';
import type { Building } from './osm/OverpassBuildings';

/** A read-only overlay of OSM building footprints on the OpenLayers 2D map. Mirrors `TrackOverlay`
 *  but draws filled polygons. Sits just below the tracks/selection layers (zIndex 850 < 900 < 1000)
 *  so tracks stay visible over building fills and the selection handles stay grabbable on top. */
export class BuildingOverlay {
    private source = new VectorSource();
    private layer: VectorLayer<VectorSource>;

    constructor(map: OlMap) {
        this.layer = new VectorLayer({ source: this.source, style: BUILDING_STYLE, zIndex: 850 });
        map.addLayer(this.layer);
    }

    /** Replace the drawn buildings (each a [lon,lat] ring) with a fresh set. */
    setBuildings(buildings: Building[]): void {
        this.source.clear();
        const features = buildings.map(ring => {
            const geom = new Polygon([ring.map(c => fromLonLat(c))]);
            return new Feature(geom);
        });
        this.source.addFeatures(features);
    }

    /** Remove all drawn buildings (e.g. when the selection changes or is cleared). */
    clear(): void {
        this.source.clear();
    }
}

const BUILDING_STYLE = new Style({
    fill: new Fill({ color: 'rgba(31, 119, 180, 0.35)' }),
    stroke: new Stroke({ color: '#1f77b4', width: 1 }),
});
