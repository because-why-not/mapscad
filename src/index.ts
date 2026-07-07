import { mount, flushSync } from 'svelte';
import App from './app/App.svelte';
import './app/app.css';
import { Env } from './Env';
import { fetchTileMapManifest, type ManifestMap } from './kit/maptiles/TileMapManifest';
import { EXTERNAL_DEMS } from './kit/config/externalDems';
import { EXTERNAL_MAPS } from './kit/config/externalMaps';
import { prettifyMapName, iconForMapType, LOCAL_MAP_PREFIX, stripLocalPrefix } from './kit/config/mapMeta';
import { availableCustomMaps, elevationGroup } from './kit/config/customMaps';
import { MapController } from './kit/ui/MapController';
import { OpenLayersEngine } from './kit/ui/OpenLayersEngine';
import { MapLibreTerrainEngine } from './kit/ui/MapLibreTerrainEngine';
import { SelectionArea } from './kit/ui/SelectionArea';
import OlMap from 'ol/Map';
import DragBox from 'ol/interaction/DragBox';
import { OsmOverlay } from './kit/ui/OsmOverlay';
import { fetchFeatureRaw, parseWays, waysFromJson, type OsmElement } from './kit/mapelements/OverpassFeature';
import { OsmVectorData } from './kit/mapelements/OsmVectorData';
import { OSM_FEATURES, osmFeature } from './kit/mapelements/osmFeatures';
import { OSM_LABELS } from './app/osmLabels';
import { sampleSelectionHeights, rectExtent, tileCoverage } from './kit/maptiles/HeightSampler';
import { TerrainPreview } from './kit/ui/TerrainPreview';
import { MapModel, SelectionShape, type ModelGeometry } from './kit/MapModel';
import { MapscadSession } from './kit/MapscadSession';
import { PreviewConfigStore } from './kit/PreviewConfig';
import { exportModelStl } from './kit/StlMaker';
import { exportModel3mf } from './kit/ThreeMFMaker';
import { estimateMemory, measureMemory, formatBytes, memoryLevel, isOverBudget } from './kit/memory';
import type { GeoView, MapEngine } from './kit/ui/MapEngine';
import { groundResolution, zoomForResolution, type LonLat } from './kit/common/mathHelper';

// This file is the composition root: the only place that names concrete engines.
// Everything it wires together (MapController, App, persistence) is engine-agnostic.

const DEFAULT_VIEW: GeoView = { lng: 174.82131, lat: -41.14554, zoom: 6 }; 

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
// The OL 2D-map overlays, one per feature id (see mapelements/osmFeatures.ts), created once the OL
// map is ready. The element *data* itself now lives in the session below, not here.
const osmOverlays = new Map<string, OsmOverlay>();
// The kit session owns the element *data* (source of truth) + preview membership + the two typed
// events. index.ts is its renderer: it subscribes here and fans the events out to the overlays,
// object list and model — dataChanged → redraw overlay + list; previewChanged → re-bind to the grid.
const session = new MapscadSession();
session.on('dataChanged', renderOsmData);
session.on('previewChanged', syncOsmField);
// The currently selected element on the map / in the object list (one at a time, vector-editor
// style), or null. Drives the overlay highlight, the list highlight, and keyboard Space.
let selectedOsmElement: { featureId: string; elementId: number } | null = null;
// OSM element picking is disabled while an area-selection tool is active (those clicks draw/edit the
// selection rectangle); re-enabled when no draw tool is active, like a vector app's Select tool.
let osmPickActive = true;
// The OpenLayers map, captured once it's ready, so the click hit-test can reach it.
let olMap: OlMap | null = null;
// Transient box-select tool for the Data tab: drag a blue box to mark all OSM elements under it.
// It selects into the list marks only — nothing about it is persisted.
let dataBox: DragBox | null = null;

/** Compact toggle label for an elevation source name (drops the _elevation[_raw] tail). */
function demLabel(name: string): string {
    return prettifyMapName(name.replace(/_elevation(_raw)?$/i, ''));
}

/** Heightmap zoom range a DEM supports: lowest stored level to its native max. */
function demZoomRange(dem: ManifestMap | undefined): { min: number; max: number } {
    if (!dem) return { min: 0, max: 17 };
    return { min: dem.mmapsrv.minStoredZoom ?? dem.minzoom, max: dem.maxzoom };
}

/**
 * Zoom slider range + default for a selection, derived from the resolution the mesh will
 * actually use. The grid is capped to `limit` samples on its long side, so its finest useful
 * sample spacing is longSideMetres / limit; the (fractional) DEM zoom matching that spacing is
 * the "natural" zoom — beyond it, finer tiles only add detail the grid discards (slower, and
 * harder on the external tile servers). We round the natural zoom UP, then:
 *   - `max`: one level finer than that (a little bilinear headroom) — the user can't pick higher.
 *   - `def`: one level coarser — the preview opens fast and light.
 * Both clamped to the zooms the DEM actually stores.
 */
