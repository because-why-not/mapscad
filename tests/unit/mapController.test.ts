import { describe, it, expect } from 'vitest';
import { MapController } from '../../src/kit/ui/MapController';
import type { GeoView, MapEngine } from '../../src/kit/ui/MapEngine';

/** A MapEngine whose mount() stays pending until the test resolves it, to hold the
 *  controller inside the `await engine.mount(...)` window. */
class FakeEngine implements MapEngine {
    readonly sourceIds: string[];
    mountCalls = 0;
    viewChangeSubscriptions = 0;
    private resolvers: (() => void)[] = [];

    constructor(ids: string[]) { this.sourceIds = ids; }

    mount(): Promise<void> {
        this.mountCalls++;
        const pending = new Promise<void>(resolve => this.resolvers.push(resolve));
        return pending;
    }
    finishMounts(): void { for (const r of this.resolvers) r(); }

    setActiveSource(): void {}
    show(): void {}
    hide(): void {}
    getView(): GeoView { return { lng: 0, lat: 0, zoom: 1 }; }
    onViewChange(): void { this.viewChangeSubscriptions++; }
}

/**
 * Bug repro (code review): MapController.select() checks `mounted.has(engine)` before an
 * awaited engine.mount(), so a second select() arriving while the first mount is still in
 * flight passes the same check and mounts the engine AGAIN — duplicate map DOM and a
 * duplicate onViewChange subscription. Real-world window: the MapLibre engine's first mount
 * dynamically imports maplibre-gl, so rapid source switching right after load can hit it.
 * When fixing (e.g. store the mount promise per engine and await it), drop the `.fails`.
 */
describe('MapController.select', () => {
    it.fails('selecting twice while the first mount is in flight mounts the engine once', async () => {
        const engine = new FakeEngine(['a', 'b']);
        const controller = new MapController({
            engines: [engine],
            container: {} as HTMLElement, // never touched by FakeEngine
            initialView: { lng: 0, lat: 0, zoom: 1 },
        });

        const firstSelect = controller.select('a');
        const secondSelect = controller.select('b'); // same engine, first mount still pending
        engine.finishMounts();
        await Promise.all([firstSelect, secondSelect]);

        expect(engine.mountCalls).toBe(1);             // currently 2
        expect(engine.viewChangeSubscriptions).toBe(1); // currently 2
    });
});
