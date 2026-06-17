import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { Env } from './Env';
import { fetchTileMapManifest, ManifestMap } from './TileMapManifest';
import { prettifyMapName, iconForMapType } from './mapMeta';
import { availableCustomMaps, isSunCapable } from './customMaps';
import { MapController } from './MapController';
import { OpenLayersEngine } from './engine/OpenLayersEngine';
import { MapLibreTerrainEngine } from './engine/MapLibreTerrainEngine';
import { DeckTerrainEngine } from './engine/DeckTerrainEngine';
import { SelectionArea, LonLat } from './SelectionArea';
import { sampleSelectionHeights, rectExtent } from './HeightSampler';
import { TerrainPreview } from './TerrainPreview';
import type { GeoView, MapEngine } from './engine/MapEngine';

// This file is the composition root: the only place that names concrete engines.
// Everything it wires together (MapController, App, persistence) is engine-agnostic.

const DEFAULT_VIEW: GeoView = { lng: 170.5028, lat: -45.8788, zoom: 13 }; // Dunedin

// Elevation source for the 3D preview, and the preview's grid detail (samples on the
// longer side) — independent of map zoom; will become user-controllable later.
const PREVIEW_DEM = 'dunedin_elevation_raw';
const PREVIEW_GRID_LONG = 256;
const PREVIEW_EXAGGERATION = 1;

let appInstance: any = null;
let previewDem: ManifestMap | undefined;
let preview: TerrainPreview | null = null;
let previewRoot: HTMLElement;
let splitEl: HTMLElement;

/** Width-bigger => split left/right (vertical), height-bigger => split top/bottom. */
function updateSplitOrientation(): void {
    const vertical = window.innerWidth >= window.innerHeight;
    splitEl.classList.toggle('vertical', vertical);
    splitEl.classList.toggle('horizontal', !vertical);
}

/** Nudge the active map + preview to re-measure after the split layout changes. */
function refreshSizes(): void {
    window.dispatchEvent(new Event('resize')); // OL/MapLibre/deck observe this / their container
    preview?.resize();
}

function gridResolution(corners: LonLat[]): { cols: number; rows: number } {
    const { widthMeters, heightMeters } = rectExtent(corners);
    if (widthMeters >= heightMeters) {
        return { cols: PREVIEW_GRID_LONG, rows: Math.max(2, Math.round(PREVIEW_GRID_LONG * heightMeters / widthMeters)) };
    }
    return { cols: Math.max(2, Math.round(PREVIEW_GRID_LONG * widthMeters / heightMeters)), rows: PREVIEW_GRID_LONG };
}

function showPreview(corners: LonLat[]): void {
    if (!previewDem) return;
    splitEl.classList.add('split');
    updateSplitOrientation();
    if (!preview) preview = new TerrainPreview(previewRoot);
    // Let the split layout flush before sizing the renderer / framing the camera.
    requestAnimationFrame(async () => {
        preview!.resize();
        refreshSizes();
        try {
            const { cols, rows } = gridResolution(corners);
            const grid = await sampleSelectionHeights(corners, previewDem!, cols, rows);
            preview!.setHeightGrid(grid, PREVIEW_EXAGGERATION);
        } catch (e) { Env.error('build preview', e); }
    });
}

function hidePreview(): void {
    splitEl.classList.remove('split');
    preview?.clear();
    requestAnimationFrame(refreshSizes);
}

/** Single place the selection state fans out: persistence, UI, and the 3D preview. */
function onSelectionChange(corners: LonLat[] | null): void {
    saveSelectionCorners(corners);
    appInstance?.setHasSelection(!!corners);
    if (corners) showPreview(corners);
    else hidePreview();
}

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

function loadSunDate(): Date {
    try {
        const s = localStorage.getItem('sunDate');
        if (s) {
            const d = new Date(s);
            if (!isNaN(d.valueOf())) return d;
        }
    } catch (e) { Env.error('load sunDate', e); }
    return new Date();
}

function saveSunDate(date: Date): void {
    try { localStorage.setItem('sunDate', date.toISOString()); } catch (e) { Env.error('save sunDate', e); }
}

function loadShadows(): boolean {
    try { return localStorage.getItem('shadows') !== '0'; } catch (e) { Env.error('load shadows', e); return true; }
}

