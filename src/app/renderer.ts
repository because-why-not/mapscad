import { OsmVectorData } from '../kit/mapelements/OsmVectorData';
import { fetchFeatureRaw, parseWays, waysFromJson, type OsmElement } from '../kit/mapelements/OverpassFeature';
import { OSM_FEATURES, osmFeature } from '../kit/mapelements/osmFeatures';
import { sampleSelectionHeights, rectExtent, tileCoverage } from '../kit/maptiles/HeightSampler';
import type { ManifestMap } from '../kit/maptiles/TileMapManifest';
import { SelectionShape, type MapModel, type ModelGeometry } from '../kit/MapModel';
import type { MapscadSession } from '../kit/MapscadSession';
import type { ProcessorConfigStore } from '../kit/ProcessorConfig';
import type { TerrainPreview } from '../kit/ui/TerrainPreview';
import type { MapController } from '../kit/ui/MapController';
import type { SelectionArea } from '../kit/ui/SelectionArea';
import type { OsmOverlay } from '../kit/ui/OsmOverlay';
import { exportModelStl } from '../kit/StlMaker';
import { exportModel3mf } from '../kit/ThreeMFMaker';
import { estimateMemory, measureMemory, formatBytes, memoryLevel, isOverBudget } from '../kit/memory';
import { groundResolution, zoomForResolution, type LonLat } from '../kit/common/mathHelper';
import { composeShareUrl } from './urlState';
import { saveSmoothShading } from './uiPrefs';
import { Env } from '../Env';
import type OlMap from 'ol/Map';
import type DragBox from 'ol/interaction/DragBox';

// Width (px) of the open OSM-data panel; the centred element is shifted left of it so it stays visible.
const OSM_PANEL_PX = 288; // matches the panel's w-72