function resolutionZoomRange(corners: LonLat[], dem: ManifestMap, raster: number): { min: number; max: number; def: number } {
    const { min: dMin, max: dMax } = demZoomRange(dem);
    const { widthMeters, heightMeters } = rectExtent(corners);
    const longSide = Math.max(widthMeters, heightMeters);
    // The zoom at which one DEM pixel ≈ one raster cell — the natural match. Above it the DEM is
    // finer than the grid can hold (wasted downloads); below it the grid interpolates the DEM.
    const natural = Math.ceil(zoomForResolution(corners[0][1], longSide / raster, dem.mmapsrv.tileSize));
    const max = Math.min(dMax, natural + 1);
    const def = Math.max(dMin, Math.min(max, natural - 1));
    return { min: dMin, max, def };
}

/** Model grid size: exactly `raster` samples on the long side, the short side scaled to the
 *  selection's aspect ratio. Independent of the DEM zoom — the DEM is bilinearly sampled (and
 *  interpolated when it's coarser) to fill this grid, so the raster resolution alone sets mesh
 *  density. That lets OSM feature bodies carry finer detail than the heightmap provides. */
function gridResolution(corners: LonLat[], raster: number): { cols: number; rows: number } {
    const { widthMeters, heightMeters } = rectExtent(corners);
    const long = Math.max(widthMeters, heightMeters);
    const cols = Math.max(2, Math.round(raster * widthMeters / long));
    const rows = Math.max(2, Math.round(raster * heightMeters / long));
    return { cols, rows };
}

/** Largest zoom ≤ desired whose DEM download + mesh fits the memory budget. The grid is fixed by
 *  the raster resolution (zoom-independent now), so lowering the zoom only shrinks the DEM tile
 *  download; the mesh footprint is bounded by the raster resolution regardless. */
function safeZoom(corners: LonLat[], desired: number, raster: number): number {
    const zMin = previewDem!.mmapsrv.minStoredZoom ?? previewDem!.minzoom;
    const zMax = previewDem!.maxzoom;
    let z = Math.max(zMin, Math.min(zMax, Math.round(desired)));
    const { cols, rows } = gridResolution(corners, raster);
    for (; z > zMin; z--) {
        const cov = tileCoverage(corners, previewDem!, z);
        const est = estimateMemory({ cols, rows, tilesX: cov.tilesX, tilesY: cov.tilesY, tileSize: previewDem!.mmapsrv.tileSize });
        if (!isOverBudget(est.totalBytes)) break;
    }
    return z;
}

// In-flight DEM sampling, so a new build (or the user's Cancel) aborts the previous one.
let resampleAbort: AbortController | null = null;

