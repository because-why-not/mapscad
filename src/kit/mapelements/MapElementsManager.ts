import { OsmVectorData } from './OsmVectorData';
import { fetchFeatureRaw, parseWays, waysFromJson, type OsmElement } from './OverpassFeature';
import { OSM_FEATURES, osmFeature } from './osmFeatures';
import type { LonLat } from '../common/mathHelper';

/**
 * Everything map-element (OSM today; more element types later): the framework-agnostic source of
 * truth for the element set per feature (incl. each element's `disabled` flag), whether a feature is
 * bound into the printed model (`inPreview`), and the element I/O — Overpass download, JSON save,
 * multi-file load/merge. It knows nothing about OpenLayers, Three.js or Svelte. Reached through the
 * session (`session.mapElements`), which is also where it reads the selected region from.
 *
 * It announces exactly two typed events; the viewers and the data panel subscribe and fan them out
 * to the overlays / MapModel / object list:
 *   - `dataChanged(id)`    — the element set for `id` changed (download / load / enable / remove).
 *   - `previewChanged(id)` — the data feeding the 3D model for `id` changed (must re-bind + rebuild).
 *
 * The boundary rule: *does it influence the final 3D model?* → it lives here (element sets,
 * `disabled`, `inPreview`). Selection highlight, hover, marks, and the grid binding stay in the
 * viewers (UI), which is why `withGrid` is NOT called here.
 *
 * Fan-out semantics (the main correctness risk — preserved from the pre-restructure index.ts):
 *   - setElements: replace elements → `dataChanged`, AND `previewChanged` iff already `inPreview`.
 *   - setEnabled:  flip `disabled`  → `dataChanged` only (no print resync until next updatePreview).
 *   - remove:      drop elements    → `dataChanged` only.
 *   - updatePreview: bind into print → `previewChanged`.
 *   - resyncPreview: grid changed   → `previewChanged` for every `inPreview` feature.
 *   - clearAll:    wipe everything  → `dataChanged` + `previewChanged` per feature.
 */
export type ElementsEvent = 'dataChanged' | 'previewChanged';
type Listener = (featureId: string) => void;

export class MapElementsManager {
    private elements = new Map<string, OsmVectorData>();
    private inPreview = new Set<string>();
    private listeners: Record<ElementsEvent, Set<Listener>> = {
        dataChanged: new Set(),
        previewChanged: new Set(),
    };

    /** @param getSelection The session's selected region — the bbox downloads are scoped to. */
    constructor(private readonly getSelection: () => LonLat[] | null) {}

    /** Subscribe to an event; returns an unsubscribe. */
    on(event: ElementsEvent, fn: Listener): () => void {
        this.listeners[event].add(fn);
        return () => { this.listeners[event].delete(fn); };
    }

    private emit(event: ElementsEvent, id: string): void {
        for (const fn of this.listeners[event]) fn(id);
    }

    // --- queries ---------------------------------------------------------------

    /** The current element set for a feature (source of truth), or undefined if none downloaded. */
    getElements(id: string): OsmVectorData | undefined {
        return this.elements.get(id);
    }

    /** Whether the feature has a non-empty element set. */
    hasElements(id: string): boolean {
        const data = this.elements.get(id);
        return !!data && !data.isEmpty();
    }

    /** Whether the feature is currently bound into the printed model. */
    isInPreview(id: string): boolean {
        return this.inPreview.has(id);
    }

    /** The feature ids currently bound into the print. */
    previewIds(): string[] {
        return [...this.inPreview];
    }

    // --- element I/O -------------------------------------------------------------

    /** Download one feature's elements from Overpass for the current selection and ingest them.
     *  Returns the element count so the UI can report it; throws bubble to the caller. */
    async download(id: string): Promise<number> {
        const corners = this.getSelection();
        if (!corners) return 0;
        const def = osmFeature(id);
        const json = await fetchFeatureRaw(def, corners);
        const fetched = parseWays(def, json);
        this.setElements(id, fetched);
        return fetched.length;
    }

    /** The current element set as savable JSON. Null when nothing's loaded. */
    toJson(id: string): readonly OsmElement[] | null {
        const data = this.elements.get(id);
        return data && !data.isEmpty() ? data.list : null;
    }

    /** Load a feature from one or more previously saved / track files: parse each payload and MERGE
     *  into one set (multi-file select). Real OSM ids (positive) are deduped so the same way in two
     *  overlapping files appears once; synthetic ids (GPX tracks / legacy polylines, negative) are
     *  renumbered to a single running counter so they stay unique across files — `waysFromJson`
     *  restarts them at -1 per payload. Ingested like a fresh download. */
    loadFiles(id: string, payloads: any[]): number {
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
        this.setElements(id, merged);
        return merged.length;
    }

    // --- commands --------------------------------------------------------------

    /** Ingest a freshly fetched / loaded element set for a feature (download / load). It becomes the
     *  editable source of truth. `dataChanged` always; `previewChanged` only if already in the print
     *  (so downloading a large set just to view/edit it doesn't trigger a geometry rebuild). */
    setElements(id: string, els: OsmElement[]): void {
        this.elements.set(id, new OsmVectorData(els));
        this.emit('dataChanged', id);
        if (this.inPreview.has(id)) this.emit('previewChanged', id);
    }

    /** Flip `disabled` on a batch of ids (Enable/Disable). `dataChanged` only — the print reflects
     *  it on the next updatePreview, not here. */
    setEnabled(id: string, ids: number[], enabled: boolean): void {
        const data = this.elements.get(id);
        if (!data || !ids.length) return;
        const set = new Set(ids);
        const next = data.list.map(e => set.has(e.id) ? { ...e, disabled: enabled ? undefined : true } : e);
        this.elements.set(id, new OsmVectorData(next));
        this.emit('dataChanged', id);
    }

    /** Permanently remove a batch of ids. `dataChanged` only (deleted objects stay in the print
     *  until the next updatePreview; selection cleanup is the viewer's job). */
    remove(id: string, ids: number[]): void {
        const data = this.elements.get(id);
        if (!data || !ids.length) return;
        const set = new Set(ids);
        const next = data.list.filter(e => !set.has(e.id));
        this.elements.set(id, new OsmVectorData(next));
        this.emit('dataChanged', id);
    }

    /** Bind a downloaded feature into the printed model (Update preview). `previewChanged`. No-op for
     *  an empty/absent set. */
    updatePreview(id: string): void {
        if (!this.hasElements(id)) return;
        this.inPreview.add(id);
        this.emit('previewChanged', id);
    }

    /** The grid/corners changed: re-bind every feature already in the print. `previewChanged` each. */
    resyncPreview(): void {
        for (const id of this.inPreview) this.emit('previewChanged', id);
    }

    /** Drop every feature's data + preview binding (selection cleared). `dataChanged` +
     *  `previewChanged` per feature, so the viewers clear overlays, the model and the object list. */
    clearAll(ids: readonly string[] = OSM_FEATURES.map(f => f.id)): void {
        this.inPreview.clear();
        for (const id of ids) {
            this.elements.delete(id);
            this.emit('dataChanged', id);
            this.emit('previewChanged', id);
        }
    }
}
