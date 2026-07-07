import type { MapscadSession } from '../kit/MapscadSession';

/** One row of the Data panel's object list: the id/name/disabled projection of an OSM element. */
export interface ElementRow {
    id: number;
    name: string;
    disabled: boolean;
}

/**
 * The framework-aware adapter (the "engine store") between the kit's `MapscadSession` and Svelte —
 * the seam the todo calls Option A. It subscribes to the session's `dataChanged` event ONCE and
 * mirrors each feature's element list into a rune-reactive `$state` field. Components read
 * `store.elements` (via `getContext(SESSION_DATA)`) and never subscribe to the session themselves.
 *
 * Runes work here — outside a `.svelte` component — because this is a `.svelte.ts` module, compiled
 * by svelte-loader's `compileModule` (see the `/\.svelte\.ts$/` rule in webpack.config.js). Reads of
 * `store.elements` inside a component stay reactive across the module boundary.
 *
 * Only session-derived DATA lives here; UI-local state (marks, filter, selection) stays in the
 * consuming component. Large data (geometry / DEM / meshes) never enters the store — it flows
 * session → renderer → Three/OL directly. Reactivity rule: on each event we *re-read* from the
 * session and reassign into `$state`; we never share and mutate a live ref on both sides.
 */
export class SessionStore {
    /** Per-feature element rows, keyed by feature id. Empty until the first `dataChanged`. */
    elements = $state<Record<string, ElementRow[]>>({});

    #session: MapscadSession;
    #off: () => void;

    constructor(session: MapscadSession) {
        this.#session = session;
        this.#off = session.mapElements.on('dataChanged', (id) => this.#sync(id));
    }

    /** Re-read one feature's element set from the session's manager and mirror it into `$state`. */
    #sync(id: string): void {
        const data = this.#session.mapElements.getElements(id);
        this.elements[id] = data
            ? data.list.map(e => ({ id: e.id, name: e.name ?? '', disabled: !!e.disabled }))
            : [];
    }

    /** Detach from the session (the component owning the store is being destroyed). */
    dispose(): void {
        this.#off();
    }
}
