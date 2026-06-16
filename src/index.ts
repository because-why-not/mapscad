import { mount } from 'svelte';
import App from './App.svelte';
import Map from 'ol/Map';
import View from 'ol/View';
import { fromLonLat, toLonLat } from 'ol/proj';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import 'ol/ol.css';
import './app.css';
import { Env } from './Env';
import { fetchTileMapManifest } from './TileMapManifest';
import { layerFromManifest, LayerEntry, VIEW_MAX_ZOOM } from './manifestLayers';

interface MapView { lng: number; lat: number; zoom: number; }

const DEFAULT_VIEW: MapView = { lng: 170.5028, lat: -45.8788, zoom: 13 }; // Dunedin

let olMap: Map;
let view: View;
let providers: LayerEntry[] = [];
let activeId = '';
let appInstance: any = null;

function loadMapView(): MapView {
    try {
        const s = localStorage.getItem('mapView');
        if (s) return JSON.parse(s);
    } catch (e) { Env.error('load mapView', e); }
    return DEFAULT_VIEW;
}

function saveMapView(): void {
    const c = toLonLat(view.getCenter()!);
    const v: MapView = { lng: c[0], lat: c[1], zoom: view.getZoom() ?? DEFAULT_VIEW.zoom };
    try { localStorage.setItem('mapView', JSON.stringify(v)); } catch (e) { Env.error('save mapView', e); }
}

function saveActiveProvider(): void {
    try { localStorage.setItem('activeProvider', activeId); } catch (e) { Env.error('save activeProvider', e); }
}

function setActiveLayer(id: string): void {
    const entry = providers.find(p => p.id === id);
    if (!entry) return;
    for (const p of providers) p.layer.setVisible(p.id === id);
    activeId = id;
    appInstance?.setActiveProvider(id);
    saveActiveProvider();
}

async function init(): Promise<void> {
    const v = loadMapView();
    view = new View({ center: fromLonLat([v.lng, v.lat]), zoom: v.zoom, maxZoom: VIEW_MAX_ZOOM });
    olMap = new Map({
        target: 'map',
        layers: [],
        view,
        controls: defaultControls().extend([new ScaleLine()]),
    });
    view.on('change', saveMapView); // or olMap.on('moveend', saveMapView)

    const maps = await fetchTileMapManifest();
    if (maps.length === 0) {
        Env.warn('No maps returned by manifest — check tile server / network.');
    }
    providers = maps.map(layerFromManifest);
    for (const p of providers) olMap.addLayer(p.layer);

    // Restore previously selected layer, else first in the manifest.
    const saved = localStorage.getItem('activeProvider');
    const initial = providers.find(p => p.id === saved)?.id ?? providers[0]?.id ?? '';
    if (initial) setActiveLayer(initial);

    appInstance = mount(App, {
        target: document.getElementById('svelte-app')!,
        props: {
            tileProviders: providers.map(({ id, name, icon }) => ({ id, name, icon })),
            initialActiveProviderId: initial,
            onLayerSwitch: (id: string) => setActiveLayer(id),
        },
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
