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
import { MapModel } from './MapModel';
import { exportModelStl } from './StlMaker';
import { estimateMemory, formatBytes, memoryLevel } from './memory';
import type { GeoView, MapEngine } from './engine/MapEngine';

// This file is the composition root: the only place that names concrete engines.
// Everything it wires together (MapController, App, persistence) is engine-agnostic.

const DEFAULT_VIEW: GeoView = { lng: 170.5028, lat: -45.8788, zoom: 13 }; // Dunedin

// Elevation source for the 3D preview, and the preview's grid detail (samples on the
// longer side) — independent of map zoom; will become user-controllable later.
const PREVIEW_DEM = 'dunedin_elevation_raw';
const PREVIEW_GRID_LONG = 256;

let appInstance: any = null;
let previewDem: ManifestMap | undefined;
let preview: TerrainPreview | null = null;
let previewRoot: HTMLElement | null = null;

// The canonical 3D model: settings mutate it, the preview and STL export read it.
const model = new MapModel();
let currentCorners: LonLat[] | null = null;

function gridResolution(corners: LonLat[]): { cols: number; rows: number } {
    const { widthMeters, heightMeters } = rectExtent(corners);
    if (widthMeters >= heightMeters) {
        return { cols: PREVIEW_GRID_LONG, rows: Math.max(2, Math.round(PREVIEW_GRID_LONG * heightMeters / widthMeters)) };
    }
    return { cols: Math.max(2, Math.round(PREVIEW_GRID_LONG * widthMeters / heightMeters)), rows: PREVIEW_GRID_LONG };
}

/** Re-sample the DEM over the current selection and feed the heights into the model. */
async function resample(): Promise<void> {
    if (!previewDem || !currentCorners) return;
    try {
        const { cols, rows } = gridResolution(currentCorners);
        const grid = await sampleSelectionHeights(currentCorners, previewDem, cols, rows);
        model.setGrid(grid); // notifies -> preview + stats rebuild from the model
    } catch (e) { Env.error('resample', e); }
}

/** The model changed (new heights or new settings): rebuild the preview and the stats. */
function onModelChange(): void {
    const geo = model.buildGeometry();
    preview?.setGeometry(geo);
    const grid = model.getGrid();
    if (!grid || !geo) { appInstance?.setPreviewStats(null); return; }
    const mem = estimateMemory(grid);
    const surfaceVerts = grid.cols * grid.rows;
    appInstance?.setPreviewStats({
        vertices: geo.vertexCount,
        triangles: geo.triangleCount,
        zoom: grid.zoom,
        widthMeters: Math.round(grid.widthMeters),
        heightMeters: Math.round(grid.heightMeters),
        gridCols: grid.cols,
        gridRows: grid.rows,
        metersPerVertex: (grid.widthMeters * grid.heightMeters) / surfaceVerts,
        memoryText: formatBytes(mem.totalBytes),
        memoryLevel: memoryLevel(mem.totalBytes),
    });
}

/** Single place the selection state fans out: persistence, panel visibility, model. */
function onSelectionChange(corners: LonLat[] | null): void {
    saveSelectionCorners(corners);
    appInstance?.setPreviewVisible(!!corners); // App shows/hides the 3D panel
    currentCorners = corners;
    if (corners) resample();
    else model.setGrid(null); // notifies -> preview clears, stats null
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

function loadPreviewSettings(): Record<string, any> {
    try {
        const s = localStorage.getItem('previewSettings');
        if (s) return JSON.parse(s);
    } catch (e) { Env.error('load previewSettings', e); }
    return {};
}

function savePreviewSettings(settings: Record<string, any>): void {
    try { localStorage.setItem('previewSettings', JSON.stringify(settings)); } catch (e) { Env.error('save previewSettings', e); }
}

async function init(): Promise<void> {
    const maps = await fetchTileMapManifest();
    if (maps.length === 0) {
        Env.warn('No maps returned by manifest — check tile server / network.');
    }
    const mapsById: Record<string, ManifestMap> = Object.fromEntries(maps.map(m => [m.name, m]));
    const customSpecs = availableCustomMaps(mapsById);
    previewDem = mapsById[PREVIEW_DEM];

    const previewZoomMin = previewDem ? (previewDem.mmapsrv.minStoredZoom ?? previewDem.minzoom) : 0;
    const previewZoomMax = previewDem ? previewDem.maxzoom : 17;
    const initialPreviewSettings = loadPreviewSettings();
    model.applySettings(initialPreviewSettings);

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

    const allIds = [...tileProviders.map(p => p.id), ...customMaps.map(c => c.id)];
    const saved = localStorage.getItem('activeProvider');
    const initialId = (saved && allIds.includes(saved)) ? saved : (allIds[0] ?? '');
    const initialSunDate = loadSunDate();
    const initialShadows = loadShadows();

    // These are assigned just below; the App callbacks (user-triggered later) close over
    // them, so it's fine that they reference values not set until after mount.
    let controller: MapController;
    let selection: SelectionArea | null = null;

    // Mount the Svelte UI first — it owns the split layout and provides the DOM nodes the
    // map engines and 3D preview mount into.
    appInstance = mount(App, {
        target: document.getElementById('app')!,
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
                else selection.deactivate(); // emits onChange(null) -> hides preview
            },
            previewZoomMin,
            previewZoomMax,
            initialPreviewSettings,
            onPreviewSettingsChange: (s: Record<string, any>) => { savePreviewSettings(s); model.applySettings(s); },
            onPreviewGenerate: (s: Record<string, any>) => { model.applySettings(s); Env.log('[3d] generate', JSON.stringify(s)); },
            onPreviewSave: (s: Record<string, any>) => { savePreviewSettings(s); model.applySettings(s); exportModelStl(model); },
            onLayoutChange: () => preview?.resize(),
        },
    });

    // Read the Svelte-rendered mount nodes from the DOM (mount() inserts synchronously);
    // more reliable than threading bind:this through nested components.
    const mapMount = document.getElementById('map-mount')!;
    previewRoot = document.getElementById('preview-mount')!;

    // The preview is a pure consumer of the model: one subscription keeps both the 3D
    // view and the stats overlay in sync with whatever the model currently holds.
    preview = new TerrainPreview(previewRoot);
    model.onChange(onModelChange);

    // Composition root: choose concrete engines here; nothing else knows about them.
    const deckSpecs = customSpecs.filter(s => s.surface.type === 'shaded-relief');
    const mapLibreSpecs = customSpecs.filter(s => s.surface.type !== 'shaded-relief');

    // The region-selection tool lives on the OpenLayers 2D map; created when the OL map
    // is ready, then restored from any previously saved selection.
    const olEngine = new OpenLayersEngine(maps, olMap => {
        if (selection) return;
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

    controller = new MapController({
        engines,
        container: mapMount,
        initialView: loadView(),
        initialSunDate,
        initialShadows,
        onActiveChange: id => appInstance?.setActiveProvider(id),
        onViewPersist: saveView,
        onActivePersist: saveActive,
    });

    if (initialId) controller.select(initialId);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
