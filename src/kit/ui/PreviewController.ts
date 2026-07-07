import { TerrainPreview } from './TerrainPreview';
import { OsmVectorData } from '../mapelements/OsmVectorData';
import { sampleSelectionHeights, rectExtent, tileCoverage } from '../maptiles/HeightSampler';
import type { ManifestMap } from '../maptiles/TileMapManifest';
import type { MapModel, ModelGeometry } from '../MapModel';
import type { MapscadSession } from '../MapscadSession';
import type { ProcessorConfigStore } from '../ProcessorConfig';
import { exportModelStl } from '../StlMaker';
import { exportModel3mf } from '../ThreeMFMaker';
import { estimateMemory, measureMemory, formatBytes, memoryLevel, isOverBudget } from '../memory';
import { groundResolution, zoomForResolution, type LonLat } from '../common/mathHelper';
import { Emitter } from '../common/events';
import { Env } from '../../Env';

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

/** Bottom progress bar state: DEM-download phase, off-thread build phase, or hidden (null). */
export type PreviewLoading = { loaded: number; total: number } | { phase: 'build'; percent: number } | null;

/** Zoom slider range + current value (moved when the DEM / selection / raster resolution changes). */
export interface ZoomRange { min: number; max: number; value: number }

export interface PreviewControllerOptions {
    /** All manifest maps by id — to resolve a DEM id to its ManifestMap. */
    mapsById: Record<string, ManifestMap>;
    /** Map-source id → the elevation DEM it represents (raw = itself, hillshade/3D = its source). */
    demBySource: Record<string, string>;
    /** The DEM the preview starts on (resolved by the composition root from config/manifest). */
    initialDemId: string;
    /** The active 2D/3D map source — a brand-new selection defaults the preview DEM to it. */
    getActiveSourceId: () => string;
}

/**
 * The 3D-preview side of the app, headless of Svelte: give it the mount `<div>` and it owns
 * everything from there — the Three.js `TerrainPreview`, DEM re-sampling over the session's
 * selection, the off-main-thread geometry build, and the mesh statistics. Events out, methods in:
 * the UI drives it via methods (changeDem, changeSettings, generate, save…) and renders its
 * `loading` / `stats` / `zoomRange` / `demChanged` events; it never reaches into a component.
 *
 * It subscribes to the kit itself (constructor):
 *   - `session.selectionChanged` — new/edited region → (re)sample; user-drawn brand-new region →
 *     first seed the DEM + zoom defaults; cleared → drop the grid (preview + stats empty).
 *   - `session.mapElements previewChanged` — (re)bind that feature's enabled elements to the grid.
 *   - `model.onChange` — any model change (grid or settings) → rebuild geometry off-thread.
 */
export class PreviewController {
    /** Progress of the current download/build phase, or null to hide the bar. */
    readonly loading = new Emitter<PreviewLoading>();
    /** Realistic stats of the freshly built mesh, or null when there is no model. */
    readonly stats = new Emitter<Record<string, any> | null>();
    /** The zoom slider's range + value moved programmatically (DEM switch, raster change, seeding). */
    readonly zoomRange = new Emitter<ZoomRange>();
    /** The preview DEM was switched programmatically (a new selection adopted the active map's DEM). */
    readonly demChanged = new Emitter<string>();

    private readonly preview: TerrainPreview;
    private previewDem: ManifestMap | undefined;

    // In-flight DEM sampling, so a new build (or the user's Cancel) aborts the previous one.
    private resampleAbort: AbortController | null = null;
    private resampleTimer = 0;

    // Off-main-thread geometry build. Every model change rebuilds the preview in a worker so the heavy
    // build/weld math never blocks the UI. One worker, latest-wins: while a build is in flight the newest
    // change is held in `buildPending` and started on completion. Cancel/error just terminate the worker;
    // the next build lazily spins up a fresh one.
    private buildWorker: Worker | null = null;
    private buildSeq = 0;        // id of the in-flight build; stale messages (after cancel) are ignored
    private buildBusy = false;
    private buildPending = false;

