/**
 * Engine-agnostic map abstraction. The rest of the app (MapController, App.svelte,
 * index.ts orchestration) depends ONLY on these types — never on OpenLayers,
 * MapLibre, or any other concrete mapping library. To add/swap a renderer, write a
 * new class that implements MapEngine and register it in the composition root.
 */

/** A geographic camera position, in the app's neutral units (lon/lat + XYZ-style zoom). */
export interface GeoView {
    lng: number;
    lat: number;
    zoom: number;
}

export interface MapEngine {
    /** Ids of the map sources this engine can render (matches descriptor ids in the UI). */
    readonly sourceIds: string[];

    /** Create the underlying map inside `parent`, positioned at `view`. Called once. */
    mount(parent: HTMLElement, view: GeoView): Promise<void>;

    /** Choose which of `sourceIds` is currently shown. */
    setActiveSource(id: string): void;

    /** Reveal this engine's surface and (re)position it at `view`. */
    show(view: GeoView): void;

    /** Hide this engine's surface (the instance is kept alive for fast re-show). */
    hide(): void;

    /** Current camera position, in neutral GeoView units. */
    getView(): GeoView;

    /** Register a callback fired on user-driven view changes. Called once after mount. */
    onViewChange(cb: () => void): void;

    /**
     * Optional: set the sun/light direction (azimuth & altitude, degrees). Engines
     * that don't model lighting — or sources that have nothing to light — may treat
     * this as a no-op.
     */
    setSun?(azimuthDeg: number, altitudeDeg: number): void;
}
