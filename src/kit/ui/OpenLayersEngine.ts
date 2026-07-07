import OlMap from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import type BaseLayer from 'ol/layer/Base';
import XYZ from 'ol/source/XYZ';
import { fromLonLat, toLonLat } from 'ol/proj';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import 'ol/ol.css';
import type { ManifestMap } from '../maptiles/TileMapManifest';
import type { GeoView, MapEngine } from './MapEngine';
import { buildHillshadeSource } from './hillshadeRaster';

/** A 2D shaded-relief layer computed in-browser from a terrarium DEM (by manifest name). */
export interface HillshadeSpec {
    id: string;
    demSource: string;
}

// Highest zoom the view allows; above a source's native maxzoom OpenLayers upscales
// tiles (overzoom), matching Leaflet's old maxNativeZoom behaviour.
const VIEW_MAX_ZOOM = 22;
const FALLBACK_ZOOM = 13;

/** 2D renderer: one XYZ tile layer per manifest source; switching toggles visibility. */
export class OpenLayersEngine implements MapEngine {
    readonly sourceIds: string[];
    private el!: HTMLDivElement;
    private map!: OlMap;
    private view!: View;
    private layerById = new Map<string, BaseLayer>();

    constructor(
        private maps: ManifestMap[],
        private onReady?: (map: OlMap) => void,
        private hillshades: HillshadeSpec[] = [],
    ) {
        this.sourceIds = [...maps.map(m => m.name), ...hillshades.map(h => h.id)];
    }

    async mount(parent: HTMLElement, view: GeoView): Promise<void> {
        const el = document.createElement('div');
        el.className = 'map-surface';
        el.style.display = 'none';
        parent.appendChild(el);
        this.el = el;

        const olView = new View({
            center: fromLonLat([view.lng, view.lat]),
            zoom: view.zoom,
            maxZoom: VIEW_MAX_ZOOM,
        });
        this.view = olView;

        const layers: BaseLayer[] = [];
        for (const m of this.maps) {
            const source = new XYZ({
                url: m.tiles[0],                       // template already contains {z}/{x}/{y}
                maxZoom: m.maxzoom,                     // native max; OL overzooms beyond this
                tileSize: m.mmapsrv.tileSize ?? 256,
                attributions: m.attribution || undefined,
                crossOrigin: 'anonymous',
            });
            const layer = new TileLayer({ source, visible: false });
            this.layerById.set(m.name, layer);
            layers.push(layer);
        }

        // 2D hillshades: a shaded relief computed in-browser from a DEM already in `maps`.
        const mapsByName = new Map(this.maps.map(m => [m.name, m]));
        for (const h of this.hillshades) {
            const dem = mapsByName.get(h.demSource);
            if (!dem) continue;
            const source = buildHillshadeSource(dem);
            const layer = new ImageLayer({ source, visible: false });
            this.layerById.set(h.id, layer);
            layers.push(layer);
        }

        const scaleLine = new ScaleLine();
        const controls = defaultControls().extend([scaleLine]);
        const map = new OlMap({ target: el, layers, view: olView, controls });
        this.map = map;
        this.onReady?.(map);
    }

    setActiveSource(id: string): void {
        for (const [sid, layer] of this.layerById) layer.setVisible(sid === id);
    }

    show(view: GeoView): void {
        this.el.style.display = 'block';
        this.applyView(view);
        this.map.updateSize();
    }

    hide(): void {
        this.el.style.display = 'none';
    }

    getView(): GeoView {
        const center = this.view.getCenter();
        const [lng, lat] = center ? toLonLat(center) : [0, 0];
        return { lng, lat, zoom: this.view.getZoom() ?? FALLBACK_ZOOM };
    }

    onViewChange(cb: () => void): void {
        this.view.on('change', cb);
    }

    private applyView(view: GeoView): void {
        this.view.setCenter(fromLonLat([view.lng, view.lat]));
        this.view.setZoom(view.zoom);
    }
}
