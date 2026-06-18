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
import { sampleSelectionHeights, rectExtent, groundResolution, tileCoverage } from './HeightSampler';
import { TerrainPreview } from './TerrainPreview';
import { MapModel } from './MapModel';
import { PreviewConfigStore } from './PreviewConfig';
import { exportModelStl } from './StlMaker';
import { estimateMemory, formatBytes, memoryLevel, isOverBudget } from './memory';
import type { GeoView, MapEngine } from './engine/MapEngine';

// This file is the composition root: the only place that names concrete engines.
// Everything it wires together (MapController, App, persistence) is engine-agnostic.

const DEFAULT_VIEW: GeoView = { lng: 170.5028, lat: -45.8788, zoom: 13 }; // Dunedin

// Elevation source for the 3D preview. The heightmap zoom (a model setting) now drives
// detail: one mesh vertex per DEM pixel at that zoom, so density is set by zoom, not by
// the selection size.
const PREVIEW_DEM = 'dunedin_elevation_raw';

let appInstance: any = null;
let previewDem: ManifestMap | undefined;
let preview: TerrainPreview | null = null;
let previewRoot: HTMLElement | null = null;

// The canonical 3D model: settings mutate it, the preview and STL export read it.
const model = new MapModel();
// Single source of truth for preview/export config (DEM, selection, model settings,
// display flags) + its persistence and share-link codec. Reads any share link / saved
// config at construction.
const config = new PreviewConfigStore();
let currentCorners: LonLat[] | null = null;

/** Compact toggle label for an elevation source name (drops the _elevation[_raw] tail). */
function demLabel(name: string): string {
    return prettifyMapName(name.replace(/_elevation(_raw)?$/i, ''));
}

/** Heightmap zoom range a DEM supports: lowest stored level to its native max. */
function demZoomRange(dem: ManifestMap | undefined): { min: number; max: number } {
    if (!dem) return { min: 0, max: 17 };
    return { min: dem.mmapsrv.minStoredZoom ?? dem.minzoom, max: dem.maxzoom };
}

/** Grid size at a zoom: one sample per DEM pixel, capped to the resolution limit. */
function gridResolution(corners: LonLat[], zoom: number, limit: number): { cols: number; rows: number } {
    const { widthMeters, heightMeters } = rectExtent(corners);
    const res = groundResolution(corners[0][1], zoom); // metres per DEM pixel at this zoom
    let cols = Math.max(2, Math.round(widthMeters / res) + 1);
    let rows = Math.max(2, Math.round(heightMeters / res) + 1);
    const long = Math.max(cols, rows);
    if (long > limit) {
        const f = limit / long;
        cols = Math.max(2, Math.round(cols * f));
        rows = Math.max(2, Math.round(rows * f));
    }
    return { cols, rows };
}

/** Largest zoom ≤ desired whose DEM canvas + mesh fits the memory budget. */
function safeZoom(corners: LonLat[], desired: number, limit: number): number {
    const zMin = previewDem!.mmapsrv.minStoredZoom ?? previewDem!.minzoom;
    const zMax = previewDem!.maxzoom;
    let z = Math.max(zMin, Math.min(zMax, Math.round(desired)));
    for (; z > zMin; z--) {
        const cov = tileCoverage(corners, previewDem!, z);
        const { cols, rows } = gridResolution(corners, z, limit);
        const est = estimateMemory({ cols, rows, tilesX: cov.tilesX, tilesY: cov.tilesY });
        if (!isOverBudget(est.totalBytes)) break;
    }
    return z;
}