    constructor(
        container: HTMLElement,
        private readonly session: MapscadSession,
        private readonly model: MapModel,
        private readonly config: ProcessorConfigStore,
        private readonly opts: PreviewControllerOptions,
    ) {
        this.preview = new TerrainPreview(container);
        this.previewDem = opts.mapsById[opts.initialDemId];

        model.onChange(() => this.onModelChange());
        session.mapElements.on('previewChanged', (id) => this.syncOsmField(id));
        session.selectionChanged.on(({ corners, prev, user }) => {
            if (!corners) {
                // Region cleared: nothing to sample. (The element data is already gone — the session
                // clears it before emitting.) Dropping the grid clears the preview + stats via onChange.
                this.model.setGrid(null);
                return;
            }
            // A brand-new region drawn by the user first adopts the DEM behind the active map layer
            // and a resolution-based zoom default; a restore/script keeps its explicit settings.
            if (user && !prev) this.seedDefaults(corners);
            this.resample(); // sample the DEM + re-sync any preview-added features to the new corners
        });
    }

    // --- DEM sampling + zoom -----------------------------------------------------

    /** Largest zoom ≤ desired whose DEM download + mesh fits the memory budget. The grid is fixed by
     *  the raster resolution (zoom-independent), so lowering the zoom only shrinks the DEM tile
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
        this.loading.emit({ loaded: 0, total: 0 }); // show the bottom progress bar
        try {
            const { heightZoom, rasterResolution } = this.model.getSettings();
            const zoom = this.safeZoom(corners, heightZoom, rasterResolution);
            const { cols, rows } = gridResolution(corners, rasterResolution);
            const grid = await sampleSelectionHeights(corners, this.previewDem, cols, rows, zoom, {
                signal: abort.signal,
                onProgress: (loaded, total) => this.loading.emit({ loaded, total }),
            });
            if (abort.signal.aborted) return;
            this.model.setGrid(grid); // notifies -> preview + stats rebuild from the model
            this.session.mapElements.resyncPreview(); // re-rasterise added features to the new grid
            Env.log(`[3d] terrain regenerated in ${Math.round(performance.now() - t0)} ms`);
        } catch (e) {
            if ((e as { name?: string })?.name === 'AbortError') Env.log('[3d] terrain build cancelled');
            else Env.error('resample', e);
        } finally {
            // On success setGrid kicked off the worker build, which now owns the progress bar (it hides
            // it when done) — only clear it here if no build took over (download error/abort). The
            // `resampleAbort === abort` guard stops a superseded resample from clobbering the live bar.
            if (this.resampleAbort === abort) { this.resampleAbort = null; if (!this.buildBusy) this.loading.emit(null); }
        }
    }

    /** User clicked Cancel on the loading bar — stop whichever phase is running (DEM download or the
     *  off-thread build), keeping the previous preview. */
    cancel(): void {
        this.resampleAbort?.abort();
        this.cancelBuild();
    }

    // Resampling hits the network, so changes to zoom / resolution limit are debounced.
    private scheduleResample(): void {
        clearTimeout(this.resampleTimer);
        this.resampleTimer = window.setTimeout(() => this.resample(), 200);
    }

    /** A brand-new user-drawn selection: adopt the DEM behind the active map layer (drawing on North
     *  Island's hillshade picks north_island_elevation_raw), and open at the zoom the mesh resolution
     *  actually needs — so we don't fetch far more DEM detail than the grid will use. */
    private seedDefaults(corners: LonLat[]): void {
        const activeDem = this.opts.demBySource[this.opts.getActiveSourceId()];
        if (activeDem && this.opts.mapsById[activeDem] && activeDem !== this.config.get().demId) {
            this.previewDem = this.opts.mapsById[activeDem];
            this.config.update({ demId: activeDem });
            this.demChanged.emit(activeDem); // sync the preview's Source toggle
        }
        if (this.previewDem) {
            const { min, max, def } = resolutionZoomRange(corners, this.previewDem, this.model.getSettings().rasterResolution);
            this.model.applySettings({ heightZoom: def });
            this.config.update({ model: this.model.getSettings() });
            this.zoomRange.emit({ min, max, value: def }); // move the slider's range + value
        }
    }

    // --- OSM element binding (manager events -> model) ---------------------------

    /** Bind one feature's downloaded ways to the model's grid and hand them over (or clear them).
     *  Called whenever the data or the grid change; the matching OsmCanvasProcessor paints them in. */
    private syncOsmField(id: string): void {
        const grid = this.model.getGrid();
        const data = this.session.mapElements.getElements(id);
        const corners = this.session.getSelection();
        if (!data || !corners || !grid) { this.model.setOsmData(id, null); return; }
        // Disabled elements stay in the list/overlay but are excluded from the printed model.
        const enabled = data.list.filter(e => !e.disabled);
        const enabledData = new OsmVectorData(enabled);
        const bound = enabledData.withGrid({ corners, cols: grid.cols, rows: grid.rows });
        this.model.setOsmData(id, bound);
    }

