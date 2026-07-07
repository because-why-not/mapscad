import OlMap from 'ol/Map';
import DragBox from 'ol/interaction/DragBox';
import { MapController } from './MapController';
import { OpenLayersEngine } from './OpenLayersEngine';
import { MapLibreTerrainEngine } from './MapLibreTerrainEngine';
import { SelectionArea } from './SelectionArea';
import { OsmOverlay } from './OsmOverlay';
import type { GeoView, MapEngine } from './MapEngine';
import type { ManifestMap } from '../maptiles/TileMapManifest';
import type { CustomMapSpec } from '../config/customMaps';
import { OSM_FEATURES } from '../mapelements/osmFeatures';
import { SelectionShape, type MapModel } from '../MapModel';
import type { MapscadSession } from '../MapscadSession';
import type { ProcessorConfigStore } from '../ProcessorConfig';
import { Emitter } from '../common/events';

// Width (px) of the open OSM-data panel; the centred element is shifted left of it so it stays visible.
const OSM_PANEL_PX = 288; // matches the panel's w-72

export interface MapViewerOptions {
    /** Every tile source (server + public), in menu order. */
    maps: ManifestMap[];
    /** The same sources by id — the MapLibre engine and DEM lookups resolve through it. */
    mapsById: Record<string, ManifestMap>;
    /** The synthesized 2D/3D hillshade + imagery specs derived from the manifest. */
    customSpecs: CustomMapSpec[];
    /** The camera to open on (URL hash, else last-used, else default). */
    initialView: GeoView;
}

/**
 * The 2D/3D map side of the app, headless of Svelte: give it the mount `<div>` and it owns
 * everything from there — the concrete engines (OpenLayers + MapLibre) behind a `MapController`,
 * the region-`SelectionArea`, one `OsmOverlay` per feature, the box-select tool, and all map
 * interaction (element click-pick, hover, pan-to). Events out, methods in: the UI drives it via
 * methods (selectSource, toggleSelect, setDataMode…) and renders its events; it never reaches into
 * a component.
 *
 * It subscribes to the kit itself (constructor + OL-ready):
 *   - `session.mapElements dataChanged` — redraw that feature's overlay from the element set.
 *   - `session.selectionChanged` — region cleared → drop the element highlight.
 * And it *writes* the session: a drawn/edited/cleared region is `session.setSelection(…, user)`,
 * and a restored one (from config, once OL is ready) is `setSelection(…)` — every other consumer
 * (preview resampling, config persistence, panel chrome) hangs off that one event.
 */
export class MapViewer {
    /** The active map source changed (highlight it in the menu). */
    readonly activeChanged = new Emitter<string>();
    /** The user moved the camera (persist it + update the zoom badge). */
    readonly viewChanged = new Emitter<GeoView>();
    /** The active source changed by user intent (persist it). */
    readonly activePersist = new Emitter<string>();
    /** The selected OSM element changed (map click or programmatic); nulls = cleared. */
    readonly osmSelected = new Emitter<{ featureId: string | null; elementId: number | null }>();
    /** The box-select tool marked elements (add them to the Data panel's marks). */
    readonly marksAdded = new Emitter<{ featureId: string; ids: number[] }>();
    /** A saved selection was restored on load (highlight the matching tool button). */
    readonly toolRestored = new Emitter<SelectionShape>();

    private readonly controller: MapController;
    private olMap: OlMap | null = null;
    private selectionArea: SelectionArea | null = null;
    private dataBox: DragBox | null = null;
    /** The OL overlays, one per feature id — the element data lives in the session's manager. */
    private readonly osmOverlays = new Map<string, OsmOverlay>();

    // The currently selected element on the map / in the object list (one at a time), or null.
    private selectedOsmElement: { featureId: string; elementId: number } | null = null;
    // OSM element picking is off while an area-selection draw tool is active (those clicks edit the
    // selection rectangle); on otherwise, like a vector app's Select tool.
    private osmPickActive = true;

    constructor(
        container: HTMLElement,
        private readonly session: MapscadSession,
        private readonly model: MapModel,
        private readonly config: ProcessorConfigStore,
        opts: MapViewerOptions,
    ) {
        session.mapElements.on('dataChanged', (id) => this.renderOsmData(id));
        session.selectionChanged.on(({ corners }) => {
            if (!corners) this.selectOsm(null, null); // region gone → nothing to keep highlighted
        });

        // Composition of the concrete engines lives here; nothing outside this class names them.
        const ol2dSpecs = opts.customSpecs.filter(s => s.surface.type === 'hillshade-2d');
        const mapLibreSpecs = opts.customSpecs.filter(s => s.surface.type !== 'hillshade-2d');
        const hillshades = ol2dSpecs.map(s => ({ id: s.id, demSource: s.demSource }));

        // The region-selection tool lives on the OpenLayers 2D map; created when the OL map is ready,
        // then restored from any previously saved selection. The 2D hillshades render here too, so the
        // selection tool works over them.
        const olEngine = new OpenLayersEngine(opts.maps, map => this.onOlReady(map), hillshades);
        const engines: MapEngine[] = [olEngine];
        if (mapLibreSpecs.length) engines.push(new MapLibreTerrainEngine(mapLibreSpecs, opts.mapsById));

        this.controller = new MapController({
            engines,
            container,
            initialView: opts.initialView,
            onActiveChange: id => this.activeChanged.emit(id),
            onViewPersist: v => this.viewChanged.emit(v),
            onActivePersist: id => this.activePersist.emit(id),
        });
    }

