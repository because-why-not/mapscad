import { mount, flushSync } from 'svelte';
import App from './ui/App.svelte';
import './ui/app.css';
import { Env } from './Env';
import { fetchTileMapManifest, ManifestMap } from './TileMapManifest';
import { EXTERNAL_DEMS } from './externalDems';
import { PROVIDER_CATEGORY } from './mapCategories';
import { prettifyMapName, iconForMapType } from './mapMeta';
import { availableCustomMaps, isSunCapable } from './customMaps';
import { MapController } from './MapController';
import { OpenLayersEngine } from './engine/OpenLayersEngine';
import { MapLibreTerrainEngine } from './engine/MapLibreTerrainEngine';
import { SelectionArea, LonLat } from './SelectionArea';
import { TrackOverlay } from './TrackOverlay';
import { fetchWalkingTracks, type Track } from './osm/OverpassTracks';
import { trackDistanceField } from './osm/trackRaster';
import { sampleSelectionHeights, rectExtent, groundResolution, tileCoverage } from './HeightSampler';
import { TerrainPreview } from './TerrainPreview';
import { MapModel, SelectionShape } from './MapModel';
import { PreviewConfigStore } from './PreviewConfig';
import { exportModelStl } from './StlMaker';
import { estimateMemory, measureMemory, formatBytes, memoryLevel, isOverBudget } from './memory';
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
let controller: MapController | null = null;
let mapsById: Record<string, ManifestMap> = {};
// Active map-source id -> the elevation DEM it represents (raw DEM = itself, a hillshade/3D
// map = its underlying DEM). Lets a brand-new selection default the preview to the source
// the user is actually looking at.
let demBySource: Record<string, string> = {};

// The canonical 3D model: settings mutate it, the preview and STL export read it.
const model = new MapModel();
// Single source of truth for preview/export config (DEM, selection, model settings,
// display flags) + its persistence and share-link codec. Reads any share link / saved
// config at construction.
const config = new PreviewConfigStore();
let currentCorners: LonLat[] | null = null;
// OSM walking-track overlay on the OL 2D map; created once the OL map is ready.
let trackOverlay: TrackOverlay | null = null;
// The tracks last downloaded for the current selection (lon/lat polylines). Kept so they can
// be re-rasterised into the model's distance field when added to the preview or on resample.
let currentTracks: Track[] | null = null;

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
    const res = groundResolution(corners[0][1], zoom, previewDem?.mmapsrv.tileSize); // metres per DEM pixel at this zoom
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

// In-flight DEM sampling, so a new build (or the user's Cancel) aborts the previous one.
let resampleAbort: AbortController | null = null;

