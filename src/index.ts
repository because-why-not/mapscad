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
import DragBox from 'ol/interaction/DragBox';
import { OsmOverlay } from './kit/ui/OsmOverlay';
import { OSM_FEATURES } from './kit/mapelements/osmFeatures';
import { OSM_LABELS } from './app/osmLabels';
import { TerrainPreview } from './kit/ui/TerrainPreview';
import { MapModel, SelectionShape } from './kit/MapModel';
import { MapscadSession } from './kit/MapscadSession';
import { PreviewConfigStore } from './kit/PreviewConfig';
import type { MapEngine } from './kit/ui/MapEngine';
import { readUrlMapState, loadView, saveView, saveActive } from './app/urlState';
import { MapscadRenderer, demZoomRange, resolutionZoomRange } from './app/renderer';

// This file is the composition root: the only place that names concrete engines. It constructs the
// kit singletons + the renderer (the OL/Three adapter), fetches the manifest, mounts the Svelte App
// (wiring its callbacks to renderer methods), then hands the built viewers to the renderer.

// The canonical 3D model: settings mutate it, the preview and STL export read it.
const model = new MapModel();
// Single source of truth for preview/export config (DEM, selection, model settings, display flags)
// + its persistence and share-link codec. Reads any share link / saved config at construction.
const config = new PreviewConfigStore();
// The kit session owns the element *data* (source of truth) + preview membership + two typed events.
const session = new MapscadSession();
// The renderer / second adapter: drives the OL overlays + Three.js preview from the session/model
// events and fans UI commands back in. Its viewers/app are wired in once mounted (below).
const renderer = new MapscadRenderer(session, model, config);

