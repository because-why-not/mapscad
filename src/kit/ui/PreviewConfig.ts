import { Env } from '../../Env';

/**
 * Viewer-only render preferences for the 3D preview. Part of `kit/ui` (browser-land): both
 * `TerrainPreview` and `PreviewController` accept an instance — the viewer applies the flags,
 * the controller persists changes — so the app only constructs it and seeds its menu state.
 * NOT part of `ProcessorConfig` (localStorage key 'previewConfig', the export config): these
 * flags never affect the exported model and are not shared via the URL.
 *
 * Deliberately NO versioning or migration: render flags are cheap to lose, so malformed or
 * missing storage just falls back to the defaults. Add a render flag = add a field + default.
 */
export interface PreviewConfigData {
    /** Smooth (interpolated vertex normals) vs flat (per-face) shading. */
    smoothShading: boolean;
}

const DEFAULTS: PreviewConfigData = { smoothShading: true };
const STORAGE_KEY = 'previewUiConfig';

export class PreviewConfig {
    private data: PreviewConfigData = { ...DEFAULTS };

    constructor() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) this.data = { ...DEFAULTS, ...JSON.parse(raw) };
        } catch (e) { Env.error('load previewUiConfig', e); } // junk → defaults, by design
    }

    get(): PreviewConfigData {
        return this.data;
    }

    /** Merge a partial update and persist. */
    update(patch: Partial<PreviewConfigData>): void {
        this.data = { ...this.data, ...patch };
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch (e) { Env.error('save previewUiConfig', e); }
    }
}
