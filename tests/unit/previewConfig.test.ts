// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PreviewConfigStore } from '../../src/PreviewConfig';
import { DEFAULT_MODEL_SETTINGS } from '../../src/MapModel';

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
    window.location.hash = '';
});

// Open the page as if it carried this config slice in its URL hash (index.ts composes the
// rest of the hash; the store only reads/writes the `c=` param).
function openWithParam(param: string): void {
    window.location.hash = 'c=' + param;
}

describe('localStorage persistence', () => {
    it('round-trips settings + selection across a fresh store', () => {
        const a = new PreviewConfigStore();
        a.update({ demId: 'dunedin_elevation_raw', selection: sel as any, model: { heightScale: 3, socketEnabled: true } });

        window.location.hash = ''; // isolate from the live-URL sync — read from storage only
        const b = new PreviewConfigStore();
        expect(b.get().demId).toBe('dunedin_elevation_raw');
        expect(b.get().selection).toEqual(sel);
        expect(b.get().model.heightScale).toBe(3);
        expect(b.get().model.socketEnabled).toBe(true);
    });
});

describe('share-link codec', () => {
    it('round-trips through the URL hash, including non-ASCII (utf-8 path)', () => {
        const a = new PreviewConfigStore();
        a.update({ demId: 'tëst_é_DEM', selection: sel as any, model: { heightScale: 2.5 } });
        const param = a.encodeParam();

        localStorage.clear();          // prove the link alone carries the config
        openWithParam(param);
        const b = new PreviewConfigStore();
        expect(b.get().demId).toBe('tëst_é_DEM');
        expect(b.get().selection).toEqual(sel);
        expect(b.get().model.heightScale).toBe(2.5);
    });

    it('does NOT carry preview-only display flags', () => {
        const a = new PreviewConfigStore();
        a.update({ display: { smoothShading: false } });
        const param = a.encodeParam();
        localStorage.clear();
        openWithParam(param);
        const b = new PreviewConfigStore();
        // The shared slice omits `display`, so it falls back to the default (true).
        expect(b.get().display.smoothShading).toBe(true);
    });

    it('a share link wins over local storage', () => {
        const seed = new PreviewConfigStore();
        seed.update({ demId: 'shared_dem' });
        const param = seed.encodeParam();

        localStorage.setItem('previewConfig', JSON.stringify({ version: 1, demId: 'local_dem' }));
        openWithParam(param);
        const store = new PreviewConfigStore();
        expect(store.get().demId).toBe('shared_dem');
    });
});

describe('coerce — partial / invalid blobs never hard-fail', () => {
    it('backfills missing fields from defaults', () => {
        localStorage.setItem('previewConfig', JSON.stringify({ demId: 'x' }));
        const store = new PreviewConfigStore();
        expect(store.get().demId).toBe('x');
        expect(store.get().selection).toBeNull();
        expect(store.get().model).toEqual(DEFAULT_MODEL_SETTINGS);
        expect(store.get().display.smoothShading).toBe(true);
    });

    it('rejects a selection that is not exactly four corners', () => {
        localStorage.setItem('previewConfig', JSON.stringify({ selection: [[1, 2], [3, 4]] }));
        const store = new PreviewConfigStore();
        expect(store.get().selection).toBeNull();
    });

    it('survives malformed JSON and returns defaults', () => {
        localStorage.setItem('previewConfig', '{not json');
        const store = new PreviewConfigStore();
        expect(store.get().demId).toBe('');
        expect(store.get().selection).toBeNull();
    });
});
