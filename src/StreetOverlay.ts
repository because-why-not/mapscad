import OlMap from 'ol/Map';
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Stroke, Style } from 'ol/style';
import { fromLonLat } from 'ol/proj';
import type { Street } from './osm/OverpassStreets';

/** A read-only overlay of OSM streets on the OpenLayers 2D map. Mirrors `TrackOverlay` (also a
 *  polyline layer) in a distinct colour, and sits between the building fills and the tracks
 *  (zIndex 850 < 880 < 900 < 1000) so tracks stay readable over streets and the selection
 *  handles stay grabbable on top. */
export class StreetOverlay {
    private source = new VectorSource();
    private layer: VectorLayer<VectorSource>;

    constructor(map: OlMap) {
        this.layer = new VectorLayer({ source: this.source, style: STREET_STYLE, zIndex: 880 });
        map.addLayer(this.layer);
    }

    /** Replace the drawn streets (each a [lon,lat] polyline) with a fresh set. */
    setStreets(streets: Street[]): void {
        this.source.clear();
        const features = streets.map(line => {
            const geom = new LineString(line.map(c => fromLonLat(c)));
            return new Feature(geom);
        });
        this.source.addFeatures(features);
    }

    /** Remove all drawn streets (e.g. when the selection changes or is cleared). */
    clear(): void {
        this.source.clear();
    }
}

const STREET_STYLE = new Style({
    stroke: new Stroke({ color: '#ff7f0e', width: 2 }),
});