    // --- off-thread geometry build ----------------------------------------------

    private getBuildWorker(): Worker {
        if (!this.buildWorker) {
            this.buildWorker = new Worker(new URL('../model/geometry.worker.ts', import.meta.url));
            this.buildWorker.onmessage = (e) => this.onBuildMessage(e);
            this.buildWorker.onerror = (e) => { Env.error('build worker', e.message); this.finishBuild(); };
        }
        return this.buildWorker;
    }

    /** The model changed (new heights or new settings): rebuild the preview + stats off-thread. */
    private onModelChange(): void {
        const grid = this.model.getGrid();
        if (!grid) {                          // selection cleared: drop the preview, stats, and any build
            this.cancelBuild();
            this.preview.setGeometry(null);
            this.stats.emit(null);
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
        this.loading.emit({ phase: 'build', percent: 0 });
        // Copy (no transfer): `input.grid` / OSM coverage may be the model's own arrays — don't detach them.
        this.getBuildWorker().postMessage({ id, grid: input.grid, settings: input.settings, osmBodies: input.osmBodies });
    }

    private onBuildMessage(e: MessageEvent): void {
        const msg = e.data;
        if (msg.id !== this.buildSeq) return; // superseded by a cancel / newer build
        if (msg.type === 'progress') {
            this.loading.emit({ phase: 'build', percent: Math.round(msg.fraction * 100) });
            return;
        }
        if (msg.type === 'error') { Env.error('build', msg.message); this.finishBuild(); return; }
        // done
        const geo: ModelGeometry = msg.geo;
        this.preview.setGeometry(geo);
        this.updateStats(geo);
        this.finishBuild();
    }

    /** Current build settled (done / error): start the queued one if any, else hide the bar. */
    private finishBuild(): void {
        this.buildBusy = false;
        if (this.buildPending) this.startBuild();
        else this.loading.emit(null);
    }

    /** User Cancel (or a model clear): abandon the in-flight build, keep the existing preview. */
    private cancelBuild(): void {
        if (this.buildWorker) { this.buildWorker.terminate(); this.buildWorker = null; }
        this.buildSeq++;            // invalidate any late message from the terminated worker
        this.buildBusy = false;
        this.buildPending = false;
        this.loading.emit(null);
    }

    /** Emit the realistic mesh stats for a freshly built geometry. */
    private updateStats(geo: ModelGeometry | null): void {
        const grid = this.model.getGrid();
        if (!grid || !geo) { this.stats.emit(null); return; }
        const mem = measureMemory(geo, grid); // realistic: from the actual built mesh, not a grid guess
        const surfaceVerts = grid.cols * grid.rows;
        // Ground resolution (metres per DEM pixel) at the heightmap zoom, and the DEM's effective pixel
        // size over the selection — distinct from the raster grid, since the DEM is interpolated to
        // fill the grid. Lets the user compare real heightmap detail against the vertex grid below it.
        const corners = this.session.getSelection();
        const hmRes = corners
            ? groundResolution(corners[0][1], grid.zoom, this.previewDem?.mmapsrv.tileSize)
            : undefined;
        this.stats.emit({
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

    // --- commands (the UI's method surface) ---------------------------------------

    /** Switch the preview's elevation source. Resets the zoom to the new source's resolution-based
     *  default — each DEM has its own native detail, so carrying the old level over rarely makes
     *  sense (and can over-fetch). */
    changeDem(id: string): void {
        if (!this.opts.mapsById[id]) return;
        this.previewDem = this.opts.mapsById[id];
        const corners = this.session.getSelection();
        const { min, max, def } = corners
            ? resolutionZoomRange(corners, this.previewDem, this.model.getSettings().rasterResolution)
            : { ...demZoomRange(this.previewDem), def: demZoomRange(this.previewDem).max };
        this.model.applySettings({ heightZoom: def });
        this.config.update({ demId: id, model: this.model.getSettings() });
        this.zoomRange.emit({ min, max, value: def }); // move the slider's range + value
        this.resample();
    }

    /** User changed settings in the side menu (NOT triggered when the selection changes). */
    changeSettings(s: Record<string, any>): void {
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
            this.zoomRange.emit({ min, max, value: heightZoom });
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

    /** Viewer-only mesh shading toggle (never touches the model — persistence is the app's business). */
    setSmoothShading(on: boolean): void { this.preview.setSmoothShading(on); }
    resetCamera(): void { this.preview.resetCamera(); }
    resize(): void { this.preview.resize(); }
}