/** Re-sample the DEM over the current selection and feed the heights into the model. */
async function resample(): Promise<void> {
    if (!previewDem || !currentCorners) return;
    resampleAbort?.abort();              // supersede any build still downloading
    const abort = new AbortController();
    resampleAbort = abort;
    Env.log('[3d] regenerating terrain…');
    const t0 = performance.now();
    appInstance?.setPreviewLoading({ loaded: 0, total: 0 }); // show the bottom progress bar
    try {
        const { heightZoom, resolutionLimit } = model.getSettings();
        const zoom = safeZoom(currentCorners, heightZoom, resolutionLimit);
        const { cols, rows } = gridResolution(currentCorners, zoom, resolutionLimit);
        const grid = await sampleSelectionHeights(currentCorners, previewDem, cols, rows, zoom, {
            signal: abort.signal,
            onProgress: (loaded, total) => appInstance?.setPreviewLoading({ loaded, total }),
        });
        if (abort.signal.aborted) return;
        model.setGrid(grid); // notifies -> preview + stats rebuild from the model
        syncTrackField(); // re-rasterise tracks (if any) to the new grid dimensions
        Env.log(`[3d] terrain regenerated in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') Env.log('[3d] terrain build cancelled');
        else Env.error('resample', e);
    } finally {
        if (resampleAbort === abort) { resampleAbort = null; appInstance?.setPreviewLoading(null); }
    }
}

/** User clicked Cancel on the loading bar — stop the in-flight build, keep the old preview. */
function cancelResample(): void {
    resampleAbort?.abort();
}

/** Rasterise the current tracks into a per-cell distance field aligned to the model's grid and
 *  hand it to the model (or clear it). Called whenever the tracks or the grid change. */
function syncTrackField(): void {
    const grid = model.getGrid();
    if (!currentTracks || !currentCorners || !grid) { model.setTrackDistance(null); return; }
    const field = trackDistanceField(
        currentCorners, currentTracks, grid.cols, grid.rows, grid.widthMeters, grid.heightMeters,
    );
    model.setTrackDistance(field);
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
    const mem = measureMemory(geo, grid); // realistic: from the actual built mesh, not a grid guess
    const surfaceVerts = grid.cols * grid.rows;
    appInstance?.setPreviewStats({
        vertices: geo.vertexCount,
        triangles: geo.triangleCount,
        zoom: grid.zoom,
        widthMeters: Math.round(grid.widthMeters),
        heightMeters: Math.round(grid.heightMeters),
        minThickness: geo.minThickness,   // thinnest/thickest solid column, export units
        maxThickness: geo.maxThickness,
        minHeight: grid.minHeight,        // actual lowest/highest heightmap elevation, metres
        maxHeight: grid.maxHeight,
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
    appInstance?.setHasSelection(!!corners);   // map panel shows/hides the track button
    currentCorners = corners;
    // Any downloaded tracks no longer match the new area: drop them + the preview section.
    trackOverlay?.clear();
    currentTracks = null;
    model.setTrackDistance(null);
    appInstance?.setTracksAvailable(false);
    if (corners) resample();
    else model.setGrid(null); // notifies -> preview clears, stats null
}

/** A selection the user just drew/edited. A brand-new one defaults its heightmap zoom to
 *  what's currently visible on the map, so we don't fetch far more detail than they see. */
function onUserSelectionChange(corners: LonLat[] | null): void {
    // Only seed defaults for a *brand-new* selection: corners exist (one was just drawn),
    // currentCorners is still empty (so it's new, not an edit of an existing one), and we
    // have a live map to read the active source / visible zoom from.
    if (corners && !currentCorners && controller) {
        // Default the preview source to the DEM behind the active map layer (e.g. drawing on
        // North Island's hillshade/raw picks north_island_elevation_raw), if it differs.
        const activeDem = demBySource[controller.activeId];
        if (activeDem && mapsById[activeDem] && activeDem !== config.get().demId) {
            previewDem = mapsById[activeDem];
            config.update({ demId: activeDem });
            appInstance?.setPreviewDem(activeDem); // sync the preview's Source toggle
        }
        if (previewDem) {
            const { min, max } = demZoomRange(previewDem);
            const visible = Math.round(controller.getView().zoom);
            const heightZoom = Math.max(min, Math.min(max, visible));
            model.applySettings({ heightZoom });
            config.update({ model: model.getSettings() });
            appInstance?.setPreviewZoomRange(min, max, heightZoom); // move the slider to match
        }
    }
    onSelectionChange(corners);
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

// --- URL state ---------------------------------------------------------------
// The hash carries the human-readable map state always (map name + lat/lng/zoom) and the
// opaque export config (`c=`) ONLY once an area is selected, e.g.
//   #map=north_island_hillshade_8m&lat=-41.27&lng=174.78&z=8.4
//   …&c=<base64>            (added after a selection)

/** Parse the human-readable map state from the URL hash (map name + view), if present. */
function readUrlMapState(): { map?: string; view?: GeoView } {
    try {
        const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const lat = parseFloat(params.get('lat') ?? '');
        const lng = parseFloat(params.get('lng') ?? '');
        const zoom = parseFloat(params.get('z') ?? '');
        const view = [lat, lng, zoom].every(Number.isFinite) ? { lat, lng, zoom } : undefined;
        return { map: params.get('map') || undefined, view };
    } catch (e) { Env.error('read url map state', e); return {}; }
}

/** Compose the full hash URL: readable map state, plus `c=` only when a selection exists. */
function composeShareUrl(): string {
    const v = controller?.getView() ?? DEFAULT_VIEW;
    const params: string[] = [];
    if (controller?.activeId) params.push(`map=${encodeURIComponent(controller.activeId)}`);
    params.push(`lat=${v.lat.toFixed(5)}`, `lng=${v.lng.toFixed(5)}`, `z=${v.zoom.toFixed(2)}`);
    if (config.get().selection) params.push(`c=${config.encodeParam()}`);
    const url = new URL(window.location.href);
    url.hash = params.join('&');
    return url.toString();
}

// Keep the address bar in sync with the live map + config, debounced so dragging the map or
// a slider doesn't flood the history API.
let urlSyncTimer = 0;
function scheduleUrlSync(): void {
    clearTimeout(urlSyncTimer);
    urlSyncTimer = window.setTimeout(() => {
        try { history.replaceState(null, '', composeShareUrl()); }
        catch (e) { Env.error('sync url', e); }
    }, 250);
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
    // One-off cleanup: these were folded into the single `previewConfig` key (PreviewConfig)
    // and are no longer read. Drop the orphans so they don't linger in users' storage.
    for (const k of ['previewSettings', 'previewDem', 'selectionCorners']) {
        try { localStorage.removeItem(k); } catch { /* ignore */ }
    }

    const serverMaps = await fetchTileMapManifest();
    if (serverMaps.length === 0) {
        Env.warn('No maps returned by manifest — check tile server / network.');
    }
    // Append the public internet-hosted DEMs (Mapterhorn, AWS) so they appear as ordinary
    // elevation sources alongside whatever the server advertises.
    const maps = [...serverMaps, ...EXTERNAL_DEMS];
    mapsById = Object.fromEntries(maps.map(m => [m.name, m]));
    const customSpecs = availableCustomMaps(mapsById);
    // Resolve any active map source to the DEM it represents (used to default the preview
    // source when a brand-new selection is drawn). Raw DEM layers map to themselves; custom
    // maps to their demSource; server hillshade layers via PROVIDER_CATEGORY.dem.
    for (const m of maps) if (m.mmapsrv.type === 'elevation') demBySource[m.name] = m.name;
    for (const s of customSpecs) demBySource[s.id] = s.demSource;
    for (const [name, cat] of Object.entries(PROVIDER_CATEGORY)) if (cat.dem) demBySource[name] = cat.dem;
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

    const tileProviders = maps.map(m => {
        const cat = PROVIDER_CATEGORY[m.name]; // undefined for ordinary, ungrouped maps
        return {
            id: m.name,
            // Inside a source category the header already names the source, so entries use a
            // short label (Raw / 2D Hillshade); ungrouped maps keep their prettified name.
            name: cat ? cat.label : prettifyMapName(m.name),
            icon: cat?.icon ?? iconForMapType(m.mmapsrv.type),
            category: cat?.category,
        };
    });
    const customMaps = customSpecs.map(s => ({
        id: s.id,
        name: s.name,
        icon: s.icon,
        sun: isSunCapable(s),
        shadows: false,
        category: s.category,
    }));

    // Map name + view come from the URL hash if present (human-readable, shareable), else
    // fall back to the last-used local values, else defaults.
    const urlMapState = readUrlMapState();
    const allIds = [...tileProviders.map(p => p.id), ...customMaps.map(c => c.id)];
    const saved = localStorage.getItem('activeProvider');
    const initialId = (urlMapState.map && allIds.includes(urlMapState.map)) ? urlMapState.map
        : (saved && allIds.includes(saved)) ? saved
        : (allIds[0] ?? '');
    const initialSunDate = loadSunDate();
    const initialShadows = loadShadows();

    // These are assigned just below; the App callbacks (user-triggered later) close over
    // them, so it's fine that they reference values not set until after mount.
    let selection: SelectionArea | null = null;

    // Shared by the App (initial zoom badge) and the MapController (initial camera).
    const initialView = urlMapState.view ?? loadView();

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
            onLayerSwitch: (id: string) => controller?.select(id),
            onSunChange: (date: Date) => { saveSunDate(date); controller?.setSunDate(date); },
            onShadowsChange: (enabled: boolean) => { saveShadows(enabled); controller?.setShadowsEnabled(enabled); },
            initialMapZoom: initialView.zoom,
            onSelectToggle: (active: boolean, shape: SelectionShape = SelectionShape.Rectangle) => {
                if (!selection) return;
                if (active) {
                    selection.setShape(shape);              // redraw + (if a selection exists) keep it
                    model.applySettings({ shape });         // mask is a model setting -> rebuilds geometry
                    config.update({ model: model.getSettings() });
                    selection.activate();
                } else {
                    selection.deactivate(); // emits onChange(null) -> hides preview
                }
            },
            onAspectChange: (ratio: number | null) => selection?.setAspect(ratio),
            // Download OSM walking tracks for the current selection and overlay them on the
            // map. Returns the count so the button can report it; throws bubble to the panel.
            onFetchTracks: async () => {
                if (!currentCorners) return 0;
                const tracks = await fetchWalkingTracks(currentCorners);
                currentTracks = tracks;
                trackOverlay?.setTracks(tracks);
                return tracks.length;
            },
            // Push the downloaded tracks into the model: rasterise them to the grid and reveal
            // the preview's Tracks section so the raise can be configured.
            onAddTracksToPreview: () => {
                if (!currentTracks?.length) return;
                syncTrackField();
                appInstance?.setTracksAvailable(true);
            },
            previewDems,
            initialPreviewDemId: initialDemId,
            previewZoomMin,
            previewZoomMax,
            initialPreviewSettings,
            onPreviewDemChange: (id: string) => {
                if (!mapsById[id]) return;
                previewDem = mapsById[id];
                // Keep the current detail level, just clamp it into the new source's range —
                // don't snap to the new max (e.g. North Island z14 -> Mapterhorn would jump
                // to z17, downloading far more than asked). safeZoom still trims on resample.
                const { min, max } = demZoomRange(previewDem);
                const heightZoom = Math.max(min, Math.min(max, model.getSettings().heightZoom));
                model.applySettings({ heightZoom });
                config.update({ demId: id, model: model.getSettings() });
                appInstance?.setPreviewZoomRange(min, max, heightZoom); // move the slider's range + value
                resample();
            },
            //triggered when the user changes settings in the side menu
            //(note this is not triggered when the selection changes)
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
            onPreviewShareLink: () => composeShareUrl(),
            onPreviewCancel: cancelResample,
            onLayoutChange: () => preview?.resize(),
        },
    });

    // mount() inserts the DOM synchronously, but child-component `bind:this` refs (mapPanel,
    // previewPanel) are wired by effects that flush asynchronously. The selection-restore below
    // runs synchronously (controller.select -> OL onReady, no awaits), so without this flush the
    // App's setSelectTool/setHasSelection forwarders would hit still-null child refs and no-op,
    // leaving the toolbar buttons stuck in their default state after a reload.
    flushSync();

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
    const ol2dSpecs = customSpecs.filter(s => s.surface.type === 'hillshade-2d');
    const mapLibreSpecs = customSpecs.filter(s => s.surface.type !== 'hillshade-2d');
    const hillshades = ol2dSpecs.map(s => ({ id: s.id, demSource: s.demSource }));

    // The region-selection tool lives on the OpenLayers 2D map; created when the OL map
    // is ready, then restored from any previously saved selection. The 2D hillshades render
    // here too, so the selection tool works over them.
    const olEngine = new OpenLayersEngine(maps, olMap => {
        if (selection) return;
        selection = new SelectionArea(olMap, { onChange: onUserSelectionChange });
        trackOverlay = new TrackOverlay(olMap);
        const savedCorners = config.get().selection;
        if (savedCorners) {
            const shape = config.get().model.shape;
            selection.setShape(shape);
            selection.restore(savedCorners);
            appInstance?.setSelectTool(shape); // highlight the matching tool button
            onSelectionChange(savedCorners); // restore() doesn't emit — fan out manually
        }
    }, hillshades);
    const engines: MapEngine[] = [olEngine];
    if (mapLibreSpecs.length) engines.push(new MapLibreTerrainEngine(mapLibreSpecs, mapsById));

    controller = new MapController({
        engines,
        container: mapMount,
        initialView,
        initialSunDate,
        initialShadows,
        onActiveChange: id => appInstance?.setActiveProvider(id),
        onViewPersist: v => { saveView(v); appInstance?.setMapZoom(v.zoom); scheduleUrlSync(); },
        onActivePersist: id => { saveActive(id); scheduleUrlSync(); },
    });

    // Selection / DEM / model changes alter the `c=` slice → keep the URL live.
    config.subscribe(() => scheduleUrlSync());

    if (initialId) controller.select(initialId);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
