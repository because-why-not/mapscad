import type { GeoView, MapEngine } from './engine/MapEngine';
import { sunPosition } from './solar';

export interface MapControllerOptions {
    engines: MapEngine[];
    container: HTMLElement;
    initialView: GeoView;
    initialSunDate?: Date;
    initialShadows?: boolean;
    onActiveChange?: (id: string) => void;   // active source changed (update UI)
    onViewPersist?: (view: GeoView) => void; // user moved the map (persist)
    onActivePersist?: (id: string) => void;  // active source changed (persist)
}

/**
 * Engine-agnostic coordinator. Routes a source id to whichever MapEngine owns it,
 * mounts engines lazily, hands the live view across engine switches so the camera
 * stays continuous, and reports active/view changes back to the host. Knows nothing
 * about OpenLayers, MapLibre, or any concrete mapping library.
 */
export class MapController {
    activeId = '';
    private bySource = new Map<string, MapEngine>();
    private mounted = new Set<MapEngine>();
    private active: MapEngine | null = null;
    private view: GeoView;
    private sunDate: Date;
    private shadows: boolean;

    constructor(private opts: MapControllerOptions) {
        this.view = opts.initialView;
        this.sunDate = opts.initialSunDate ?? new Date();
        this.shadows = opts.initialShadows ?? true;
        for (const engine of opts.engines) {
            for (const id of engine.sourceIds) this.bySource.set(id, engine);
        }
    }

    get sourceIds(): string[] {
        return [...this.bySource.keys()];
    }

    async select(id: string): Promise<void> {
        const engine = this.bySource.get(id);
        if (!engine) return;

        if (engine !== this.active) {
            if (this.active) {
                this.view = this.active.getView();
                this.opts.onViewPersist?.(this.view);
                this.active.hide();
            }
            if (!this.mounted.has(engine)) {
                await engine.mount(this.opts.container, this.view);
                engine.onViewChange(() => {
                    this.view = engine.getView();
                    this.opts.onViewPersist?.(this.view);
                });
                this.mounted.add(engine);
            }
            engine.setActiveSource(id);
            this.applySun(engine);
            engine.setShadows?.(this.shadows);
            engine.show(this.view);
            this.active = engine;
        } else {
            engine.setActiveSource(id);
            this.applySun(engine);
            engine.setShadows?.(this.shadows);
        }

        this.activeId = id;
        this.opts.onActiveChange?.(id);
        this.opts.onActivePersist?.(id);
    }

    /** Set the date/time used to compute the sun position, and apply it live. */
    setSunDate(date: Date): void {
        this.sunDate = date;
        if (this.active) this.applySun(this.active);
    }

    private applySun(engine: MapEngine): void {
        if (!engine.setSun) return;
        const { azimuth, altitude } = sunPosition(this.sunDate, this.view.lat, this.view.lng);
        engine.setSun(azimuth, altitude);
    }

    /** Toggle cast shadows on the active (and future) engines that support them. */
    setShadowsEnabled(enabled: boolean): void {
        this.shadows = enabled;
        this.active?.setShadows?.(enabled);
    }
}