    /** The OpenLayers map is up: attach the selection tool, the per-feature overlays, element
     *  click-picking and the box-select tool, then restore any saved selection. */
    private onOlReady(map: OlMap): void {
        if (this.selectionArea) return;
        this.olMap = map; // capture for the OSM click hit-test
        this.selectionArea = new SelectionArea(map, {
            onChange: (c) => this.session.setSelection(c, { user: true }),
        });
        // One overlay per registry feature, in zIndex order (the registry sets each zIndex).
        for (const def of OSM_FEATURES) {
            const overlay = new OsmOverlay(map, def);
            this.osmOverlays.set(def.id, overlay);
        }
        // Click an OSM element to select it (vector-editor style).
        map.on('singleclick', (e) => this.onMapClick(e.pixel));
        // Box-select tool (Data tab): drag a box, mark every OSM element it intersects. Inactive until
        // toggled on; suppresses pan while dragging (DragBox consumes the drag).
        const box = new DragBox({ className: 'ol-dragbox data-box' });
        this.dataBox = box;
        box.setActive(false);
        box.on('boxend', () => {
            const extent = box.getGeometry().getExtent();
            this.osmOverlays.forEach((overlay, featureId) => {
                const ids = overlay.elementsInExtent(extent);
                if (ids.length) this.marksAdded.emit({ featureId, ids });
            });
        });
        map.addInteraction(box);
        const savedCorners = this.config.get().selection;
        if (savedCorners) {
            const shape = this.config.get().model.shape;
            this.selectionArea.setShape(shape);
            this.selectionArea.restore(savedCorners);
            this.toolRestored.emit(shape); // highlight the matching tool button
            this.session.setSelection(savedCorners); // restore() doesn't emit — fan out (user: false)
        }
    }

    // --- map sources ---------------------------------------------------------

    /** Switch the visible tile source (menu click / initial select). */
    selectSource(id: string): void { this.controller.select(id); }
    /** The live camera (for the share link). */
    getView(): GeoView { return this.controller.getView(); }
    /** The active source id (for the share link + DEM defaulting). */
    get activeId(): string { return this.controller.activeId; }

    // --- area-selection tool + data-mode chrome --------------------------------

    /** Toggle a draw tool on/off. While active, map clicks edit the area and OSM picking is off. */
    toggleSelect(active: boolean, shape: SelectionShape = SelectionShape.Rectangle): void {
        if (!this.selectionArea) return;
        this.osmPickActive = !active;
        if (active) {
            this.selectOsm(null, null);                // leave element-edit mode
            this.selectionArea.setShape(shape);        // redraw + (if a selection exists) keep it
            this.model.applySettings({ shape });       // mask is a model setting -> rebuilds geometry
            this.config.update({ model: this.model.getSettings() });
            this.selectionArea.activate();
        } else {
            this.selectionArea.deactivate(); // emits onChange(null) -> clears the session selection
        }
    }

    setAspect(ratio: number | null): void {
        this.selectionArea?.setAspect(ratio);
    }

    /** The Data tab locks the selection (view-only + grey wash outside it) and enables OSM picking. */
    setDataMode(active: boolean): void {
        this.osmPickActive = active;
        this.selectionArea?.setViewOnly(active);
        if (!active) this.dataBox?.setActive(false); // leaving Data turns the box tool off
    }

    /** Toggle the transient box-select tool on the map (Data tab only). */
    toggleBoxSelect(active: boolean): void {
        this.dataBox?.setActive(active);
        this.olMap?.getTargetElement()?.classList.toggle('map-crosshair', active);
    }

    // --- OSM element interaction ------------------------------------------------

    /** Renderer response to a `dataChanged` event: redraw the feature's OL overlay. A feature with no
     *  data (deleted by clearAll) fully clears the overlay; an empty-but-present set draws nothing. */
    private renderOsmData(id: string): void {
        const data = this.session.mapElements.getElements(id);
        const overlay = this.osmOverlays.get(id);
        if (data) overlay?.setElements(data.list); else overlay?.clear();
    }

    /** Select one element (map ↔ list), or pass nulls to clear. Highlights it on the map and
     *  announces it so the list can highlight too. */
    private selectOsm(featureId: string | null, elementId: number | null): void {
        this.selectedOsmElement = featureId !== null && elementId !== null ? { featureId, elementId } : null;
        this.osmOverlays.forEach((ov, id) => ov.setSelected(this.selectedOsmElement?.featureId === id ? this.selectedOsmElement.elementId : null));
        this.osmSelected.emit({ featureId: this.selectedOsmElement?.featureId ?? null, elementId: this.selectedOsmElement?.elementId ?? null });
    }

    /** Select an element from the list (highlight + bring it into view — the row may be off-screen). */
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

    /** Permanently remove elements (the Disable button's 3-second long-press): drop them from the
     *  manager, and clear the highlight if it pointed at one of them. */
    removeElements(featureId: string, ids: number[]): void {
        this.session.mapElements.remove(featureId, ids); // dataChanged only → overlay + list
        if (this.selectedOsmElement?.featureId === featureId && ids.includes(this.selectedOsmElement.elementId)) {
            this.selectOsm(null, null);
        }
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

    /** Map click handler (only while no draw tool is active): select the topmost OSM element under the
     *  click, or clear the selection when the click misses every OSM feature. */
    private onMapClick(pixel: number[]): void {
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
}
