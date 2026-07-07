import { mount, flushSync } from 'svelte';
import App from './app/App.svelte';
import './app/app.css';
import { Env } from './Env';
import { fetchTileMapManifest, type ManifestMap } from './kit/maptiles/TileMapManifest';
import { EXTERNAL_DEMS } from './kit/config/externalDems';
import { EXTERNAL_MAPS } from './kit/config/externalMaps';
import { prettifyMapName, iconForMapType, LOCAL_MAP_PREFIX, stripLocalPrefix } from './kit/config/mapMeta';
import { availableCustomMaps, elevationGroup } from './kit/config/customMaps';
import { MapViewer } from './kit/ui/MapViewer';
import { PreviewController, demZoomRange, resolutionZoomRange } from './kit/ui/PreviewController';
import { OSM_FEATURES } from './kit/mapelements/osmFeatures';
import { OSM_LABELS } from './app/osmLabels';
import { MapModel, type SelectionShape } from './kit/MapModel';
import { MapscadSession } from './kit/MapscadSession';
import { ProcessorConfigStore } from './kit/ProcessorConfig';
import { rectExtent } from './kit/maptiles/HeightSampler';
import { readUrlMapState, composeShareUrl, loadView, saveView, saveActive } from './app/urlState';
import { loadSmoothShading, saveSmoothShading } from './app/uiPrefs';

// This file is the composition root — init only. It constructs the kit (session, model, config),
// fetches the manifest and shapes the menu data, mounts the Svelte App (menus/layout), then hands
// each viewer its mount <div> and wires the typed kit events to the App's forwarders. All behavior
// lives in the kit: MapViewer (2D/3D map + selection + overlays), PreviewController (3D preview +
// sampling + build), MapscadSession/.mapElements (state + element data).

// The canonical 3D model: settings mutate it, the preview and STL export read it.
const model = new MapModel();
// Single source of truth for preview/export config (DEM, selection, model settings) + persistence.
const config = new ProcessorConfigStore();
// The kit session: the selected region (+ selectionChanged) and the map-element manager.
const session = new MapscadSession();

/** Compact toggle label for an elevation source name (drops the _elevation[_raw] tail). */
function demLabel(name: string): string {
    return prettifyMapName(name.replace(/_elevation(_raw)?$/i, ''));
}

