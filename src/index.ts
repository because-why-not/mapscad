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
import { MapModel } from './kit/MapModel';
import { MapscadSession } from './kit/MapscadSession';
import { ProcessorConfigStore } from './kit/ProcessorConfig';
import { readUrlMapState, composeShareUrl, loadView, saveView, saveActive } from './app/urlState';
import { loadSmoothShading } from './app/uiPrefs';
import type { Kit } from './app/kitContext';

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

    // The kit objects handed to the UI: App provides them to every panel via context; the panels
    // call methods and subscribe to events on them directly (no callback props, no forwarders).
    // The two viewers are filled in right after mount — before flushSync runs the panels' effects.
    const kit: Kit = { session, config, mapViewer: null, previewController: null };

    // Mount the Svelte UI first — it owns the split layout and provides the DOM nodes the viewers
    // mount into. Everything it receives beyond `kit` is static menu data.
    mount(App, {
        target: document.getElementById('app')!,
        props: {
            kit,
            tileProviders,
            customMaps,
            initialActiveProviderId: initialId,
            initialMapZoom: initialView.zoom,
            // The menu sections to render (one per registry feature), so the UI is data-driven.
            features: OSM_FEATURES.map(f => ({ id: f.id, label: OSM_LABELS[f.id].label, noun: OSM_LABELS[f.id].noun, hasRadius: f.geometry === 'line', sizeLimit: f.sizeLimit })),
            previewDems,
            initialPreviewDemId: initialDemId,
            previewZoomMin,
            previewZoomMax,
            initialPreviewSettings,
        },
    });

    // Hand each viewer its mount node (mount() inserts the DOM synchronously, so the divs exist);
    // from here the viewers own everything inside those divs, Svelte only owns where they sit.
    const pc = new PreviewController(document.getElementById('preview-mount')!, session, model, config, {
        mapsById,
        demBySource,
        initialDemId,
        getActiveSourceId: () => kit.mapViewer?.activeId ?? '',
    });
    pc.setSmoothShading(loadSmoothShading());
    kit.previewController = pc;
    const mv = new MapViewer(document.getElementById('map-mount')!, session, model, config, {
        maps,
        mapsById,
        customSpecs,
        initialView,
    });
    kit.mapViewer = mv;

    // Component effects (the panels' kit-event subscriptions) flush asynchronously; run them NOW —
    // after the viewers exist, before the selection-restore below fires the events they listen to.
    flushSync();

    // --- the app-glue subscriptions: persistence + the address bar (everything else lives in the
    // panels, which subscribe to the kit themselves) ---
    let urlSyncTimer = 0;
    const scheduleUrlSync = (): void => {
        clearTimeout(urlSyncTimer);
        urlSyncTimer = window.setTimeout(() => {
            try {
                const url = composeShareUrl(mv.getView(), mv.activeId, config.get().selection, config.get().model.shape);
                history.replaceState(null, '', url);
            } catch (e) { Env.error('sync url', e); }
        }, 250);
    };
    mv.viewChanged.on(v => { saveView(v); scheduleUrlSync(); });
    mv.activePersist.on(id => { saveActive(id); scheduleUrlSync(); });
    session.selectionChanged.on(({ corners }) => config.update({ selection: corners }));
    // Selection / DEM / model changes alter the shareable slice → keep the URL live.
    config.subscribe(() => scheduleUrlSync());

    mv.selectSource(initialId);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
