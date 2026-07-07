import type { LonLat } from './common/mathHelper';
import { type ModelSettings, DEFAULT_MODEL_SETTINGS } from './MapModel';
import { Env } from '../Env';

/**
 * The single source of truth for everything that defines a 3D preview / export: which
 * DEM, the selected rectangle, and the export geometry settings. One object, one storage
 * key (`previewConfig`). The selected area is shared via the URL hash in a human-readable
 * form composed by index.ts — this store only persists to localStorage. Viewer-only display
 * toggles (e.g. smooth shading) are NOT here: they don't affect the export, so they live app-
 * side in `app/uiPrefs.ts`.
 *
 *   Add an EXPORT setting -> add the field to ModelSettings (+ default + clamp) in MapModel.ts.
 *                            It persists and shares automatically, because `config.model` is
 *                            serialized wholesale. Nothing else needs touching.
 */
export interface ProcessorConfig {
    demId: string;                       // elevation source id (manifest name)
    selection: LonLat[] | null;          // selected rectangle, order TL,TR,BR,BL
    model: ModelSettings;                // export geometry — sanitized by MapModel
}

export const DEFAULT_CONFIG: ProcessorConfig = {
    demId: '',
    selection: null,
    model: { ...DEFAULT_MODEL_SETTINGS },
};

const VERSION = 1;
const STORAGE_KEY = 'previewConfig';

export class ProcessorConfigStore {
    private cfg: ProcessorConfig;
    private subs = new Set<(c: ProcessorConfig) => void>();

    // Restore the last local config, else defaults. (A shared selection in the URL is applied
    // on top by index.ts, which owns the human-readable URL hash.)
    constructor() {
        this.cfg = load() ?? clone(DEFAULT_CONFIG);
    }

    get(): ProcessorConfig {
        return this.cfg;
    }

    /** Merge a shallow patch and persist. `model` merges one level deep. */
    update(patch: Partial<ProcessorConfig>): void {
        this.cfg = {
            ...this.cfg,
            ...patch,
            model: patch.model ? { ...this.cfg.model, ...patch.model } : this.cfg.model,
        };
        save(this.cfg);
        for (const cb of this.subs) cb(this.cfg);
    }

    subscribe(cb: (c: ProcessorConfig) => void): () => void {
        this.subs.add(cb);
        return () => this.subs.delete(cb);
    }
}

// --- serialization -----------------------------------------------------------

function save(cfg: ProcessorConfig): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, ...cfg }));
    } catch (e) { Env.error('save previewConfig', e); }
}

function load(): ProcessorConfig | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? coerce(JSON.parse(raw)) : null;
    } catch (e) { Env.error('load previewConfig', e); return null; }
}

/** Fill any missing/invalid fields from defaults so old or partial blobs never hard-fail. */
function coerce(raw: any): ProcessorConfig {
    const r = migrate(raw) ?? {};
    return {
        demId: typeof r.demId === 'string' ? r.demId : DEFAULT_CONFIG.demId,
        selection: Array.isArray(r.selection) && r.selection.length === 4 ? r.selection : null,
        model: { ...DEFAULT_CONFIG.model, ...(r.model ?? {}) },
    };
}

/** Upgrade older payload shapes here when VERSION is bumped. v1: pass through. */
function migrate(raw: any): any {
    return raw;
}

function clone(c: ProcessorConfig): ProcessorConfig {
    return { ...c, model: { ...c.model }, selection: c.selection };
}
