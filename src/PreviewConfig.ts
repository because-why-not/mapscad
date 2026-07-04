import type { LonLat } from './mathHelper';
import { type ModelSettings, DEFAULT_MODEL_SETTINGS } from './MapModel';
import { Env } from './Env';

/**
 * The single source of truth for everything that defines a 3D preview / export: which
 * DEM, the selected rectangle, the export geometry settings, and the preview-only display
 * flags. One object, one storage key (`previewConfig`). The selected area is shared via the
 * URL hash in a human-readable form composed by index.ts — this store only persists to
 * localStorage.
 *
 *   Add an EXPORT setting  -> add the field to ModelSettings (+ default + clamp) in
 *                             MapModel.ts. It persists and shares automatically, because
 *                             `config.model` is serialized wholesale.
 *   Add a PREVIEW-only flag -> add a field to `display` below + its default.
 *
 * Nothing else needs touching: there are no per-field load/save functions.
 */
export interface PreviewConfig {
    demId: string;                       // elevation source id (manifest name)
    selection: LonLat[] | null;          // selected rectangle, order TL,TR,BR,BL
    model: ModelSettings;                // export geometry — sanitized by MapModel
    display: { smoothShading: boolean };  // preview-only; persisted, NOT shared
}

export const DEFAULT_CONFIG: PreviewConfig = {
    demId: '',
    selection: null,
    model: { ...DEFAULT_MODEL_SETTINGS },
    display: { smoothShading: true },
};

const VERSION = 1;
const STORAGE_KEY = 'previewConfig';

export class PreviewConfigStore {
    private cfg: PreviewConfig;
    private subs = new Set<(c: PreviewConfig) => void>();

    // Restore the last local config, else defaults. (A shared selection in the URL is applied
    // on top by index.ts, which owns the human-readable URL hash.)
    constructor() {
        this.cfg = load() ?? clone(DEFAULT_CONFIG);
    }

    get(): PreviewConfig {
        return this.cfg;
    }

    /** Merge a shallow patch and persist. `model` / `display` merge one level deep. */
    update(patch: Partial<PreviewConfig>): void {
        this.cfg = {
            ...this.cfg,
            ...patch,
            model: patch.model ? { ...this.cfg.model, ...patch.model } : this.cfg.model,
            display: patch.display ? { ...this.cfg.display, ...patch.display } : this.cfg.display,
        };
        save(this.cfg);
        for (const cb of this.subs) cb(this.cfg);
    }

    subscribe(cb: (c: PreviewConfig) => void): () => void {
        this.subs.add(cb);
        return () => this.subs.delete(cb);
    }
}

// --- serialization -----------------------------------------------------------

function save(cfg: PreviewConfig): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, ...cfg }));
    } catch (e) { Env.error('save previewConfig', e); }
}

function load(): PreviewConfig | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? coerce(JSON.parse(raw)) : null;
    } catch (e) { Env.error('load previewConfig', e); return null; }
}

/** Fill any missing/invalid fields from defaults so old or partial blobs never hard-fail. */
function coerce(raw: any): PreviewConfig {
    const r = migrate(raw) ?? {};
    return {
        demId: typeof r.demId === 'string' ? r.demId : DEFAULT_CONFIG.demId,
        selection: Array.isArray(r.selection) && r.selection.length === 4 ? r.selection : null,
        model: { ...DEFAULT_CONFIG.model, ...(r.model ?? {}) },
        display: { ...DEFAULT_CONFIG.display, ...(r.display ?? {}) },
    };
}

/** Upgrade older payload shapes here when VERSION is bumped. v1: pass through. */
function migrate(raw: any): any {
    return raw;
}

function clone(c: PreviewConfig): PreviewConfig {
    return { ...c, model: { ...c.model }, display: { ...c.display }, selection: c.selection };
}