/** Heightmap zoom range a DEM supports: lowest stored level to its native max. */
export function demZoomRange(dem: ManifestMap | undefined): { min: number; max: number } {
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
export function resolutionZoomRange(corners: LonLat[], dem: ManifestMap, raster: number): { min: number; max: number; def: number } {
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
export function gridResolution(corners: LonLat[], raster: number): { cols: number; rows: number } {
    const { widthMeters, heightMeters } = rectExtent(corners);
    const long = Math.max(widthMeters, heightMeters);
    const cols = Math.max(2, Math.round(raster * widthMeters / long));
    const rows = Math.max(2, Math.round(raster * heightMeters / long));
    return { cols, rows };
}

/**
 * The renderer / second adapter: subscribes to the kit's `MapscadSession` + `MapModel` events and
 * drives the concrete viewers (OpenLayers overlays + selection tool, the Three.js `TerrainPreview`)
 * and the off-thread geometry build. It also fans UI commands (download, enable/disable, settings)
 * back into the session/model. The composition root (index.ts) constructs it, then wires the mounted
 * Svelte `app`, the `preview`, the `controller`, and the OL objects (`olMap`, `selection`, `dataBox`,
 * `osmOverlays`) into its public fields once each is ready.
 *
 * `kit → app` still holds: this lives in `app/` and imports the kit; the kit never imports it.
 */
export class MapscadRenderer {
    // --- UI / viewer handles, wired in by index.ts after mount + engine setup ---
    /** The mounted Svelte App instance (imperative forwarders: setPreviewStats, setOsmAvailable, …). */
    app: any = null;
    preview: TerrainPreview | null = null;
    controller: MapController | null = null;
    /** The OpenLayers map, captured once ready, so the click hit-test can reach it. */
    olMap: OlMap | null = null;
    selection: SelectionArea | null = null;
    /** Transient box-select tool for the Data tab (marks OSM elements under a dragged box). */
    dataBox: DragBox | null = null;
    /** The OL 2D-map overlays, one per feature id — the element data lives in the session, not here. */
    readonly osmOverlays = new Map<string, OsmOverlay>();

    /** The DEM the 3D preview is built from, and the manifest lookups used to resolve/switch it. */
    previewDem: ManifestMap | undefined;
    mapsById: Record<string, ManifestMap> = {};
    // Active map-source id -> the elevation DEM it represents (raw DEM = itself, a hillshade/3D map =
    // its underlying DEM). Lets a brand-new selection default the preview to the source in view.
    demBySource: Record<string, string> = {};

    // The currently selected element on the map / in the object list (one at a time), or null.
    private selectedOsmElement: { featureId: string; elementId: number } | null = null;
    // OSM element picking is off while an area-selection draw tool is active (those clicks edit the
    // selection rectangle); on otherwise, like a vector app's Select tool.
    osmPickActive = true;

    // In-flight DEM sampling, so a new build (or the user's Cancel) aborts the previous one.
    private resampleAbort: AbortController | null = null;
    private resampleTimer = 0;
    private urlSyncTimer = 0;

    // Off-main-thread geometry build. Every model change rebuilds the preview in a worker so the heavy
    // build/weld math never blocks the UI. One worker, latest-wins: while a build is in flight the newest
    // change is held in `buildPending` and started on completion. Cancel/error just terminate the worker;
    // the next build lazily spins up a fresh one.
    private buildWorker: Worker | null = null;
    private buildSeq = 0;        // id of the in-flight build; stale messages (after cancel) are ignored
    private buildBusy = false;
    private buildPending = false;

    constructor(
        private readonly session: MapscadSession,
        private readonly model: MapModel,
        private readonly config: ProcessorConfigStore,
    ) {
        // index.ts is the session's renderer: dataChanged → redraw overlay; previewChanged → re-bind
        // to the grid. (The object *list* is rendered by the Data panel, which subscribes itself.)
        session.on('dataChanged', (id) => this.renderOsmData(id));
        session.on('previewChanged', (id) => this.syncOsmField(id));
    }

    // --- DEM sampling + zoom -----------------------------------------------------

    /** Largest zoom ≤ desired whose DEM download + mesh fits the memory budget. The grid is fixed by
     *  the raster resolution (zoom-independent now), so lowering the zoom only shrinks the DEM tile
     *  download; the mesh footprint is bounded by the raster resolution regardless. */
    private safeZoom(corners: LonLat[], desired: number, raster: number): number {
        const dem = this.previewDem!;
        const zMin = dem.mmapsrv.minStoredZoom ?? dem.minzoom;
        const zMax = dem.maxzoom;
        let z = Math.max(zMin, Math.min(zMax, Math.round(desired)));
        const { cols, rows } = gridResolution(corners, raster);
        for (; z > zMin; z--) {
            const cov = tileCoverage(corners, dem, z);
            const est = estimateMemory({ cols, rows, tilesX: cov.tilesX, tilesY: cov.tilesY, tileSize: dem.mmapsrv.tileSize });
            if (!isOverBudget(est.totalBytes)) break;
        }
        return z;
    }

    /** Re-sample the DEM over the current selection and feed the heights into the model. */
    private async resample(): Promise<void> {
        const corners = this.session.getSelection();
        if (!this.previewDem || !corners) return;
        this.resampleAbort?.abort();              // supersede any build still downloading
        const abort = new AbortController();
        this.resampleAbort = abort;
        Env.log('[3d] regenerating terrain…');
        const t0 = performance.now();
        this.app?.setPreviewLoading({ loaded: 0, total: 0 }); // show the bottom progress bar
        try {
            const { heightZoom, rasterResolution } = this.model.getSettings();
            const zoom = this.safeZoom(corners, heightZoom, rasterResolution);
            const { cols, rows } = gridResolution(corners, rasterResolution);
            const grid = await sampleSelectionHeights(corners, this.previewDem, cols, rows, zoom, {
                signal: abort.signal,
                onProgress: (loaded, total) => this.app?.setPreviewLoading({ loaded, total }),
            });
            if (abort.signal.aborted) return;
            this.model.setGrid(grid); // notifies -> preview + stats rebuild from the model
            this.session.resyncPreview(); // re-rasterise added features to the new grid
            Env.log(`[3d] terrain regenerated in ${Math.round(performance.now() - t0)} ms`);
        } catch (e) {
            if ((e as { name?: string })?.name === 'AbortError') Env.log('[3d] terrain build cancelled');
            else Env.error('resample', e);
        } finally {
            // On success setGrid kicked off the worker build, which now owns the progress bar (it hides
            // it when done) — only clear it here if no build took over (download error/abort). The
            // `resampleAbort === abort` guard stops a superseded resample from clobbering the live bar.
            if (this.resampleAbort === abort) { this.resampleAbort = null; if (!this.buildBusy) this.app?.setPreviewLoading(null); }
        }
    }

    /** User clicked Cancel on the loading bar — stop whichever phase is running (DEM download or the
     *  off-thread build), keeping the previous preview. */
    cancelResample(): void {
        this.resampleAbort?.abort();
        this.cancelBuild();
    }

    // Resampling hits the network, so changes to zoom / resolution limit are debounced.
    private scheduleResample(): void {
        clearTimeout(this.resampleTimer);
        this.resampleTimer = window.setTimeout(() => this.resample(), 200);
    }

    // --- OSM data glue (session events -> overlays + model) ----------------------

    /** Bind one OSM feature's downloaded ways to the model's grid and hand them over (or clear them).
     *  Called whenever the data or the grid change; the matching OsmCanvasProcessor paints them in. */
    private syncOsmField(id: string): void {
        const grid = this.model.getGrid();
        const data = this.session.getElements(id);
        const corners = this.session.getSelection();
        if (!data || !corners || !grid) { this.model.setOsmData(id, null); return; }
        // Disabled elements stay in the list/overlay but are excluded from the printed model.
        const enabled = data.list.filter(e => !e.disabled);
        const enabledData = new OsmVectorData(enabled);
        const bound = enabledData.withGrid({ corners, cols: grid.cols, rows: grid.rows });
        this.model.setOsmData(id, bound);
    }

    /** Ingest a freshly fetched / uploaded element set for one feature: it becomes the editable source
     *  of truth, the overlay redraws, the object list refreshes, and (only if already added to the
     *  preview) the model re-syncs — so downloading a large set just to view/edit it doesn't rebuild. */
    private ingestOsm(id: string, elements: OsmElement[]): void {
        this.session.setElements(id, elements);
    }

    /** Renderer response to a `dataChanged` event: redraw the feature's OL overlay. A feature with no
     *  data (deleted by clearAll) fully clears the overlay; an empty-but-present set draws nothing. */
    private renderOsmData(id: string): void {
        const data = this.session.getElements(id);
        const overlay = this.osmOverlays.get(id);
        if (data) overlay?.setElements(data.list); else overlay?.clear();
    }

    /** Select one element (map ↔ list), or pass null to clear. Highlights it on the map and in the list. */
    private selectOsm(featureId: string | null, elementId: number | null): void {
        this.selectedOsmElement = featureId !== null && elementId !== null ? { featureId, elementId } : null;
        this.osmOverlays.forEach((ov, id) => ov.setSelected(this.selectedOsmElement?.featureId === id ? this.selectedOsmElement.elementId : null));
        this.app?.setOsmSelected(this.selectedOsmElement?.featureId ?? null, this.selectedOsmElement?.elementId ?? null);
    }

    /** Select an element (highlight + bring it into view, since the list row may be off-screen). */
    selectElement(featureId: string, elementId: number): void {
        this.selectOsm(featureId, elementId);
        this.panToOsm(featureId, elementId);
    }

    /** Transiently highlight an element on the map (from a list-row hover); null clears it. */
    hoverOsm(featureId: string | null, elementId: number | null): void {
        this.osmOverlays.forEach((ov, id) => ov.setHovered(featureId === id ? elementId : null));
    }

    /** The user's ticked (marked) elements, highlighted on the map as they stage an edit. */
    setMarks(id: string, ids: number[]): void {
        this.osmOverlays.get(id)?.setMarked(ids);
    }

    /** Centre the map on an element (picked from the list — it may be off-screen) WITHOUT changing the
     *  zoom. The centre is nudged so it sits left of the open OSM-data panel rather than under it. */
    private panToOsm(featureId: string, elementId: number): void {
        const extent = this.osmOverlays.get(featureId)?.extentOf(elementId);
        if (!extent || !this.olMap) return;
        const view = this.olMap.getView();
        const res = view.getResolution() ?? 0;
        const cx = (extent[0] + extent[2]) / 2 + (OSM_PANEL_PX / 2) * res;
        const cy = (extent[1] + extent[3]) / 2;
        view.animate({ center: [cx, cy], duration: 250 });
    }

    /** Enable/disable a batch of elements (Enable/Disable button): flip `disabled`, redraw the overlay
     *  + list. The preview is NOT re-synced here — disabling only affects the print on the next Update. */
    applyOsmEnabled(featureId: string, ids: number[], enabled: boolean): void {
        this.session.setEnabled(featureId, ids, enabled); // dataChanged only → overlay + list, no resync
    }

    /** Permanently remove the marked elements (the Disable button's 3-second long-press). A selection
     *  pointing at a deleted element is cleared; the preview reflects it on the next Update preview. */
    removeOsmElements(featureId: string, ids: number[]): void {
        this.session.remove(featureId, ids); // dataChanged only → overlay + list
        if (this.selectedOsmElement?.featureId === featureId && ids.includes(this.selectedOsmElement.elementId)) {
            this.selectOsm(null, null);
        }
    }

    /** Download one OSM feature for the current selection and overlay it. Returns the element count. */
    async downloadFeature(id: string): Promise<number> {
        const corners = this.session.getSelection();
        if (!corners) return 0;
        const def = osmFeature(id);
        const json = await fetchFeatureRaw(def, corners);
        const fetched = parseWays(def, json);
        this.ingestOsm(id, fetched);
        return fetched.length;
    }

    /** The current element set as savable JSON. Null when nothing's loaded. */
    saveFeatureJson(id: string): readonly OsmElement[] | null {
        const data = this.session.getElements(id);
        return data && !data.isEmpty() ? data.list : null;
    }

    /** Load a feature from one or more saved / track files: parse each payload and MERGE into one set
     *  (multi-file select). Real OSM ids (positive) are deduped; synthetic ids (GPX tracks / legacy
     *  polylines, negative) are renumbered to a single running counter so they stay unique across files. */
    loadFeatureFiles(id: string, payloads: any[]): number {
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
        this.ingestOsm(id, merged);
        return merged.length;
    }

    /** Push the downloaded feature into the model: bind it to the grid and reveal its preview section. */
    updatePreviewFeature(id: string): void {
        if (!this.session.hasElements(id)) return;
        this.session.updatePreview(id); // previewChanged → syncOsmField binds it to the grid
        this.app?.setOsmAvailable(id, true);
    }

    /** Map click handler (only while no draw tool is active): select the topmost OSM element under the
     *  click, or clear the selection when the click misses every OSM feature. */
    onMapClick(pixel: number[]): void {
        if (!this.osmPickActive || !this.olMap) return;
        let hit = false;
        this.olMap.forEachFeatureAtPixel(pixel, (feature, layer) => {
            const featureId = layer?.get('osmFeatureId');
            const elementId = feature.get('osmElementId');
            if (typeof featureId === 'string' && typeof elementId === 'number') {
                this.selectOsm(featureId, elementId);
                hit = true;
                return true; // stop at the topmost OSM feature
            }
            return false;
        }, { hitTolerance: 4, layerFilter: (l) => !!l.get('osmFeatureId') });
        if (!hit) this.selectOsm(null, null);
    }

    /** Drop every downloaded OSM feature — elements, 2D overlays, preview binding and UI. Used when the
     *  selection is CLEARED; a mere edit keeps the data and re-projects it to the new corners instead. */
    private clearOsmData(): void {
        this.selectOsm(null, null);
        // clearAll fans out dataChanged (→ overlay.clear + empties the list) + previewChanged
        // (→ syncOsmField clears the model field) per feature; the availability reset is UI-only.
        this.session.clearAll(OSM_FEATURES.map(f => f.id));
        for (const def of OSM_FEATURES) this.app?.setOsmAvailable(def.id, false);
    }

    // --- off-thread geometry build ----------------------------------------------

    private getBuildWorker(): Worker {
        if (!this.buildWorker) {
            this.buildWorker = new Worker(new URL('../kit/model/geometry.worker.ts', import.meta.url));
            this.buildWorker.onmessage = (e) => this.onBuildMessage(e);
            this.buildWorker.onerror = (e) => { Env.error('build worker', e.message); this.finishBuild(); };
        }
        return this.buildWorker;
    }

    /** The model changed (new heights or new settings): rebuild the preview + stats off-thread. */
    onModelChange(): void {
        const grid = this.model.getGrid();
        if (!grid) {                          // selection cleared: drop the preview, stats, and any build
            this.cancelBuild();
            this.preview?.setGeometry(null);
            this.app?.setPreviewStats(null);
            return;
        }
        if (this.buildBusy) { this.buildPending = true; return; } // newest change wins when this build ends
        this.startBuild();
    }

    /** Kick off a build of the current model state in the worker, showing the progress bar. */
    private startBuild(): void {
        const input = this.model.prepareBuildInput();
        if (!input) return;
        this.buildBusy = true;
        this.buildPending = false;
        const id = ++this.buildSeq;
        this.app?.setPreviewLoading({ phase: 'build', percent: 0 });
        // Copy (no transfer): `input.grid` / OSM coverage may be the model's own arrays — don't detach them.
        this.getBuildWorker().postMessage({ id, grid: input.grid, settings: input.settings, osmBodies: input.osmBodies });
    }

    private onBuildMessage(e: MessageEvent): void {
        const msg = e.data;
        if (msg.id !== this.buildSeq) return; // superseded by a cancel / newer build
        if (msg.type === 'progress') {
            this.app?.setPreviewLoading({ phase: 'build', percent: Math.round(msg.fraction * 100) });
            return;
        }
        if (msg.type === 'error') { Env.error('build', msg.message); this.finishBuild(); return; }
        // done
        const geo: ModelGeometry = msg.geo;
        this.preview?.setGeometry(geo);
        this.updatePreviewStats(geo);
        this.finishBuild();
    }

    /** Current build settled (done / error): start the queued one if any, else hide the bar. */
    private finishBuild(): void {
        this.buildBusy = false;
        if (this.buildPending) this.startBuild();
        else this.app?.setPreviewLoading(null);
    }

    /** User Cancel (or a model clear): abandon the in-flight build, keep the existing preview. */
    private cancelBuild(): void {
        if (this.buildWorker) { this.buildWorker.terminate(); this.buildWorker = null; }
        this.buildSeq++;            // invalidate any late message from the terminated worker
        this.buildBusy = false;
        this.buildPending = false;
        this.app?.setPreviewLoading(null);
    }

    /** Push the realistic mesh stats for a freshly built geometry to the overlay. */
    private updatePreviewStats(geo: ModelGeometry | null): void {
        const grid = this.model.getGrid();
        if (!grid || !geo) { this.app?.setPreviewStats(null); return; }
        const mem = measureMemory(geo, grid); // realistic: from the actual built mesh, not a grid guess
        const surfaceVerts = grid.cols * grid.rows;
        // Ground resolution (metres per DEM pixel) at the heightmap zoom, and the DEM's effective pixel
        // size over the selection — distinct from the raster grid, since the DEM is interpolated to
        // fill the grid. Lets the user compare real heightmap detail against the vertex grid below it.
        const corners = this.session.getSelection();
        const hmRes = corners
            ? groundResolution(corners[0][1], grid.zoom, this.previewDem?.mmapsrv.tileSize)
            : undefined;
        this.app?.setPreviewStats({
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
            // Side length of the square area a vertex represents (√ of the per-vertex area).
            vertexSpacing: Math.sqrt((grid.widthMeters * grid.heightMeters) / surfaceVerts),
            memoryText: formatBytes(mem.totalBytes),
            memoryLevel: memoryLevel(mem.totalBytes),
        });
    }

    // --- selection orchestration ------------------------------------------------

    /** Single place the selection state fans out: persistence, panel visibility, model. */
    onSelectionChange(corners: LonLat[] | null): void {
        const hadSelection = !!this.session.getSelection();
        this.config.update({ selection: corners });
        this.app?.setPreviewVisible(!!corners); // App shows/hides the 3D panel
        // The longest selection side (metres) gates which OSM features can be downloaded (Env limits).
        const sideMeters = corners ? Math.max(...Object.values(rectExtent(corners))) : 0;
        this.session.setSelection(corners);

        if (!corners) {
            // Selection cleared: nothing to sample, so drop all downloaded data + reset the data panel.
            this.app?.setHasSelection(false, 0, true);
            this.clearOsmData();
            this.model.setGrid(null); // notifies -> preview clears, stats null
            return;
        }

        // A brand-new selection starts clean (reset the panel); an EDIT of an existing one KEEPS the
        // downloaded data — the rasteriser re-clips it to the new grid on resample (syncOsmField), and
        // the bbox only shifts slightly — but flags it stale so the user knows it may miss the shifted
        // area and can re-download (Overpass rate-limits make a silent wipe an expensive click to lose).
        const isEdit = hadSelection;
        this.app?.setHasSelection(true, sideMeters, !isEdit);
        if (isEdit) {
            for (const def of OSM_FEATURES) {
                if (this.session.getElements(def.id)) this.app?.setOsmStale(def.id, true);
            }
        }
        this.resample(); // re-sample the DEM + re-sync any preview-added features to the new corners
    }

    /** A selection the user just drew/edited. A brand-new one defaults its heightmap zoom from the
     *  resolution the mesh needs (see resolutionZoomRange), so we don't fetch far more detail than the
     *  grid will use. */
    onUserSelectionChange(corners: LonLat[] | null): void {
        // Only seed defaults for a *brand-new* selection: corners exist, the session has no selection
        // yet (so it's new, not an edit), and we have a live map to read the active source / zoom from.
        if (corners && !this.session.getSelection() && this.controller) {
            // Default the preview source to the DEM behind the active map layer (e.g. drawing on
            // North Island's hillshade/raw picks north_island_elevation_raw), if it differs.
            const activeDem = this.demBySource[this.controller.activeId];
            if (activeDem && this.mapsById[activeDem] && activeDem !== this.config.get().demId) {
                this.previewDem = this.mapsById[activeDem];
                this.config.update({ demId: activeDem });
                this.app?.setPreviewDem(activeDem); // sync the preview's Source toggle
            }
            if (this.previewDem) {
                // Open at the resolution the mesh actually needs (one level below natural), and cap how
                // fine the user can go — so we don't fetch far more DEM detail than the grid uses.
                const { min, max, def } = resolutionZoomRange(corners, this.previewDem, this.model.getSettings().rasterResolution);
                this.model.applySettings({ heightZoom: def });
                this.config.update({ model: this.model.getSettings() });
                this.app?.setPreviewZoomRange(min, max, def); // move the slider's range + value
            }
        }
        this.onSelectionChange(corners);
    }

    // --- area-selection tool + data-mode chrome (App menu commands) -------------

    /** Toggle a draw tool on/off. While active, map clicks edit the area and OSM picking is off. */
    toggleSelect(active: boolean, shape: SelectionShape = SelectionShape.Rectangle): void {
        if (!this.selection) return;
        this.osmPickActive = !active;
        if (active) {
            this.selectOsm(null, null);                // leave element-edit mode
            this.selection.setShape(shape);            // redraw + (if a selection exists) keep it
            this.model.applySettings({ shape });       // mask is a model setting -> rebuilds geometry
            this.config.update({ model: this.model.getSettings() });
            this.selection.activate();
        } else {
            this.selection.deactivate(); // emits onChange(null) -> hides preview
        }
    }

    setAspect(ratio: number | null): void {
        this.selection?.setAspect(ratio);
    }

    /** The Data tab locks the selection (view-only + grey wash outside it) and enables OSM picking. */
    setDataMode(active: boolean): void {
        this.osmPickActive = active;
        this.selection?.setViewOnly(active);
        if (!active) this.dataBox?.setActive(false); // leaving Data turns the box tool off
    }

    /** Toggle the transient box-select tool on the map (Data tab only). */
    toggleBoxSelect(active: boolean): void {
        this.dataBox?.setActive(active);
        this.olMap?.getTargetElement()?.classList.toggle('map-crosshair', active);
    }

    // --- preview source / settings (App 3D-view menu commands) ------------------

    changePreviewDem(id: string): void {
        if (!this.mapsById[id]) return;
        this.previewDem = this.mapsById[id];
        // Reset the zoom to the new source's resolution-based default — each DEM has its own native
        // detail, so carrying the old level over rarely makes sense (and can over-fetch).
        const corners = this.session.getSelection();
        const { min, max, def } = corners
            ? resolutionZoomRange(corners, this.previewDem, this.model.getSettings().rasterResolution)
            : { ...demZoomRange(this.previewDem), def: demZoomRange(this.previewDem).max };
        this.model.applySettings({ heightZoom: def });
        this.config.update({ demId: id, model: this.model.getSettings() });
        this.app?.setPreviewZoomRange(min, max, def); // move the slider's range + value
        this.resample();
    }

    /** The smooth-shading checkbox — a viewer-only pref: persist it app-side and re-shade the mesh
     *  directly. It never touches the model/config (it doesn't affect the exported geometry). */
    setSmoothShading(on: boolean): void {
        saveSmoothShading(on);
        this.preview?.setSmoothShading(on);
    }

    /** User changed settings in the side menu (NOT triggered when the selection changes). */
    changePreviewSettings(s: Record<string, any>): void {
        const prev = this.model.getSettings();
        this.model.applySettings(s); // rebuilds geometry from the current grid
        this.config.update({ model: this.model.getSettings() });
        // The raster resolution sets where the DEM zoom stops being useful (one DEM pixel per raster
        // cell), so recompute the slider range + clamp the current zoom into it when it changes.
        const corners = this.session.getSelection();
        if (s.rasterResolution !== prev.rasterResolution && corners && this.previewDem) {
            const { min, max } = resolutionZoomRange(corners, this.previewDem, s.rasterResolution);
            const heightZoom = Math.max(min, Math.min(max, this.model.getSettings().heightZoom));
            this.model.applySettings({ heightZoom });
            this.config.update({ model: this.model.getSettings() });
            this.app?.setPreviewZoomRange(min, max, heightZoom);
        }
        // Zoom / raster resolution change the sampling itself, so re-fetch the heights.
        if (s.heightZoom !== prev.heightZoom || s.rasterResolution !== prev.rasterResolution) {
            this.scheduleResample();
        }
    }

    generate(s: Record<string, any>): void {
        this.model.applySettings(s);
        this.config.update({ model: this.model.getSettings() });
        this.resample();
    }

    saveStl(s: Record<string, any>): void {
        this.model.applySettings(s);
        this.config.update({ model: this.model.getSettings() });
        exportModelStl(this.model);
    }

    save3mf(s: Record<string, any>): void {
        this.model.applySettings(s);
        this.config.update({ model: this.model.getSettings() });
        exportModel3mf(this.model);
    }

    resetCamera(): void { this.preview?.resetCamera(); }
    resize(): void { this.preview?.resize(); }
    selectSource(id: string): void { this.controller?.select(id); }

    // --- URL / share link -------------------------------------------------------

    /** The full share/hash URL from the live map view + current selection. */
    shareUrl(): string {
        return composeShareUrl(this.controller?.getView(), this.controller?.activeId, this.config.get().selection, this.config.get().model.shape);
    }

    /** Keep the address bar in sync with the live map + config, debounced so dragging doesn't flood
     *  the history API. */
    scheduleUrlSync(): void {
        clearTimeout(this.urlSyncTimer);
        this.urlSyncTimer = window.setTimeout(() => {
            try { history.replaceState(null, '', this.shareUrl()); }
            catch (e) { Env.error('sync url', e); }
        }, 250);
    }
}
