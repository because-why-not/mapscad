import OlMap from 'ol/Map';
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Stroke, Style } from 'ol/style';
import { fromLonLat } from 'ol/proj';
import type { LonLat } from './SelectionArea';
import type { Track } from './osm/OverpassTracks';

/** A read-only overlay of OSM walking tracks on the OpenLayers 2D map. Like `SelectionArea`,
 *  it's OL-specific and created once the OL map is ready; it sits just below the selection
 *  layer (zIndex 900 < 1000) so the selection handles stay on top and grabbable. */
export class TrackOverlay {
    private source = new VectorSource();
    private layer: VectorLayer<VectorSource>;

    constructor(map: OlMap) {
        this.layer = new VectorLayer({ source: this.source, style: TRACK_STYLE, zIndex: 900 });
        map.addLayer(this.layer);
    }

    /** Replace the drawn tracks (each a [lon,lat] polyline) with a fresh set. */
    setTracks(tracks: Track[]): void {
        this.source.clear();
        const features = tracks.map(line => {
            const geom = new LineString(line.map(c => fromLonLat(c)));
            return new Feature(geom);
        });
        this.source.addFeatures(features);
    }

    /** Remove all drawn tracks (e.g. when the selection changes or is cleared). */
    clear(): void {
        this.source.clear();
    }
}

const TRACK_STYLE = new Style({
    stroke: new Stroke({ color: '#d62728', width: 2 }),
});
