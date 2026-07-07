import { describe, it, expect, beforeEach } from 'vitest';
import { MapscadSession } from '../../src/kit/MapscadSession';
import type { OsmElement } from '../../src/kit/mapelements/OverpassFeature';
import type { LonLat } from '../../src/kit/common/mathHelper';

const el = (id: number, name?: string): OsmElement => ({ id, name, coords: [[0, 0], [1, 1]] as LonLat[] });

/** Records every emitted event in order so the fan-out semantics can be asserted exactly. */
function spy(session: MapscadSession) {
    const events: Array<[string, string]> = [];
    session.on('dataChanged', id => events.push(['dataChanged', id]));
    session.on('previewChanged', id => events.push(['previewChanged', id]));
    return events;
}

describe('MapscadSession fan-out semantics', () => {
    let s: MapscadSession;
    let events: Array<[string, string]>;
    beforeEach(() => { s = new MapscadSession(); events = spy(s); });

    it('setElements before preview: dataChanged only', () => {
        s.setElements('tracks', [el(1), el(2)]);
        expect(events).toEqual([['dataChanged', 'tracks']]);
        expect(s.hasElements('tracks')).toBe(true);
        expect(s.getElements('tracks')!.count).toBe(2);
    });

    it('setElements after preview: dataChanged AND previewChanged', () => {
        s.setElements('tracks', [el(1)]);
        s.updatePreview('tracks');
        events.length = 0;
        s.setElements('tracks', [el(1), el(2)]);
        expect(events).toEqual([['dataChanged', 'tracks'], ['previewChanged', 'tracks']]);
    });

    it('updatePreview: previewChanged, and no-op on an empty/absent set', () => {
        s.updatePreview('tracks'); // absent → no-op
        expect(events).toEqual([]);
        s.setElements('tracks', [el(1)]);
        events.length = 0;
        s.updatePreview('tracks');
        expect(events).toEqual([['previewChanged', 'tracks']]);
        expect(s.isInPreview('tracks')).toBe(true);
    });

    it('setEnabled: dataChanged only, flips disabled', () => {
        s.setElements('tracks', [el(1), el(2)]);
        s.updatePreview('tracks');
        events.length = 0;
        s.setEnabled('tracks', [1], false);
        expect(events).toEqual([['dataChanged', 'tracks']]); // NOT previewChanged
        expect(s.getElements('tracks')!.list.find(e => e.id === 1)!.disabled).toBe(true);
        s.setEnabled('tracks', [1], true);
        expect(s.getElements('tracks')!.list.find(e => e.id === 1)!.disabled).toBeUndefined();
    });

    it('remove: dataChanged only, drops the ids', () => {
        s.setElements('tracks', [el(1), el(2), el(3)]);
        s.updatePreview('tracks');
        events.length = 0;
        s.remove('tracks', [2]);
        expect(events).toEqual([['dataChanged', 'tracks']]); // NOT previewChanged
        expect(s.getElements('tracks')!.list.map(e => e.id)).toEqual([1, 3]);
    });

    it('resyncPreview: previewChanged for every inPreview feature only', () => {
        s.setElements('tracks', [el(1)]);
        s.setElements('streets', [el(2)]);
        s.updatePreview('tracks'); // streets downloaded but NOT in preview
        events.length = 0;
        s.resyncPreview();
        expect(events).toEqual([['previewChanged', 'tracks']]);
    });

    it('clearAll: dataChanged + previewChanged per feature, wipes data + preview', () => {
        s.setElements('tracks', [el(1)]);
        s.updatePreview('tracks');
        events.length = 0;
        s.clearAll(['buildings', 'streets', 'tracks']);
        expect(events).toEqual([
            ['dataChanged', 'buildings'], ['previewChanged', 'buildings'],
            ['dataChanged', 'streets'], ['previewChanged', 'streets'],
            ['dataChanged', 'tracks'], ['previewChanged', 'tracks'],
        ]);
        expect(s.hasElements('tracks')).toBe(false);
        expect(s.isInPreview('tracks')).toBe(false);
        expect(s.previewIds()).toEqual([]);
    });

    it('on() returns an unsubscribe', () => {
        const seen: string[] = [];
        const off = s.on('dataChanged', id => seen.push(id));
        s.setElements('tracks', [el(1)]);
        off();
        s.setElements('streets', [el(2)]);
        expect(seen).toEqual(['tracks']);
    });
});
