// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProcessorConfigStore } from '../../src/kit/ProcessorConfig';
import { DEFAULT_MODEL_SETTINGS } from '../../src/kit/MapModel';

const sel = [[170.5, -45.87], [170.6, -45.87], [170.6, -45.9], [170.5, -45.9]];

// A clean in-memory localStorage. (Node ships an experimental built-in `localStorage`
// that shadows jsdom's and lacks `clear()`, so we provide our own.)
function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
        get length() { return map.size; },
        clear: () => map.clear(),
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => void map.set(k, String(v)),
        removeItem: (k: string) => void map.delete(k),
        key: (i: number) => [...map.keys()][i] ?? null,
    };
}

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
});

describe('localStorage persistence', () => {
    it('round-trips settings + selection across a fresh store', () => {
        const a = new ProcessorConfigStore();
        a.update({ demId: 'dunedin_elevation_raw', selection: sel as any, model: { heightScale: 3, socketEnabled: true } });

        const b = new ProcessorConfigStore();
        expect(b.get().demId).toBe('dunedin_elevation_raw');
        expect(b.get().selection).toEqual(sel);
        expect(b.get().model.heightScale).toBe(3);
        expect(b.get().model.socketEnabled).toBe(true);
    });
});

describe('coerce — partial / invalid blobs never hard-fail', () => {
    it('backfills missing fields from defaults', () => {
        localStorage.setItem('previewConfig', JSON.stringify({ demId: 'x' }));
        const store = new ProcessorConfigStore();
        expect(store.get().demId).toBe('x');
        expect(store.get().selection).toBeNull();
        expect(store.get().model).toEqual(DEFAULT_MODEL_SETTINGS);
    });

    it('rejects a selection that is not exactly four corners', () => {
        localStorage.setItem('previewConfig', JSON.stringify({ selection: [[1, 2], [3, 4]] }));
        const store = new ProcessorConfigStore();
        expect(store.get().selection).toBeNull();
    });

    it('survives malformed JSON and returns defaults', () => {
        localStorage.setItem('previewConfig', '{not json');
        const store = new ProcessorConfigStore();
        expect(store.get().demId).toBe('');
        expect(store.get().selection).toBeNull();
    });
});
