import OlMap from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import XYZ from 'ol/source/XYZ';
import { fromLonLat, toLonLat } from 'ol/proj';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import 'ol/ol.css';
import type { ManifestMap } from '../TileMapManifest';
import type { GeoView, MapEngine } from './MapEngine';

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
    private layerById = new Map<string, TileLayer<XYZ>>();

    constructor(private maps: ManifestMap[], private onReady?: (map: OlMap) => void) {
        this.sourceIds = maps.map(m => m.name);
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

        const layers: TileLayer<XYZ>[] = [];
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