function saveShadows(enabled: boolean): void {
    try { localStorage.setItem('shadows', enabled ? '1' : '0'); } catch (e) { Env.error('save shadows', e); }
}

function loadSelectionCorners(): LonLat[] | null {
    try {
        const s = localStorage.getItem('selectionCorners');
        if (s) {
            const c = JSON.parse(s);
            if (Array.isArray(c) && c.length === 4) return c;
        }
    } catch (e) { Env.error('load selectionCorners', e); }
    return null;
}

function saveSelectionCorners(corners: LonLat[] | null): void {
    try {
        if (corners) localStorage.setItem('selectionCorners', JSON.stringify(corners));
        else localStorage.removeItem('selectionCorners');
    } catch (e) { Env.error('save selectionCorners', e); }
}

async function init(): Promise<void> {
    const root = document.getElementById('map-root')!;

    const maps = await fetchTileMapManifest();
    if (maps.length === 0) {
        Env.warn('No maps returned by manifest — check tile server / network.');
    }
    const mapsById: Record<string, ManifestMap> = Object.fromEntries(maps.map(m => [m.name, m]));
    const customSpecs = availableCustomMaps(mapsById);

    previewDem = mapsById[PREVIEW_DEM];
    splitEl = document.getElementById('app-split')!;
    previewRoot = document.getElementById('preview-root')!;
    updateSplitOrientation();
    window.addEventListener('resize', () => { updateSplitOrientation(); preview?.resize(); });

    // Composition root: choose concrete engines here; nothing else knows about them.
    // Split the custom maps by which renderer claims them.
    const deckSpecs = customSpecs.filter(s => s.surface.type === 'shaded-relief');
    const mapLibreSpecs = customSpecs.filter(s => s.surface.type !== 'shaded-relief');

    // The region-selection tool lives on the OpenLayers 2D map; it's created once the
    // OL map is ready, then restored from any previously saved selection.
    let selection: SelectionArea | null = null;
    const olEngine = new OpenLayersEngine(maps, olMap => {
        if (selection) return; // already created on an earlier mount
        selection = new SelectionArea(olMap, { onChange: onSelectionChange });
        const savedCorners = loadSelectionCorners();
        if (savedCorners) {
            selection.restore(savedCorners);
            appInstance?.setSelectActive(true);
            onSelectionChange(savedCorners); // restore() doesn't emit — fan out manually
        }
    });
    const engines: MapEngine[] = [olEngine];
    if (mapLibreSpecs.length) engines.push(new MapLibreTerrainEngine(mapLibreSpecs, mapsById));
    if (deckSpecs.length) engines.push(new DeckTerrainEngine(deckSpecs, mapsById));

    const initialSunDate = loadSunDate();
    const initialShadows = loadShadows();
    const controller = new MapController({
        engines,
        container: root,
        initialView: loadView(),
        initialSunDate,
        initialShadows,
        onActiveChange: id => appInstance?.setActiveProvider(id),
        onViewPersist: saveView,
        onActivePersist: saveActive,
    });

    const tileProviders = maps.map(m => ({
        id: m.name,
        name: prettifyMapName(m.name),
        icon: iconForMapType(m.mmapsrv.type),
    }));
    const customMaps = customSpecs.map(s => ({
        id: s.id,
        name: s.name,
        icon: s.icon,
        sun: isSunCapable(s),
        shadows: s.surface.type === 'shaded-relief',
    }));

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
            initialSunDate,
            initialShadows,
            onLayerSwitch: (id: string) => controller.select(id),
            onSunChange: (date: Date) => { saveSunDate(date); controller.setSunDate(date); },
            onShadowsChange: (enabled: boolean) => { saveShadows(enabled); controller.setShadowsEnabled(enabled); },
            onSelectToggle: (active: boolean) => {
                if (!selection) return;
                if (active) selection.activate();
                else { selection.deactivate(); appInstance?.setHasSelection(false); }
            },
            onSelectionSave: () => {
                const corners = selection?.getCorners();
                if (corners) Env.log('[selection] corners', JSON.stringify(corners));
            },
        },
    });

    if (initialId) controller.select(initialId);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