async function init(): Promise<void> {
    // One-off cleanup: these were folded into the single `previewConfig` key (ProcessorConfig)
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
    // Resolve a bare source name to the actual map id (public bare, or server-prefixed).
    const resolveSource = (name: string): string | null =>
        mapsById[name] ? name : (mapsById[LOCAL_MAP_PREFIX + name] ? LOCAL_MAP_PREFIX + name : null);
    const customSpecs = availableCustomMaps(mapsById);
    // Resolve any active map source to the DEM it represents (used to default the preview source
    // when a brand-new selection is drawn). Raw DEM layers map to themselves; the synthesized 2D/3D
    // hillshades map to their demSource.
    const demBySource: Record<string, string> = {};
    for (const m of maps) if (m.mmapsrv.type === 'elevation') demBySource[m.name] = m.name;
    for (const s of customSpecs) demBySource[s.id] = s.demSource;
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
    const initialDem = mapsById[initialDemId];

    // The zoom slider's range + default. With a restored selection, cap it to the resolution the mesh
    // needs (as when drawing a new one); otherwise it's just the DEM's full range until a selection is
    // drawn. A saved heightZoom is capped to the light resolution-based default (`zr.def`) — NEVER the
    // range max — so a reload can't silently refetch far finer DEM detail than the default; an unset one
    // (0) opens at that default too. The raster resolution is deliberately NOT restored — every load
    // starts at Env.rasterResolution so a stale saved value can't silently change the mesh density.
    const savedSelection = cfg.selection;
    let zr: { min: number; max: number; def: number };
    if (savedSelection && initialDem) {
        zr = resolutionZoomRange(savedSelection, initialDem, Env.rasterResolution);
    } else {
        const range = demZoomRange(initialDem);
        zr = { ...range, def: range.max };
    }
    const previewZoomMin = zr.min, previewZoomMax = zr.max;
    // Cap the saved zoom to the light default, never higher; an unset one (0) opens there too.
    const heightZoom = cfg.model.heightZoom > 0 ? Math.min(cfg.model.heightZoom, zr.def) : zr.def;
    model.applySettings({ ...cfg.model, heightZoom, rasterResolution: Env.rasterResolution });
    // Fold the resolved DEM + sanitized settings back into the config so it's consistent.
    config.update({ demId: initialDemId, model: model.getSettings() });
    const initialPreviewSettings: Record<string, any> = { ...model.getSettings() };
    // Smooth shading is a viewer-only pref (app-side, its own storage key) — not part of the config.
    const smoothShading = loadSmoothShading();

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

    // Shared by the App (initial zoom badge) and the map viewer (initial camera).
    const initialView = urlMapState.view ?? loadView();

    // The two kit viewers — constructed right after mount, but the App's callbacks close over them.
    let mapViewer: MapViewer | null = null;
    let previewController: PreviewController | null = null;

    /** The full share/hash URL from the live map view + current selection. */
    const shareUrl = (): string =>
        composeShareUrl(mapViewer?.getView(), mapViewer?.activeId, config.get().selection, config.get().model.shape);
    // Keep the address bar in sync with the live map + config, debounced so dragging doesn't flood
    // the history API.
    let urlSyncTimer = 0;
    const scheduleUrlSync = (): void => {
        clearTimeout(urlSyncTimer);
        urlSyncTimer = window.setTimeout(() => {
            try { history.replaceState(null, '', shareUrl()); }
            catch (e) { Env.error('sync url', e); }
        }, 250);
    };

    // Mount the Svelte UI first — it owns the split layout and provides the DOM nodes the viewers
    // mount into. Every callback is a thin delegate to a kit method.
    const app: any = mount(App, {
        target: document.getElementById('app')!,
        props: {
            tileProviders,
            customMaps,
            initialActiveProviderId: initialId,
            initialMapZoom: initialView.zoom,
            onLayerSwitch: (id: string) => mapViewer?.selectSource(id),
            onSelectToggle: (active: boolean, shape?: SelectionShape) => mapViewer?.toggleSelect(active, shape),
            onAspectChange: (ratio: number | null) => mapViewer?.setAspect(ratio),
            onDataModeChange: (active: boolean) => mapViewer?.setDataMode(active),
            onBoxSelectToggle: (active: boolean) => mapViewer?.toggleBoxSelect(active),
            // The menu sections to render (one per registry feature), so the UI is data-driven.
            features: OSM_FEATURES.map(f => ({ id: f.id, label: OSM_LABELS[f.id].label, noun: OSM_LABELS[f.id].noun, hasRadius: f.geometry === 'line', sizeLimit: f.sizeLimit })),
            session, // the Data panel reads element data via the session's manager
            onDownload: (id: string) => session.mapElements.download(id),
            onSaveJson: (id: string) => session.mapElements.toJson(id),
            onLoadJson: (id: string, payloads: any[]) => session.mapElements.loadFiles(id, payloads),
            onUpdatePreview: (id: string) => session.mapElements.updatePreview(id),
            onSelectElement: (id: string, elementId: number) => mapViewer?.selectElement(id, elementId),
            onSetEnabled: (id: string, ids: number[], enabled: boolean) => session.mapElements.setEnabled(id, ids, enabled),
            onDelete: (id: string, ids: number[]) => mapViewer?.removeElements(id, ids),
            onHoverElement: (id: string | null, elementId: number | null) => mapViewer?.hoverOsm(id, elementId),
            onMarksChange: (id: string, ids: number[]) => mapViewer?.setMarks(id, ids),
            previewDems,
            initialPreviewDemId: initialDemId,
            previewZoomMin,
            previewZoomMax,
            initialPreviewSettings,
            initialPreviewSmoothShading: smoothShading,
            onPreviewDemChange: (id: string) => previewController?.changeDem(id),
            onPreviewSettingsChange: (s: Record<string, any>) => previewController?.changeSettings(s),
            onPreviewSmoothShadingChange: (v: boolean) => { saveSmoothShading(v); previewController?.setSmoothShading(v); },
            onPreviewGenerate: (s: Record<string, any>) => previewController?.generate(s),
            onPreviewSave: (s: Record<string, any>) => previewController?.saveStl(s),
            onPreviewSave3mf: (s: Record<string, any>) => previewController?.save3mf(s),
            onPreviewResetCamera: () => previewController?.resetCamera(),
            onPreviewShareLink: () => shareUrl(),
            onPreviewCancel: () => previewController?.cancel(),
            onLayoutChange: () => previewController?.resize(),
        },
    });

    // mount() inserts the DOM synchronously, but child-component `bind:this` refs (mapPanel,
    // previewPanel) are wired by effects that flush asynchronously. The selection-restore below runs
    // synchronously (selectSource -> OL onReady, no awaits), so without this flush the App's
    // setSelectTool/setHasSelection forwarders would hit still-null child refs and no-op, leaving the
    // toolbar buttons stuck in their default state after a reload.
    flushSync();

    // Hand each viewer its mount node (read from the DOM — mount() inserts synchronously); from here
    // the viewers own everything inside those divs, Svelte only owns where they sit in the layout.
    const pc = new PreviewController(document.getElementById('preview-mount')!, session, model, config, {
        mapsById,
        demBySource,
        initialDemId,
        getActiveSourceId: () => mapViewer?.activeId ?? '',
    });
    pc.setSmoothShading(smoothShading);
    previewController = pc;
    const mv = new MapViewer(document.getElementById('map-mount')!, session, model, config, {
        maps,
        mapsById,
        customSpecs,
        initialView,
    });
    mapViewer = mv;

    // --- events out of the kit → the App's menu/panel forwarders + persistence ---
    pc.loading.on(s => app.setPreviewLoading(s));
    pc.stats.on(s => app.setPreviewStats(s));
    pc.zoomRange.on(r => app.setPreviewZoomRange(r.min, r.max, r.value));
    pc.demChanged.on(id => app.setPreviewDem(id));
    mv.activeChanged.on(id => app.setActiveProvider(id));
    mv.viewChanged.on(v => { saveView(v); app.setMapZoom(v.zoom); scheduleUrlSync(); });
    mv.activePersist.on(id => { saveActive(id); scheduleUrlSync(); });
    mv.osmSelected.on(({ featureId, elementId }) => app.setOsmSelected(featureId, elementId));
    mv.marksAdded.on(({ featureId, ids }) => app.addOsmMarks(featureId, ids));
    mv.toolRestored.on(shape => app.setSelectTool(shape));
    // Selection fan-out, UI-only slice (the kit handles the data + resampling itself): persist it,
    // show/hide the 3D panel, reset or gate the Data panel, and flag kept data as possibly stale
    // after an EDIT (the data is re-projected, but may not cover the shifted area — Overpass
    // rate-limits make a silent wipe an expensive click to lose).
    session.selectionChanged.on(({ corners, prev }) => {
        config.update({ selection: corners });
        app.setPreviewVisible(!!corners);
        // The longest selection side (metres) gates which OSM features can be downloaded (Env limits).
        const sideMeters = corners ? Math.max(...Object.values(rectExtent(corners))) : 0;
        app.setHasSelection(!!corners, sideMeters, corners ? !prev : true);
        if (corners && prev) {
            for (const def of OSM_FEATURES) {
                if (session.mapElements.getElements(def.id)) app.setOsmStale(def.id, true);
            }
        }
    });
    // A feature entered/left the printed model → gate its section in the preview menu.
    session.mapElements.on('previewChanged', id => app.setOsmAvailable(id, session.mapElements.isInPreview(id)));
    // Selection / DEM / model changes alter the shareable slice → keep the URL live.
    config.subscribe(() => scheduleUrlSync());

    mv.selectSource(initialId);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
