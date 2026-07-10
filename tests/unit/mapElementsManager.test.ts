import { describe, it, expect, beforeEach } from 'vitest';
import { MapElementsManager } from '../../src/kit/mapelements/MapElementsManager';
import { MapscadSession } from '../../src/kit/MapscadSession';
import type { OsmElement } from '../../src/kit/mapelements/OverpassFeature';
import type { LonLat } from '../../src/kit/common/mathHelper';

const el = (id: number, name?: string): OsmElement => ({ id, name, coords: [[0, 0], [1, 1]] as LonLat[] });

/** Records every emitted event in order so the fan-out semantics can be asserted exactly. */
function spy(m: MapElementsManager) {
    const events: Array<[string, string]> = [];
    m.on('dataChanged', id => events.push(['dataChanged', id]));
    m.on('previewChanged', id => events.push(['previewChanged', id]));
    return events;
}

describe('MapElementsManager fan-out semantics', () => {
    let m: MapElementsManager;
    let events: Array<[string, string]>;
    beforeEach(() => { m = new MapElementsManager(() => null); events = spy(m); });

    it('setElements before preview: dataChanged only', () => {
        m.setElements('tracks', [el(1), el(2)]);
        expect(events).toEqual([['dataChanged', 'tracks']]);
        expect(m.hasElements('tracks')).toBe(true);
        expect(m.getElements('tracks')!.count).toBe(2);
    });

    it('setElements after preview: dataChanged AND previewChanged', () => {
        m.setElements('tracks', [el(1)]);
        m.updatePreview('tracks');
        events.length = 0;
        m.setElements('tracks', [el(1), el(2)]);
        expect(events).toEqual([['dataChanged', 'tracks'], ['previewChanged', 'tracks']]);
    });

    it('updatePreview: previewChanged, and no-op on an empty/absent set', () => {
        m.updatePreview('tracks'); // absent → no-op
        expect(events).toEqual([]);
        m.setElements('tracks', [el(1)]);
        events.length = 0;
        m.updatePreview('tracks');
        expect(events).toEqual([['previewChanged', 'tracks']]);
        expect(m.isInPreview('tracks')).toBe(true);
    });

    it('setEnabled: dataChanged only, flips disabled', () => {
        m.setElements('tracks', [el(1), el(2)]);
        m.updatePreview('tracks');
        events.length = 0;
        m.setEnabled('tracks', [1], false);
        expect(events).toEqual([['dataChanged', 'tracks']]); // NOT previewChanged
        expect(m.getElements('tracks')!.list.find(e => e.id === 1)!.disabled).toBe(true);
        m.setEnabled('tracks', [1], true);
        expect(m.getElements('tracks')!.list.find(e => e.id === 1)!.disabled).toBeUndefined();
    });

    it('remove: dataChanged only, drops the ids', () => {
        m.setElements('tracks', [el(1), el(2), el(3)]);
        m.updatePreview('tracks');
        events.length = 0;
        m.remove('tracks', [2]);
        expect(events).toEqual([['dataChanged', 'tracks']]); // NOT previewChanged
        expect(m.getElements('tracks')!.list.map(e => e.id)).toEqual([1, 3]);
    });

    it('resyncPreview: previewChanged for every inPreview feature only', () => {
        m.setElements('tracks', [el(1)]);
        m.setElements('streets', [el(2)]);
        m.updatePreview('tracks'); // streets downloaded but NOT in preview
        events.length = 0;
        m.resyncPreview();
        expect(events).toEqual([['previewChanged', 'tracks']]);
    });

    it('clearAll: dataChanged + previewChanged per feature, wipes data + preview', () => {
        m.setElements('tracks', [el(1)]);
        m.updatePreview('tracks');
        events.length = 0;
        m.clearAll(['buildings', 'streets', 'tracks']);
        expect(events).toEqual([
            ['dataChanged', 'buildings'], ['previewChanged', 'buildings'],
            ['dataChanged', 'streets'], ['previewChanged', 'streets'],
            ['dataChanged', 'tracks'], ['previewChanged', 'tracks'],
        ]);
        expect(m.hasElements('tracks')).toBe(false);
        expect(m.isInPreview('tracks')).toBe(false);
        expect(m.previewIds()).toEqual([]);
    });

    it('loadFiles: merges payloads, dedupes real ids, renumbers synthetic ids across files', () => {
        // Two saved-JSON payloads: way 1 appears in both (dedupe); each file carries a synthetic
        // (negative-id) track that must stay unique after the merge.
        const payload = (els: OsmElement[]) => els; // waysFromJson passes stored arrays through
        const count = m.loadFiles('tracks', [
            payload([el(1, 'shared'), el(-1, 'gpx a')]),
            payload([el(1, 'shared'), el(2, 'only b'), el(-1, 'gpx b')]),
        ]);
        expect(count).toBe(4); // 1, gpx a, 2, gpx b — the duplicate way 1 dropped
        const ids = m.getElements('tracks')!.list.map(e => e.id);
        expect(ids.filter(i => i > 0)).toEqual([1, 2]);
        expect(new Set(ids.filter(i => i < 0)).size).toBe(2); // synthetics renumbered, no collision
    });

    it('toJson: the current list, or null when absent/empty', () => {
        expect(m.toJson('tracks')).toBeNull();
        m.setElements('tracks', [el(1)]);
        expect(m.toJson('tracks')!.map(e => e.id)).toEqual([1]);
        m.setElements('tracks', []);
        expect(m.toJson('tracks')).toBeNull();
    });

    it('download without a selection returns 0 and fetches nothing', async () => {
        await expect(m.download('tracks')).resolves.toBe(0);
        expect(events).toEqual([]);
    });

    it('on() returns an unsubscribe', () => {
        const seen: string[] = [];
        const off = m.on('dataChanged', id => seen.push(id));
        m.setElements('tracks', [el(1)]);
        off();
        m.setElements('streets', [el(2)]);
        expect(seen).toEqual(['tracks']);
    });
});

describe('MapscadSession selection', () => {
    // Canonical corner order SW, SE, NE, NW — setSelection normalizes to it, so a fixture in this
    // order passes through verbatim (normalization itself is covered in selectionRect.test.ts).
    const sel: LonLat[] = [[170.5, -45.9], [170.6, -45.9], [170.6, -45.87], [170.5, -45.87]];

    it('setSelection emits selectionChanged with corners, prev and the user flag', () => {
        const s = new MapscadSession();
        const seen: Array<{ corners: LonLat[] | null; prev: LonLat[] | null; user: boolean }> = [];
        s.selectionChanged.on(c => seen.push(c));
        s.setSelection(sel, { user: true });
        s.setSelection(null);
        expect(seen).toEqual([
            { corners: sel, prev: null, user: true },
            { corners: null, prev: sel, user: false },
        ]);
        expect(s.getSelection()).toBeNull();
    });

    it('clearing the selection drops all element data (universal response)', () => {
        const s = new MapscadSession();
        s.setSelection(sel);
        s.mapElements.setElements('tracks', [el(1)]);
        s.mapElements.updatePreview('tracks');
        s.setSelection(null);
        expect(s.mapElements.hasElements('tracks')).toBe(false);
        expect(s.mapElements.previewIds()).toEqual([]);
    });

    it('the manager downloads against the session selection (none ⇒ 0)', async () => {
        const s = new MapscadSession();
        await expect(s.mapElements.download('tracks')).resolves.toBe(0);
    });
});