/** Re-sample the DEM over the current selection and feed the heights into the model. */
async function resample(): Promise<void> {
    if (!previewDem || !currentCorners) return;
    Env.log('[3d] regenerating terrain…');
    const t0 = performance.now();
    try {
        const { heightZoom, resolutionLimit } = model.getSettings();
        const zoom = safeZoom(currentCorners, heightZoom, resolutionLimit);
        const { cols, rows } = gridResolution(currentCorners, zoom, resolutionLimit);
        const grid = await sampleSelectionHeights(currentCorners, previewDem, cols, rows, zoom);
        model.setGrid(grid); // notifies -> preview + stats rebuild from the model
        Env.log(`[3d] terrain regenerated in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) { Env.error('resample', e); }
}

// Resampling hits the network, so changes to zoom / resolution limit are debounced.
let resampleTimer = 0;
function scheduleResample(): void {
    clearTimeout(resampleTimer);
    resampleTimer = window.setTimeout(resample, 200);
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
    config.update({ selection: corners });
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

async function init(): Promise<void> {
    const maps = await fetchTileMapManifest();
    if (maps.length === 0) {
        Env.warn('No maps returned by manifest — check tile server / network.');
    }
    const mapsById: Record<string, ManifestMap> = Object.fromEntries(maps.map(m => [m.name, m]));
    const customSpecs = availableCustomMaps(mapsById);
    // The 3D preview can be built from any elevation DEM the server advertises (the
    // manifest tags those with mmapsrv.type === 'elevation'). Expose them all as a source
    // toggle; each DEM has its own zoom range, so switching also moves the zoom.
    const previewDems = maps
        .filter(m => m.mmapsrv.type === 'elevation')
        .map(m => ({ id: m.name, name: demLabel(m.name) }));
    // Resolve the DEM from the saved/shared config, falling back to the default elevation
    // source (or whatever the manifest offers).
    const cfg = config.get();
    const initialDemId = (cfg.demId && mapsById[cfg.demId]?.mmapsrv.type === 'elevation')
        ? cfg.demId
        : (mapsById[PREVIEW_DEM] ? PREVIEW_DEM : (previewDems[0]?.id ?? ''));
    previewDem = mapsById[initialDemId];

    const { min: previewZoomMin, max: previewZoomMax } = demZoomRange(previewDem);
    // heightZoom 0 means "unset" (no DEM zoom is that low) -> default to the finest level.
    const heightZoom = cfg.model.heightZoom > 0 ? cfg.model.heightZoom : previewZoomMax;
    model.applySettings({ ...cfg.model, heightZoom });
    // Fold the resolved DEM + sanitized settings back into the config so it's consistent.
    config.update({ demId: initialDemId, model: model.getSettings() });
    const initialPreviewSettings: Record<string, any> = { ...model.getSettings(), smoothShading: cfg.display.smoothShading };

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
            previewDems,
            initialPreviewDemId: initialDemId,
            previewZoomMin,
            previewZoomMax,
            initialPreviewSettings,
            onPreviewDemChange: (id: string) => {
                if (!mapsById[id]) return;
                previewDem = mapsById[id];
                // Each DEM has its own zoom range; jump to the new source's finest level
                // (safeZoom still trims it down to the memory budget on resample).
                const { min, max } = demZoomRange(previewDem);
                model.applySettings({ heightZoom: max });
                config.update({ demId: id, model: model.getSettings() });
                appInstance?.setPreviewZoomRange(min, max, max); // move the slider's range + value
                resample();
            },
            onPreviewSettingsChange: (s: Record<string, any>) => {
                const prev = model.getSettings();
                model.applySettings(s); // rebuilds geometry from the current grid
                config.update({ model: model.getSettings(), display: { smoothShading: s.smoothShading ?? true } });
                preview?.setSmoothShading(s.smoothShading ?? true); // display-only
                // Zoom / resolution change the sampling itself, so re-fetch the heights.
                if (s.heightZoom !== prev.heightZoom || s.resolutionLimit !== prev.resolutionLimit) {
                    scheduleResample();
                }
            },
            onPreviewGenerate: (s: Record<string, any>) => { model.applySettings(s); config.update({ model: model.getSettings() }); resample(); },
            onPreviewSave: (s: Record<string, any>) => { model.applySettings(s); config.update({ model: model.getSettings() }); exportModelStl(model); },
            onPreviewResetCamera: () => preview?.resetCamera(),
            onPreviewShareLink: () => config.shareLink(),
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
    preview.setSmoothShading(initialPreviewSettings.smoothShading ?? true);
    model.onChange(onModelChange);

    // Composition root: choose concrete engines here; nothing else knows about them.
    const deckSpecs = customSpecs.filter(s => s.surface.type === 'shaded-relief');
    const mapLibreSpecs = customSpecs.filter(s => s.surface.type !== 'shaded-relief');

    // The region-selection tool lives on the OpenLayers 2D map; created when the OL map
    // is ready, then restored from any previously saved selection.
    const olEngine = new OpenLayersEngine(maps, olMap => {
        if (selection) return;
        selection = new SelectionArea(olMap, { onChange: onSelectionChange });
        const savedCorners = config.get().selection;
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
