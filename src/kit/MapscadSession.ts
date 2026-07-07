import { OsmVectorData } from './mapelements/OsmVectorData';
import type { OsmElement } from './mapelements/OverpassFeature';

/**
 * The kit's central session: the framework-agnostic source of truth for map-element *data* — the
 * element set per feature (incl. each element's `disabled` flag) and whether it's bound into the
 * printed model (`inPreview`). It knows nothing about OpenLayers, Three.js or Svelte.
 *
 * It announces exactly two typed events; a renderer (index.ts) and any data panel subscribe and
 * fan them out to the overlays / MapModel / object list:
 *   - `dataChanged(id)`    — the element set for `id` changed (download / load / enable / remove).
 *   - `previewChanged(id)` — the data feeding the 3D model for `id` changed (must re-bind + rebuild).
 *
 * The boundary rule: *does it influence the final 3D model?* → it lives here (element sets,
 * `disabled`, `inPreview`). Selection highlight, hover, marks, and the grid/corners stay in the
 * renderer (UI), which is why the grid binding (`withGrid`) is NOT done here.
 *
 * Fan-out semantics (the main correctness risk — preserved from the pre-restructure index.ts):
 *   - setElements: replace elements → `dataChanged`, AND `previewChanged` iff already `inPreview`.
 *   - setEnabled:  flip `disabled`  → `dataChanged` only (no print resync until next updatePreview).
 *   - remove:      drop elements    → `dataChanged` only.
 *   - updatePreview: bind into print → `previewChanged`.
 *   - resyncPreview: grid changed   → `previewChanged` for every `inPreview` feature.
 *   - clearAll:    wipe everything  → `dataChanged` + `previewChanged` per feature.
 */
export type SessionEvent = 'dataChanged' | 'previewChanged';
type Listener = (featureId: string) => void;

export class MapscadSession {
    private elements = new Map<string, OsmVectorData>();
    private inPreview = new Set<string>();
    private listeners: Record<SessionEvent, Set<Listener>> = {
        dataChanged: new Set(),
        previewChanged: new Set(),
    };

    /** Subscribe to an event; returns an unsubscribe. */
    on(event: SessionEvent, fn: Listener): () => void {
        this.listeners[event].add(fn);
        return () => { this.listeners[event].delete(fn); };
    }

    private emit(event: SessionEvent, id: string): void {
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
     *  until the next updatePreview; selection cleanup is the renderer's job). */
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
     *  `previewChanged` per feature, so the renderer clears overlays, the model and the object list. */
    clearAll(ids: readonly string[]): void {
        this.inPreview.clear();
        for (const id of ids) {
            this.elements.delete(id);
            this.emit('dataChanged', id);
            this.emit('previewChanged', id);
        }
    }
}