/** Compact toggle label for an elevation source name (drops the _elevation[_raw] tail). */
function demLabel(name: string): string {
    return prettifyMapName(name.replace(/_elevation(_raw)?$/i, ''));
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
    const mapsById: Record<string, ManifestMap> = Object.fromEntries(maps.map(m => [m.name, m]));
    renderer.mapsById = mapsById;
    // Resolve a bare source name to the actual map id (public bare, or server-prefixed).
    const resolveSource = (name: string): string | null =>
        mapsById[name] ? name : (mapsById[LOCAL_MAP_PREFIX + name] ? LOCAL_MAP_PREFIX + name : null);
    const customSpecs = availableCustomMaps(mapsById);
    // Resolve any active map source to the DEM it represents (used to default the preview source
    // when a brand-new selection is drawn). Raw DEM layers map to themselves; the synthesized 2D/3D
    // hillshades map to their demSource.
    for (const m of maps) if (m.mmapsrv.type === 'elevation') renderer.demBySource[m.name] = m.name;
    for (const s of customSpecs) renderer.demBySource[s.id] = s.demSource;
    // The 3D preview can be built from any elevation DEM the server advertises (the manifest tags
    // those with mmapsrv.type === 'elevation'). Expose them all as a source toggle; each DEM has its
    // own zoom range, so switching also moves the zoom.
    const previewDems = maps
        .filter(m => m.mmapsrv.type === 'elevation')
        .map(m => ({ id: m.name, name: demLabel(stripLocalPrefix(m.name)), attribution: m.attributionDetail }));
    // A shared link carries the selected area (corners + shape) in readable form — adopt it so it wins
    // over the last local selection, then read the merged config below.
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
    renderer.previewDem = mapsById[initialDemId];

    // The zoom slider's range + default. With a restored selection, cap it to the resolution the mesh
    // needs (as when drawing a new one); otherwise it's just the DEM's full range until a selection is
    // drawn. A saved heightZoom is capped to the light resolution-based default (`zr.def`) — NEVER the
    // range max — so a reload can't silently refetch far finer DEM detail than the default; an unset one
    // (0) opens at that default too. The raster resolution is deliberately NOT restored — every load
    // starts at Env.rasterResolution so a stale saved value can't silently change the mesh density.
    const savedSelection = cfg.selection;
    let zr: { min: number; max: number; def: number };
    if (savedSelection && renderer.previewDem) {
        zr = resolutionZoomRange(savedSelection, renderer.previewDem, Env.rasterResolution);
    } else {
        const range = demZoomRange(renderer.previewDem);
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
        // A custom map (2D/3D hillshade, imagery) has no attribution of its own — it derives from the
        // DEM/imagery source it renders, so surface the underlying source's attribution.
        const srcId = resolveSource(s.demSource);
        return {
            id: s.id,
            name: s.name,
            icon: s.icon,
            category: s.category,
            attribution: srcId ? mapsById[srcId]?.attributionDetail : undefined,
        };
    });

    // Map name + view come from the URL hash if present (read above), else the last-used local values,
    // else defaults.
    const allIds = [...tileProviders.map(p => p.id), ...customMaps.map(c => c.id)];
    const saved = localStorage.getItem('activeProvider');
    const initialId = (urlMapState.map && allIds.includes(urlMapState.map)) ? urlMapState.map
        : (saved && allIds.includes(saved)) ? saved
        : (allIds[0] ?? '');

    // Shared by the App (initial zoom badge) and the MapController (initial camera).
    const initialView = urlMapState.view ?? loadView();

    // Mount the Svelte UI first — it owns the split layout and provides the DOM nodes the map engines
    // and 3D preview mount into. Every callback is a thin delegate to a renderer method.
    renderer.app = mount(App, {
        target: document.getElementById('app')!,
        props: {
            tileProviders,
            customMaps,
            initialActiveProviderId: initialId,
            initialMapZoom: initialView.zoom,
            onLayerSwitch: (id: string) => renderer.selectSource(id),
            onSelectToggle: (active: boolean, shape?: SelectionShape) => renderer.toggleSelect(active, shape),
            onAspectChange: (ratio: number | null) => renderer.setAspect(ratio),
            onDataModeChange: (active: boolean) => renderer.setDataMode(active),
            onBoxSelectToggle: (active: boolean) => renderer.toggleBoxSelect(active),
            // The menu sections to render (one per registry feature), so the UI is data-driven.
            features: OSM_FEATURES.map(f => ({ id: f.id, label: OSM_LABELS[f.id].label, noun: OSM_LABELS[f.id].noun, hasRadius: f.geometry === 'line', sizeLimit: f.sizeLimit })),
            session, // the Data panel subscribes to the session for element data
            onDownload: (id: string) => renderer.downloadFeature(id),
            onSaveJson: (id: string) => renderer.saveFeatureJson(id),
            onLoadJson: (id: string, payloads: any[]) => renderer.loadFeatureFiles(id, payloads),
            onUpdatePreview: (id: string) => renderer.updatePreviewFeature(id),
            onSelectElement: (id: string, elementId: number) => renderer.selectElement(id, elementId),
            onSetEnabled: (id: string, ids: number[], enabled: boolean) => renderer.applyOsmEnabled(id, ids, enabled),
            onDelete: (id: string, ids: number[]) => renderer.removeOsmElements(id, ids),
            onHoverElement: (id: string | null, elementId: number | null) => renderer.hoverOsm(id, elementId),
            onMarksChange: (id: string, ids: number[]) => renderer.setMarks(id, ids),
            previewDems,
            initialPreviewDemId: initialDemId,
            previewZoomMin,
            previewZoomMax,
            initialPreviewSettings,
            onPreviewDemChange: (id: string) => renderer.changePreviewDem(id),
            onPreviewSettingsChange: (s: Record<string, any>) => renderer.changePreviewSettings(s),
            onPreviewGenerate: (s: Record<string, any>) => renderer.generate(s),
            onPreviewSave: (s: Record<string, any>) => renderer.saveStl(s),
            onPreviewSave3mf: (s: Record<string, any>) => renderer.save3mf(s),
            onPreviewResetCamera: () => renderer.resetCamera(),
            onPreviewShareLink: () => renderer.shareUrl(),
            onPreviewCancel: () => renderer.cancelResample(),
            onLayoutChange: () => renderer.resize(),
        },
    });

    // mount() inserts the DOM synchronously, but child-component `bind:this` refs (mapPanel,
    // previewPanel) are wired by effects that flush asynchronously. The selection-restore below runs
    // synchronously (controller.select -> OL onReady, no awaits), so without this flush the App's
    // setSelectTool/setHasSelection forwarders would hit still-null child refs and no-op, leaving the
    // toolbar buttons stuck in their default state after a reload.
    flushSync();

    // Read the Svelte-rendered mount nodes from the DOM (mount() inserts synchronously); more reliable
    // than threading bind:this through nested components.
    const mapMount = document.getElementById('map-mount')!;
    const previewRoot = document.getElementById('preview-mount')!;

    // The preview is a pure consumer of the model: one subscription keeps both the 3D view and the
    // stats overlay in sync with whatever the model currently holds.
    const preview = new TerrainPreview(previewRoot);
    preview.setSmoothShading(initialPreviewSettings.smoothShading ?? true);
    renderer.preview = preview;
    model.onChange(() => renderer.onModelChange());

    // Composition root: choose concrete engines here; nothing else knows about them.
    const ol2dSpecs = customSpecs.filter(s => s.surface.type === 'hillshade-2d');
    const mapLibreSpecs = customSpecs.filter(s => s.surface.type !== 'hillshade-2d');
    const hillshades = ol2dSpecs.map(s => ({ id: s.id, demSource: s.demSource }));

    // The region-selection tool lives on the OpenLayers 2D map; created when the OL map is ready, then
    // restored from any previously saved selection. The 2D hillshades render here too, so the selection
    // tool works over them.
    const olEngine = new OpenLayersEngine(maps, map => {
        if (renderer.selection) return;
        renderer.olMap = map; // capture for the OSM click hit-test
        renderer.selection = new SelectionArea(map, { onChange: (c) => renderer.onUserSelectionChange(c) });
        // One overlay per registry feature, in zIndex order (the registry sets each zIndex).
        for (const def of OSM_FEATURES) {
            const overlay = new OsmOverlay(map, def);
            renderer.osmOverlays.set(def.id, overlay);
        }
        // Click an OSM element to select it (vector-editor style); Delete removes the selected one.
        map.on('singleclick', (e) => renderer.onMapClick(e.pixel));
        // Box-select tool (Data tab): drag a box, mark every OSM element it intersects. Inactive until
        // toggled on; suppresses pan while dragging (DragBox consumes the drag).
        const box = new DragBox({ className: 'ol-dragbox data-box' });
        renderer.dataBox = box;
        box.setActive(false);
        box.on('boxend', () => {
            const extent = box.getGeometry().getExtent();
            renderer.osmOverlays.forEach((overlay, featureId) => {
                const ids = overlay.elementsInExtent(extent);
                if (ids.length) renderer.app?.addOsmMarks(featureId, ids);
            });
        });
        map.addInteraction(box);
        const savedCorners = config.get().selection;
        if (savedCorners) {
            const shape = config.get().model.shape;
            renderer.selection.setShape(shape);
            renderer.selection.restore(savedCorners);
            renderer.app?.setSelectTool(shape); // highlight the matching tool button
            renderer.onSelectionChange(savedCorners); // restore() doesn't emit — fan out manually
        }
    }, hillshades);
    const engines: MapEngine[] = [olEngine];
    if (mapLibreSpecs.length) engines.push(new MapLibreTerrainEngine(mapLibreSpecs, mapsById));

    const controller = new MapController({
        engines,
        container: mapMount,
        initialView,
        onActiveChange: id => renderer.app?.setActiveProvider(id),
        onViewPersist: v => { saveView(v); renderer.app?.setMapZoom(v.zoom); renderer.scheduleUrlSync(); },
        onActivePersist: id => { saveActive(id); renderer.scheduleUrlSync(); },
    });
    renderer.controller = controller;

    // Selection / DEM / model changes alter the shareable slice → keep the URL live.
    config.subscribe(() => renderer.scheduleUrlSync());

    if (initialId) controller.select(initialId);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
