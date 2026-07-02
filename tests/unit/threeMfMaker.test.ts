// Structural coverage for the hand-rolled 3MF (zip) writer: it groups bodies by `kind` into one
// named, coloured <object> each, and emits a valid store-only OPC archive. We don't inflate (store =
// literal bytes), so filenames and the model XML appear verbatim and can be sliced out and parsed.
import { describe, it, expect } from 'vitest';
import { threeMfArchive } from '../../src/ThreeMFMaker';
import type { ModelBody } from '../../src/MapModel';

// A minimal 1-triangle body of a given kind.
function tri(kind: string): ModelBody {
    return {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        ix0: 0, iy0: 0, kind,
    };
}

// Pull the "3D/3dmodel.model" part back out of the store archive (its bytes are stored uncompressed).
function modelXml(archive: Uint8Array): string {
    const text = new TextDecoder().decode(archive);
    const start = text.indexOf('<?xml', text.indexOf('3D/3dmodel.model'));
    const end = text.indexOf('</model>', start) + '</model>'.length;
    return text.slice(start, end);
}

describe('threeMfArchive', () => {
    it('emits a zip (PK signature) containing the three OPC parts', () => {
        const archive = threeMfArchive([tri('terrain')]);
        expect(archive[0]).toBe(0x50); // 'P'
        expect(archive[1]).toBe(0x4b); // 'K'
        const text = new TextDecoder().decode(archive);
        expect(text).toContain('[Content_Types].xml');
        expect(text).toContain('_rels/.rels');
        expect(text).toContain('3D/3dmodel.model');
        // End-of-central-directory record present.
        expect(text).toContain('PK\x05\x06');
    });

    it('groups tiles by kind into one named, coloured object each', () => {
        const archive = threeMfArchive([tri('terrain'), tri('buildings'), tri('buildings'), tri('streets')]);
        const xml = modelXml(archive);
        // 3 kinds → 3 objects, 3 base materials, 3 build items.
        expect(xml.match(/<object /g)?.length).toBe(3);
        expect(xml.match(/<base /g)?.length).toBe(3);
        expect(xml.match(/<item /g)?.length).toBe(3);
        // "buildings" appears once as an object (its two tiles merged), with the registry stroke colour.
        expect(xml.match(/<object [^>]*name="buildings"/g)?.length).toBe(1);
        expect(xml).toContain('#1F77B4FF'); // buildings strokeColor '#1f77b4'
    });

    it('merges a kind\'s tiles into one mesh, offsetting the second tile\'s indices', () => {
        const archive = threeMfArchive([tri('buildings'), tri('buildings')]);
        const xml = modelXml(archive);
        const obj = xml.slice(xml.indexOf('<object '), xml.indexOf('</object>'));
        expect(obj.match(/<vertex /g)?.length).toBe(6);   // 2 tris × 3 verts
        expect(obj.match(/<triangle /g)?.length).toBe(2);
        expect(obj).toContain('v1="3"'); // second triangle's indices offset by the first tile's 3 verts
    });
});
