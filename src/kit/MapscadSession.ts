import { MapElementsManager } from './mapelements/MapElementsManager';
import { SelectionRect } from './SelectionRect';
import { Emitter } from './common/events';
import type { LonLat } from './common/mathHelper';

/** Payload of `selectionChanged`: the new corners, what they replaced, and whether the change came
 *  from the user drawing/editing on the map (`user: true` seeds preview defaults for a brand-new
 *  area) or from a programmatic set (restore from storage / share link / a headless script). */
export interface SelectionChange {
    corners: LonLat[] | null;
    prev: LonLat[] | null;
    user: boolean;
}

/**
 * The kit's central session — the facade a UI (or a headless script) drives. Command-in / event-out:
 * it owns the authoritative *session state* and announces changes; it never reaches into a viewer
 * (it must not import `kit/ui`).
 *
 * Today it owns two things:
 *   - the **selected region** — a `SelectionRect`, exposed as four lon/lat corners in the canonical
 *     order [SW,SE,NE,NW] (grid row 0 = the south edge), or null. `setSelection` NORMALIZES any
 *     cyclic order / winding through `SelectionRect.fromCorners`, so no consumer ever has to reason
 *     about corner order. The map is one producer of it, but a script can call `setSelection`
 *     directly; every consumer (preview resampling, config persistence, panel visibility)
 *     subscribes to `selectionChanged`.
 *   - **`mapElements`** — the `MapElementsManager`, everything map-element: per-feature element
 *     sets, preview membership, download/save/load I/O, and its own dataChanged/previewChanged
 *     events. Reached through the session (`session.mapElements`).
 *
 * It will grow to own the pipeline step-list and config/serialization (see the roadmap).
 */
export class MapscadSession {
    private rect: SelectionRect | null = null;
    private selection: LonLat[] | null = null; // = rect.toCorners(), cached for the LonLat[] surface
    /** Everything map-element (data + preview membership + I/O); see MapElementsManager. */
    readonly mapElements = new MapElementsManager(() => this.selection);
    /** The selected region changed — fired on every `setSelection`, including clears. */
    readonly selectionChanged = new Emitter<SelectionChange>();

    /** The selected region as four lon/lat corners in canonical [SW,SE,NE,NW] order, or null. */
    getSelection(): LonLat[] | null {
        return this.selection;
    }

    /** The selected region as a `SelectionRect` (canonical corners + centroid/bearing/extent
     *  helpers), or null. Same state as `getSelection`, richer surface. */
    getSelectionRect(): SelectionRect | null {
        return this.rect;
    }

    /** Set the selected region (from the map, or a script) and fan it out. The corners are
     *  normalized to the canonical [SW,SE,NE,NW] order via `SelectionRect.fromCorners` — any cyclic
     *  order or winding in, one order out (malformed non-null input throws). Clearing the region
     *  also drops all element data first (no region ⇒ nothing to scope elements to) — that
     *  universal response lives here so a headless caller gets it too; UI-only responses (panel
     *  visibility, stale flags, zoom seeding) belong to `selectionChanged` subscribers. */
    setSelection(corners: LonLat[] | null, opts?: { user?: boolean }): void {
        const prev = this.selection;
        this.rect = corners ? SelectionRect.fromCorners(corners) : null;
        this.selection = this.rect ? this.rect.toCorners() : null;
        if (!this.rect) this.mapElements.clearAll();
        this.selectionChanged.emit({ corners: this.selection, prev, user: opts?.user ?? false });
    }
}
