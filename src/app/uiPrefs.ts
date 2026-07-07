import { Env } from '../Env';

// App-side UI preferences: viewer/display-only toggles that don't influence the exported model, so
// they live in the app layer (not the kit's ProcessorConfig) and each has its own localStorage key.
// They are NOT shared via the URL. Add a new pref = a new key + load/save pair here.

const SMOOTH_SHADING_KEY = 'smoothShading';

/** Smooth (vertex-normal) vs. flat shading in the 3D preview — a look-only toggle, never exported. */
export function loadSmoothShading(): boolean {
    try {
        const v = localStorage.getItem(SMOOTH_SHADING_KEY);
        if (v !== null) return v === 'true';
        // Migrate the old home (previewConfig.display.smoothShading) so the pref survives the move
        // out of the config. Read once; the value is rewritten under the new key on the next toggle.
        const legacy = localStorage.getItem('previewConfig');
        if (legacy) {
            const parsed = JSON.parse(legacy);
            if (typeof parsed?.display?.smoothShading === 'boolean') return parsed.display.smoothShading;
        }
    } catch (e) { Env.error('load smoothShading', e); }
    return true;
}

export function saveSmoothShading(v: boolean): void {
    try { localStorage.setItem(SMOOTH_SHADING_KEY, String(v)); } catch (e) { Env.error('save smoothShading', e); }
}
