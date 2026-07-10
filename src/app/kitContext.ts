import type { MapscadSession } from '../kit/MapscadSession';
import type { ProcessorConfigStore } from '../kit/ProcessorConfig';
import type { MapViewer } from '../kit/ui/MapViewer';
import type { PreviewController } from '../kit/ui/PreviewController';
import type { PreviewConfig } from '../kit/ui/PreviewConfig';

/**
 * The kit objects the UI talks to, provided once by `App.svelte` under the `KIT` context key so
 * every panel can call kit methods and subscribe to kit events directly — no callback props, no
 * imperative forwarder chains. A Symbol (not a magic string) so provider and consumers can't drift.
 *
 * `mapViewer` / `previewController` are constructed by index.ts right after mount (they need their
 * mount <div>s) and are non-null by the time any component `$effect` or event handler runs — but
 * they ARE null while a component's <script> top level executes, so: subscribe inside `$effect`,
 * and use optional chaining in handlers.
 */
export interface Kit {
    session: MapscadSession;
    config: ProcessorConfigStore;
    /** Viewer-only render flags (kit/ui) — constructed with the rest of the kit, so non-null from
     *  the start; panels seed their menu state from it. */
    previewConfig: PreviewConfig;
    mapViewer: MapViewer | null;
    previewController: PreviewController | null;
}

export const KIT = Symbol('kit');
