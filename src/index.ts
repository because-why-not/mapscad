import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { Env } from './Env';
import { fetchTileMapManifest, ManifestMap } from './TileMapManifest';
import { prettifyMapName, iconForMapType } from './mapMeta';
import { availableCustomMaps } from './customMaps';
import { MapController } from './MapController';
import { OpenLayersEngine } from './engine/OpenLayersEngine';
import { MapLibreTerrainEngine } from './engine/MapLibreTerrainEngine';
import type { GeoView, MapEngine } from './engine/MapEngine';

// This file is the composition root: the only place that names concrete engines.
// Everything it wires together (MapController, App, persistence) is engine-agnostic.

const DEFAULT_VIEW: GeoView = { lng: 170.5028, lat: -45.8788, zoom: 13 }; // Dunedin

let appInstance: any = null;

function loadView(): GeoView {
    try {
        const s = localStorage.getItem('mapView');
        if (s) return JSON.parse(s);
    } catch (e) { Env.error('load mapView', e); }
    return DEFAULT_VIEW;
}

function saveView(v: GeoView): void {
    try { localStorage.setItem('mapView', JSON.stringify(v)); } catch (e) { Env.error('save mapView', e); }
}

function saveActive(id: string): void {
    try { localStorage.setItem('activeProvider', id); } catch (e) { Env.error('save activeProvider', e); }
}

async function init(): Promise<void> {
    const root = document.getElementById('map-root')!;

    const maps = await fetchTileMapManifest();
    if (maps.length === 0) {
        Env.warn('No maps returned by manifest — check tile server / network.');
    }
    const mapsById: Record<string, ManifestMap> = Object.fromEntries(maps.map(m => [m.name, m]));
    const customSpecs = availableCustomMaps(mapsById);

    // Composition root: choose concrete engines here; nothing else knows about them.
    const engines: MapEngine[] = [new OpenLayersEngine(maps)];
    if (customSpecs.length) engines.push(new MapLibreTerrainEngine(customSpecs, mapsById));

    const controller = new MapController({
        engines,
        container: root,
        initialView: loadView(),
        onActiveChange: id => appInstance?.setActiveProvider(id),
        onViewPersist: saveView,
        onActivePersist: saveActive,
    });

    const tileProviders = maps.map(m => ({
        id: m.name,
        name: prettifyMapName(m.name),
        icon: iconForMapType(m.mmapsrv.type),
    }));
    const customMaps = customSpecs.map(s => ({ id: s.id, name: s.name, icon: s.icon }));

    const saved = localStorage.getItem('activeProvider');
    const initialId = (saved && controller.sourceIds.includes(saved))
        ? saved
        : (tileProviders[0]?.id ?? customMaps[0]?.id ?? '');

    appInstance = mount(App, {
        target: document.getElementById('svelte-app')!,
        props: {
            tileProviders,
            customMaps,
            initialActiveProviderId: initialId,
            onLayerSwitch: (id: string) => controller.select(id),
        },
    });

    if (initialId) controller.select(initialId);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