/** Re-sample the DEM over the current selection and feed the heights into the model. */
async function resample(): Promise<void> {
    const corners = session.getSelection();
    if (!previewDem || !corners) return;
    resampleAbort?.abort();              // supersede any build still downloading
    const abort = new AbortController();
    resampleAbort = abort;
    Env.log('[3d] regenerating terrain…');
    const t0 = performance.now();
    appInstance?.setPreviewLoading({ loaded: 0, total: 0 }); // show the bottom progress bar
    try {
        const { heightZoom, rasterResolution } = model.getSettings();
        const zoom = safeZoom(corners, heightZoom, rasterResolution);
        const { cols, rows } = gridResolution(corners, rasterResolution);
        const grid = await sampleSelectionHeights(corners, previewDem, cols, rows, zoom, {
            signal: abort.signal,
            onProgress: (loaded, total) => appInstance?.setPreviewLoading({ loaded, total }),
        });
        if (abort.signal.aborted) return;
        model.setGrid(grid); // notifies -> preview + stats rebuild from the model
        session.resyncPreview(); // re-rasterise added features to the new grid
        Env.log(`[3d] terrain regenerated in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') Env.log('[3d] terrain build cancelled');
        else Env.error('resample', e);
    } finally {
        // On success setGrid kicked off the worker build, which now owns the progress bar (it hides
        // it when done) — only clear it here if no build took over (download error/abort). The
        // `resampleAbort === abort` guard stops a superseded resample from clobbering the live bar.
        if (resampleAbort === abort) { resampleAbort = null; if (!buildBusy) appInstance?.setPreviewLoading(null); }
    }
}

/** User clicked Cancel on the loading bar — stop whichever phase is running (DEM download or the
 *  off-thread build), keeping the previous preview. */
function cancelResample(): void {
    resampleAbort?.abort();
    cancelBuild();
}

/** Bind one OSM feature's downloaded ways to the model's grid and hand them over (or clear them).
 *  Called whenever the data or the grid change; the matching OsmCanvasProcessor paints them in. */
function syncOsmField(id: string): void {
    const grid = model.getGrid();
    const data = session.getElements(id);
    const corners = session.getSelection();
    if (!data || !corners || !grid) { model.setOsmData(id, null); return; }
    // Disabled elements stay in the list/overlay but are excluded from the printed model.
    const enabled = data.list.filter(e => !e.disabled);
    const enabledData = new OsmVectorData(enabled);
    const bound = enabledData.withGrid({ corners, cols: grid.cols, rows: grid.rows });
    model.setOsmData(id, bound);
}

/** Ingest a freshly fetched / uploaded element set for one feature: it becomes the editable source
 *  of truth, the overlay redraws, the object list refreshes, and (only if already added to the
 *  preview) the model re-syncs — so downloading a large set just to view/edit it on the map doesn't
 *  trigger a geometry rebuild. */
function ingestOsm(id: string, elements: OsmElement[]): void {
    // Hand the data to the session; it emits dataChanged (→ overlay + list) and, iff the feature is
    // already in the print, previewChanged (→ re-bind + rebuild). See renderOsmData / syncOsmField.
    session.setElements(id, elements);
}

/** Renderer response to a `dataChanged` event: redraw the feature's OL overlay. A feature with no
 *  data (deleted by clearAll) fully clears the overlay — resetting its selection/hover/mark state;
 *  an empty-but-present set (all elements removed) just draws nothing. The object *list* is no longer
 *  pushed from here — the Data panel subscribes to the session's dataChanged itself. */
function renderOsmData(id: string): void {
    const data = session.getElements(id);
    const overlay = osmOverlays.get(id);
    if (data) overlay?.setElements(data.list); else overlay?.clear();
}

/** Select one element (map ↔ list), or pass null to clear. Highlights it on the map and in the list. */
function selectOsm(featureId: string | null, elementId: number | null): void {
    selectedOsmElement = featureId !== null && elementId !== null ? { featureId, elementId } : null;
    osmOverlays.forEach((ov, id) => ov.setSelected(selectedOsmElement?.featureId === id ? selectedOsmElement.elementId : null));
    appInstance?.setOsmSelected(selectedOsmElement?.featureId ?? null, selectedOsmElement?.elementId ?? null);
}

/** Transiently highlight an element on the map (from a list-row hover); null clears it. Does not
 *  change the selection or the view. */
function hoverOsm(featureId: string | null, elementId: number | null): void {
    osmOverlays.forEach((ov, id) => ov.setHovered(featureId === id ? elementId : null));
}

// Width (px) of the open OSM-data panel; the centred element is shifted left of it so it stays visible.
const OSM_PANEL_PX = 288; // matches the panel's w-72

/** Centre the map on an element (used when it's picked from the list — it may be off-screen) WITHOUT
 *  changing the zoom. The centre is nudged so the element sits in the middle of the map area left of
 *  the open OSM-data panel rather than underneath it. */
function panToOsm(featureId: string, elementId: number): void {
    const extent = osmOverlays.get(featureId)?.extentOf(elementId);
    if (!extent || !olMap) return;
    const view = olMap.getView();
    const res = view.getResolution() ?? 0;
    const cx = (extent[0] + extent[2]) / 2 + (OSM_PANEL_PX / 2) * res;
    const cy = (extent[1] + extent[3]) / 2;
    view.animate({ center: [cx, cy], duration: 250 });
}

/** Enable/disable a batch of elements for a feature (the user's Enable/Disable button): flip the
 *  `disabled` flag on the given ids, redraw the overlay (disabled ones go grey), and refresh the
 *  list (struck-through). The preview is intentionally NOT re-synced here — disabling only affects
 *  the print on the next "Add to preview" press. */
function applyOsmEnabled(featureId: string, ids: number[], enabled: boolean): void {
    session.setEnabled(featureId, ids, enabled); // dataChanged only → overlay + list, no preview resync
}

/** Permanently remove the marked elements from a feature (the Disable button's 3-second long-press).
 *  Same downstream refresh as enable/disable (data + overlay + list); a selection pointing at a
 *  deleted element is cleared. Like disable, the preview only reflects it on the next Update preview. */
function removeOsmElements(featureId: string, ids: number[]): void {
    session.remove(featureId, ids); // dataChanged only → overlay + list
    // A selection pointing at a just-deleted element is cleared (UI concern, not the session's).
    if (selectedOsmElement?.featureId === featureId && ids.includes(selectedOsmElement.elementId)) {
        selectOsm(null, null);
    }
}

/** Map click handler (only while no draw tool is active): select the topmost OSM element under the
 *  click, or clear the selection when the click misses every OSM feature. */
function onMapClick(pixel: number[]): void {
    if (!osmPickActive || !olMap) return;
    let hit = false;
    olMap.forEachFeatureAtPixel(pixel, (feature, layer) => {
        const featureId = layer?.get('osmFeatureId');
        const elementId = feature.get('osmElementId');
        if (typeof featureId === 'string' && typeof elementId === 'number') {
            selectOsm(featureId, elementId);
            hit = true;
            return true; // stop at the topmost OSM feature
        }
        return false;
    }, { hitTolerance: 4, layerFilter: (l) => !!l.get('osmFeatureId') });
    if (!hit) selectOsm(null, null);
}

// Resampling hits the network, so changes to zoom / resolution limit are debounced.
let resampleTimer = 0;
function scheduleResample(): void {
    clearTimeout(resampleTimer);
    resampleTimer = window.setTimeout(resample, 200);
}

// Off-main-thread geometry build. Every model change rebuilds the preview in a worker so the heavy
// build/buildKept math (and the weld) never blocks the UI, and the user can watch + cancel it on the
// shared progress bar. One worker, latest-wins: while a build is in flight, the newest change is held
// in `buildPending` and started on completion (intermediate slider ticks are skipped). Cancel and an
// error/recreate just terminate the worker; the next build lazily spins up a fresh one.
let buildWorker: Worker | null = null;
let buildSeq = 0;            // id of the in-flight build; stale messages (after cancel) are ignored
let buildBusy = false;
let buildPending = false;

function getBuildWorker(): Worker {
    if (!buildWorker) {
        buildWorker = new Worker(new URL('./kit/model/geometry.worker.ts', import.meta.url));
        buildWorker.onmessage = onBuildMessage;
        buildWorker.onerror = (e) => { Env.error('build worker', e.message); finishBuild(); };
    }
    return buildWorker;
}

/** The model changed (new heights or new settings): rebuild the preview + stats off-thread. */
function onModelChange(): void {
    const grid = model.getGrid();
    if (!grid) {                          // selection cleared: drop the preview, stats, and any build
        cancelBuild();
        preview?.setGeometry(null);
        appInstance?.setPreviewStats(null);
        return;
    }
    if (buildBusy) { buildPending = true; return; } // newest change wins when the current build ends
    startBuild();
}

/** Kick off a build of the current model state in the worker, showing the progress bar. */
function startBuild(): void {
    const input = model.prepareBuildInput();
    if (!input) return;
    buildBusy = true;
    buildPending = false;
    const id = ++buildSeq;
    appInstance?.setPreviewLoading({ phase: 'build', percent: 0 });
    // Copy (no transfer): `input.grid` / OSM coverage may be the model's own arrays — don't detach them.
    getBuildWorker().postMessage({ id, grid: input.grid, settings: input.settings, osmBodies: input.osmBodies });
}

function onBuildMessage(e: MessageEvent): void {
    const msg = e.data;
    if (msg.id !== buildSeq) return; // superseded by a cancel / newer build
    if (msg.type === 'progress') {
        appInstance?.setPreviewLoading({ phase: 'build', percent: Math.round(msg.fraction * 100) });
        return;
    }
    if (msg.type === 'error') { Env.error('build', msg.message); finishBuild(); return; }
    // done
    const geo: ModelGeometry = msg.geo;
    preview?.setGeometry(geo);
    updatePreviewStats(geo);
    finishBuild();
}

/** Current build settled (done / error): start the queued one if any, else hide the bar. */
function finishBuild(): void {
    buildBusy = false;
    if (buildPending) startBuild();
    else appInstance?.setPreviewLoading(null);
}

/** User Cancel (or a model clear): abandon the in-flight build, keep the existing preview. */
function cancelBuild(): void {
    if (buildWorker) { buildWorker.terminate(); buildWorker = null; }
    buildSeq++;            // invalidate any late message from the terminated worker
    buildBusy = false;
    buildPending = false;
    appInstance?.setPreviewLoading(null);
}

/** Push the realistic mesh stats for a freshly built geometry to the overlay. */
function updatePreviewStats(geo: ModelGeometry | null): void {
    const grid = model.getGrid();
    if (!grid || !geo) { appInstance?.setPreviewStats(null); return; }
    const mem = measureMemory(geo, grid); // realistic: from the actual built mesh, not a grid guess
    const surfaceVerts = grid.cols * grid.rows;
    // Ground resolution (metres per DEM pixel) at the heightmap zoom, and the DEM's effective pixel
    // size over the selection — now distinct from the raster grid, since the DEM is interpolated to
    // fill the grid. Lets the user compare real heightmap detail against the vertex grid below it.
    const corners = session.getSelection();
    const hmRes = corners
        ? groundResolution(corners[0][1], grid.zoom, previewDem?.mmapsrv.tileSize)
        : undefined;
    appInstance?.setPreviewStats({
        vertices: geo.vertexCount,
        triangles: geo.triangleCount,
        zoom: grid.zoom,
        zoomResolution: hmRes,
        heightmapCols: hmRes ? Math.max(1, Math.round(grid.widthMeters / hmRes)) : undefined,
        heightmapRows: hmRes ? Math.max(1, Math.round(grid.heightMeters / hmRes)) : undefined,
        widthMeters: Math.round(grid.widthMeters),
        heightMeters: Math.round(grid.heightMeters),
        minThickness: geo.minThickness,   // thinnest/thickest solid column, export units
        maxThickness: geo.maxThickness,
        minHeight: grid.minHeight,        // actual lowest/highest heightmap elevation, metres
        maxHeight: grid.maxHeight,
        gridCols: grid.cols,
        gridRows: grid.rows,
        // Side length of the square area a vertex represents (√ of the per-vertex area) — more
        // intuitive than the raw area.
        vertexSpacing: Math.sqrt((grid.widthMeters * grid.heightMeters) / surfaceVerts),
        memoryText: formatBytes(mem.totalBytes),
        memoryLevel: memoryLevel(mem.totalBytes),
    });
}

/** Drop every downloaded OSM feature — elements, 2D overlays, preview binding and UI. Used when the
 *  selection is CLEARED; a mere edit keeps the data and re-projects it to the new corners instead. */
function clearOsmData(): void {
    selectOsm(null, null);
    // clearAll fans out dataChanged (→ overlay.clear + empties the list) + previewChanged
    // (→ syncOsmField clears the model field) per feature; the availability reset is UI-only.
    session.clearAll(OSM_FEATURES.map(f => f.id));
    for (const def of OSM_FEATURES) appInstance?.setOsmAvailable(def.id, false);
}

/** Single place the selection state fans out: persistence, panel visibility, model. */
function onSelectionChange(corners: LonLat[] | null): void {
    const hadSelection = !!session.getSelection();
    config.update({ selection: corners });
    appInstance?.setPreviewVisible(!!corners); // App shows/hides the 3D panel
    // The longest selection side (metres) gates which OSM features can be downloaded (Env limits).
    const sideMeters = corners ? Math.max(...Object.values(rectExtent(corners))) : 0;
    session.setSelection(corners);

    if (!corners) {
        // Selection cleared: nothing to sample, so drop all downloaded data + reset the data panel.
        appInstance?.setHasSelection(false, 0, true);
        clearOsmData();
        model.setGrid(null); // notifies -> preview clears, stats null
        return;
    }

    // A brand-new selection starts clean (reset the panel); an EDIT of an existing one KEEPS the
    // downloaded data — the rasteriser re-clips it to the new grid on resample (syncOsmField), and the
    // bbox only shifts slightly — but flags it stale so the user knows it may miss the shifted area and
    // can re-download (Overpass rate-limits make a silent wipe an expensive click to lose).
    const isEdit = hadSelection;
    appInstance?.setHasSelection(true, sideMeters, !isEdit);
    if (isEdit) {
        for (const def of OSM_FEATURES) {
            if (session.getElements(def.id)) appInstance?.setOsmStale(def.id, true);
        }
    }
    resample(); // re-sample the DEM + re-sync any preview-added features to the new corners
}

/** A selection the user just drew/edited. A brand-new one defaults its heightmap zoom from the
 *  resolution the mesh needs (see resolutionZoomRange), so we don't fetch far more detail than
 *  the grid will use. */
function onUserSelectionChange(corners: LonLat[] | null): void {
    // Only seed defaults for a *brand-new* selection: corners exist (one was just drawn),
    // the session has no selection yet (so it's new, not an edit of an existing one), and we
    // have a live map to read the active source / visible zoom from.
    if (corners && !session.getSelection() && controller) {
        // Default the preview source to the DEM behind the active map layer (e.g. drawing on
        // North Island's hillshade/raw picks north_island_elevation_raw), if it differs.
        const activeDem = demBySource[controller.activeId];
        if (activeDem && mapsById[activeDem] && activeDem !== config.get().demId) {
            previewDem = mapsById[activeDem];
            config.update({ demId: activeDem });
            appInstance?.setPreviewDem(activeDem); // sync the preview's Source toggle
        }
        if (previewDem) {
            // Open at the resolution the mesh actually needs (one level below natural), and cap
            // how fine the user can go — so we don't fetch far more DEM detail than the grid uses.
            const { min, max, def } = resolutionZoomRange(corners, previewDem, model.getSettings().rasterResolution);
            model.applySettings({ heightZoom: def });
            config.update({ model: model.getSettings() });
            appInstance?.setPreviewZoomRange(min, max, def); // move the slider's range + value
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
// The hash carries only human-readable state: the map (name + lat/lng/zoom) always, and the
// selected area (corner lon/lats + shape) once one exists, e.g.
//   #map=north_island_hillshade_8m&lat=-41.27&lng=174.78&z=8.4
//   …&shape=oval&sel=174.7,-41.2;174.9,-41.2;174.9,-41.4;174.7,-41.4   (after a selection)
// The rest of the export config (DEM, model settings) is NOT shared — it lives in localStorage.

/** Parse the human-readable state from the URL hash (map, view, selected area), if present. */
function readUrlMapState(): { map?: string; view?: GeoView; selection?: LonLat[]; shape?: SelectionShape } {
    try {
        const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const lat = parseFloat(params.get('lat') ?? '');
        const lng = parseFloat(params.get('lng') ?? '');
        const zoom = parseFloat(params.get('z') ?? '');
        const view = [lat, lng, zoom].every(Number.isFinite) ? { lat, lng, zoom } : undefined;
        const shape = params.get('shape') === SelectionShape.Oval ? SelectionShape.Oval
            : params.get('shape') === SelectionShape.Rectangle ? SelectionShape.Rectangle : undefined;
        return { map: params.get('map') || undefined, view, selection: parseSelection(params.get('sel')), shape };
    } catch (e) { Env.error('read url map state', e); return {}; }
}

/** `lon,lat;lon,lat;lon,lat;lon,lat` -> four [lon,lat] corners, or undefined if malformed. */
function parseSelection(s: string | null): LonLat[] | undefined {
    if (!s) return undefined;
    const corners = s.split(';').map(pair => pair.split(',').map(Number) as LonLat);
    if (corners.length !== 4 || corners.some(c => c.length !== 2 || !c.every(Number.isFinite))) return undefined;
    return corners;
}

/** Compose the full hash URL: readable map state, plus the selected area when one exists. */
function composeShareUrl(): string {
    const v = controller?.getView() ?? DEFAULT_VIEW;
    const params: string[] = [];
    if (controller?.activeId) params.push(`map=${encodeURIComponent(controller.activeId)}`);
    params.push(`lat=${v.lat.toFixed(5)}`, `lng=${v.lng.toFixed(5)}`, `z=${v.zoom.toFixed(2)}`);
    const selection = config.get().selection;
    if (selection) {
        params.push(`shape=${config.get().model.shape}`);
        params.push(`sel=${selection.map(c => `${c[0].toFixed(5)},${c[1].toFixed(5)}`).join(';')}`);
    }
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

async function init(): Promise<void> {
    // One-off cleanup: these were folded into the single `previewConfig` key (PreviewConfig)
    // and are no longer read. Drop the orphans so they don't linger in users' storage.
    for (const k of ['previewSettings', 'previewDem', 'selectionCorners']) {
        try { localStorage.removeItem(k); } catch { /* ignore */ }
    }

    const serverMaps = await fetchTileMapManifest();
    // Namespace the self-hosted tile server's maps with LOCAL_MAP_PREFIX so their ids can't
    // collide with the public sources (a shared id would break the menu keys + layer lookups),
    // and so they sink to the bottom of the source list under "Custom Maps".
    for (const m of serverMaps) m.name = LOCAL_MAP_PREFIX + m.name;
    // Append the public internet-hosted base maps (OpenStreetMap, OpenTopoMap) and DEMs
    // (Mapterhorn, AWS) so the app is fully usable with no self-hosted tile server.
    const maps = [...serverMaps, ...EXTERNAL_MAPS, ...EXTERNAL_DEMS];
    mapsById = Object.fromEntries(maps.map(m => [m.name, m]));
    // Resolve a bare source name to the actual map id (public bare, or server-prefixed).
    const resolveSource = (name: string): string | null =>
        mapsById[name] ? name : (mapsById[LOCAL_MAP_PREFIX + name] ? LOCAL_MAP_PREFIX + name : null);
    const customSpecs = availableCustomMaps(mapsById);
    // Resolve any active map source to the DEM it represents (used to default the preview
    // source when a brand-new selection is drawn). Raw DEM layers map to themselves; the
    // synthesized 2D/3D hillshades map to their demSource.
    for (const m of maps) if (m.mmapsrv.type === 'elevation') demBySource[m.name] = m.name;
    for (const s of customSpecs) demBySource[s.id] = s.demSource;
    // The 3D preview can be built from any elevation DEM the server advertises (the
    // manifest tags those with mmapsrv.type === 'elevation'). Expose them all as a source
    // toggle; each DEM has its own zoom range, so switching also moves the zoom.
    const previewDems = maps
        .filter(m => m.mmapsrv.type === 'elevation')
        .map(m => ({ id: m.name, name: demLabel(stripLocalPrefix(m.name)), attribution: m.attributionDetail }));
    // A shared link carries the selected area (corners + shape) in readable form — adopt it so
    // it wins over the last local selection, then read the merged config below.
    const urlMapState = readUrlMapState();
    if (urlMapState.selection) {
        config.update({ selection: urlMapState.selection });
        if (urlMapState.shape) config.update({ model: { ...config.get().model, shape: urlMapState.shape } });
    }
    // Resolve the DEM from the saved config, else the first elevation source the manifest offers.
    const cfg = config.get();
    const initialDemId = (cfg.demId && mapsById[cfg.demId]?.mmapsrv.type === 'elevation')
        ? cfg.demId
        : (previewDems[0]?.id ?? '');
    previewDem = mapsById[initialDemId];

    // The zoom slider's range + default. With a restored selection, cap it to the resolution the
    // mesh needs (as when drawing a new one); otherwise it's just the DEM's full range until a
    // selection is drawn. A saved heightZoom is capped to the light resolution-based default
    // (`zr.def`, the same value a fresh draw opens at) — NEVER the range max — so a reload can't
    // silently refetch far finer DEM detail (many more tiles) than the default; an unset one (0)
    // opens at that default too. The user can still slide up to `zr.max` afterwards.
    // The raster resolution is deliberately NOT restored — every load starts at Env.rasterResolution
    // so a stale saved value can't silently change the mesh density (the user can still adjust it
    // in-session).
    const savedSelection = cfg.selection;
    let zr: { min: number; max: number; def: number };
    if (savedSelection && previewDem) {
        zr = resolutionZoomRange(savedSelection, previewDem, Env.rasterResolution);
    } else {
        const range = demZoomRange(previewDem);
        zr = { ...range, def: range.max };
    }
    const previewZoomMin = zr.min, previewZoomMax = zr.max;
    // Cap the saved zoom to the light default, never higher; an unset one (0) opens there too.
    const heightZoom = cfg.model.heightZoom > 0 ? Math.min(cfg.model.heightZoom, zr.def) : zr.def;
    model.applySettings({ ...cfg.model, heightZoom, rasterResolution: Env.rasterResolution });
    // Fold the resolved DEM + sanitized settings back into the config so it's consistent.
    config.update({ demId: initialDemId, model: model.getSettings() });
    const initialPreviewSettings: Record<string, any> = { ...model.getSettings(), smoothShading: cfg.display.smoothShading };

    const tileProviders = maps.map(m => {
        // Elevation DEMs are grouped with their synthesized 2D/3D hillshades under one heading
        // (derived from the DEM name, never hardcoded); the raw layer is the "Raw" entry there.
        const category = m.mmapsrv.type === 'elevation' ? elevationGroup(m.name) : undefined;
        return {
            id: m.name,
            // Inside a category the header already names the source, so the entry is just "Raw";
            // ungrouped maps keep their prettified name.
            name: category ? 'Raw' : (m.prettyName ?? prettifyMapName(stripLocalPrefix(m.name))),
            icon: iconForMapType(m.mmapsrv.type),
            category,
            server: m.name.startsWith(LOCAL_MAP_PREFIX),
            attribution: m.attributionDetail,
        };
    });
    const customMaps = customSpecs.map(s => {
        // A custom map (2D/3D hillshade, imagery) has no attribution of its own — it derives from
        // the DEM/imagery source it renders, so surface the underlying source's attribution.
        const srcId = resolveSource(s.demSource);
        return {
            id: s.id,
            name: s.name,
            icon: s.icon,
            category: s.category,
            attribution: srcId ? mapsById[srcId]?.attributionDetail : undefined,
        };
    });

    // Map name + view come from the URL hash if present (read above), else fall back to the
    // last-used local values, else defaults.
    const allIds = [...tileProviders.map(p => p.id), ...customMaps.map(c => c.id)];
    const saved = localStorage.getItem('activeProvider');
    const initialId = (urlMapState.map && allIds.includes(urlMapState.map)) ? urlMapState.map
        : (saved && allIds.includes(saved)) ? saved
        : (allIds[0] ?? '');

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
            onLayerSwitch: (id: string) => controller?.select(id),
            initialMapZoom: initialView.zoom,
            onSelectToggle: (active: boolean, shape: SelectionShape = SelectionShape.Rectangle) => {
                if (!selection) return;
                // While a draw tool is active, map clicks edit the area; OSM element picking is off.
                osmPickActive = !active;
                if (active) {
                    selectOsm(null, null);                  // leave element-edit mode
                    selection.setShape(shape);              // redraw + (if a selection exists) keep it
                    model.applySettings({ shape });         // mask is a model setting -> rebuilds geometry
                    config.update({ model: model.getSettings() });
                    selection.activate();
                } else {
                    selection.deactivate(); // emits onChange(null) -> hides preview
                }
            },
            onAspectChange: (ratio: number | null) => selection?.setAspect(ratio),
            // The Data tab locks the selection: view-only + a grey wash over everything outside it.
            // It's also where the user works with tracks, so OSM element picking is on here and off
            // while editing the area in the Selection tab (where map clicks edit the selection).
            onDataModeChange: (active: boolean) => {
                osmPickActive = active;
                selection?.setViewOnly(active);
                if (!active) dataBox?.setActive(false); // leaving Data turns the box tool off
            },
            // Toggle the transient box-select tool on the map (Data tab only).
            onBoxSelectToggle: (active: boolean) => {
                dataBox?.setActive(active);
                olMap?.getTargetElement()?.classList.toggle('map-crosshair', active);
            },
            // The menu sections to render (one per registry feature), so the UI is data-driven.
            features: OSM_FEATURES.map(f => ({ id: f.id, label: OSM_LABELS[f.id].label, noun: OSM_LABELS[f.id].noun, hasRadius: f.geometry === 'line', sizeLimit: f.sizeLimit })),
            session, // the Data panel subscribes to the session for element data (replaces setOsmElements)
            // Download one OSM feature for the current selection and overlay it on the map. Returns
            // the element count so the button can report it; throws bubble to the panel.
            onDownload: async (id: string) => {
                const corners = session.getSelection();
                if (!corners) return 0;
                const def = osmFeature(id);
                const json = await fetchFeatureRaw(def, corners);
                const fetched = parseWays(def, json);
                ingestOsm(id, fetched);
                return fetched.length;
            },
            // The current element set as savable JSON. Null when nothing's loaded.
            onSaveJson: (id: string) => {
                const data = session.getElements(id);
                return data && !data.isEmpty() ? data.list : null;
            },
            // Load a feature from one or more previously saved / track files: parse each payload and
            // MERGE into one set (multi-file select). Real OSM ids (positive) are deduped so the same
            // way in two overlapping files appears once; synthetic ids (GPX tracks / legacy polylines,
            // negative) are renumbered to a single running counter so they stay unique across files —
            // `waysFromJson` restarts them at -1 per payload. Ingested + overlaid like a fresh download.
            onLoadJson: (id: string, payloads: any[]) => {
                const def = osmFeature(id);
                const seen = new Set<number>();
                const merged: OsmElement[] = [];
                let synthetic = -1;
                for (const payload of payloads) {
                    for (const el of waysFromJson(def, payload)) {
                        if (el.id > 0) {
                            if (seen.has(el.id)) continue; // same OSM way already loaded from an earlier file
                            seen.add(el.id);
                            merged.push(el);
                        } else {
                            const renumbered = { ...el, id: synthetic-- };
                            merged.push(renumbered);
                        }
                    }
                }
                ingestOsm(id, merged);
                return merged.length;
            },
            // Push the downloaded feature into the model: bind it to the grid and reveal the
            // preview's section so its raise can be configured.
            onUpdatePreview: (id: string) => {
                if (!session.hasElements(id)) return;
                session.updatePreview(id); // previewChanged → syncOsmField binds it to the grid
                appInstance?.setOsmAvailable(id, true);
            },
            // Select an element (highlight it + bring it into the map view, since the list row may be off-screen).
            onSelectElement: (id: string, elementId: number) => { selectOsm(id, elementId); panToOsm(id, elementId); },
            // Enable/disable the user's marked elements for a feature (Enable/Disable in the menu).
            onSetEnabled: (id: string, ids: number[], enabled: boolean) => applyOsmEnabled(id, ids, enabled),
            // Delete the user's marked elements for a feature (Disable button, 3-second long-press).
            onDelete: (id: string, ids: number[]) => removeOsmElements(id, ids),
            // Hovering a list row highlights it on the map (no centring); null clears the highlight.
            onHoverElement: (id: string | null, elementId: number | null) => hoverOsm(id, elementId),
            // The user's ticked (marked) elements, highlighted on the map as they stage an edit.
            onMarksChange: (id: string, ids: number[]) => osmOverlays.get(id)?.setMarked(ids),
            previewDems,
            initialPreviewDemId: initialDemId,
            previewZoomMin,
            previewZoomMax,
            initialPreviewSettings,
            onPreviewDemChange: (id: string) => {
                if (!mapsById[id]) return;
                previewDem = mapsById[id];
                // Reset the zoom to the new source's resolution-based default — each DEM has its own
                // native detail, so carrying the old level over rarely makes sense (and can over-
                // fetch). With a selection, that default + range come from the resolution the mesh needs.
                const corners = session.getSelection();
                const { min, max, def } = corners
                    ? resolutionZoomRange(corners, previewDem, model.getSettings().rasterResolution)
                    : { ...demZoomRange(previewDem), def: demZoomRange(previewDem).max };
                model.applySettings({ heightZoom: def });
                config.update({ demId: id, model: model.getSettings() });
                appInstance?.setPreviewZoomRange(min, max, def); // move the slider's range + value
                resample();
            },
            //triggered when the user changes settings in the side menu
            //(note this is not triggered when the selection changes)
            onPreviewSettingsChange: (s: Record<string, any>) => {
                const prev = model.getSettings();
                model.applySettings(s); // rebuilds geometry from the current grid
                config.update({ model: model.getSettings(), display: { smoothShading: s.smoothShading ?? true } });
                preview?.setSmoothShading(s.smoothShading ?? true); // display-only
                // The raster resolution sets where the DEM zoom stops being useful (one DEM pixel per
                // raster cell), so recompute the slider range + clamp the current zoom into it when it changes.
                const corners = session.getSelection();
                if (s.rasterResolution !== prev.rasterResolution && corners && previewDem) {
                    const { min, max } = resolutionZoomRange(corners, previewDem, s.rasterResolution);
                    const heightZoom = Math.max(min, Math.min(max, model.getSettings().heightZoom));
                    model.applySettings({ heightZoom });
                    config.update({ model: model.getSettings() });
                    appInstance?.setPreviewZoomRange(min, max, heightZoom);
                }
                // Zoom / raster resolution change the sampling itself, so re-fetch the heights.
                if (s.heightZoom !== prev.heightZoom || s.rasterResolution !== prev.rasterResolution) {
                    scheduleResample();
                }
            },
            onPreviewGenerate: (s: Record<string, any>) => { model.applySettings(s); config.update({ model: model.getSettings() }); resample(); },
            onPreviewSave: (s: Record<string, any>) => { model.applySettings(s); config.update({ model: model.getSettings() }); exportModelStl(model); },
            onPreviewSave3mf: (s: Record<string, any>) => { model.applySettings(s); config.update({ model: model.getSettings() }); exportModel3mf(model); },
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
    const olEngine = new OpenLayersEngine(maps, map => {
        if (selection) return;
        olMap = map; // capture for the OSM click hit-test
        selection = new SelectionArea(map, { onChange: onUserSelectionChange });
        // One overlay per registry feature, in zIndex order (the registry sets each zIndex).
        for (const def of OSM_FEATURES) {
            const overlay = new OsmOverlay(map, def);
            osmOverlays.set(def.id, overlay);
        }
        // Click an OSM element to select it (vector-editor style); Delete removes the selected one.
        map.on('singleclick', (e) => onMapClick(e.pixel));
        // Box-select tool (Data tab): drag a box, mark every OSM element it intersects. Inactive
        // until the tool is toggled on; suppresses pan while dragging (DragBox consumes the drag).
        dataBox = new DragBox({ className: 'ol-dragbox data-box' });
        dataBox.setActive(false);
        dataBox.on('boxend', () => {
            const extent = dataBox!.getGeometry().getExtent();
            osmOverlays.forEach((overlay, featureId) => {
                const ids = overlay.elementsInExtent(extent);
                if (ids.length) appInstance?.addOsmMarks(featureId, ids);
            });
        });
        map.addInteraction(dataBox);
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
