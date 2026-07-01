import type { MapModel, ModelTile } from './MapModel';
import { osmFeature } from './osm/osmFeatures';

/**
 * Serialises a MapModel's neutral geometry to a 3MF file. Unlike the single STL (where a slicer's
 * "split to objects" would explode into one object per connected volume — every house separate), 3MF
 * carries EXPLICIT grouping: every body is grouped by its `kind` (terrain, or an OSM feature id) into
 * ONE named, coloured `<object>`. So "buildings" is a single object holding all its disconnected
 * houses — one colour to assign, not hundreds. Colours come from the feature registry's stroke colour
 * (terrain gets a neutral grey), baked in as a base material so modern slicers show them on import.
 *
 * 3MF is an OPC (zip) package. There's no zip dependency in the app, so this writes a minimal
 * store-only (uncompressed) archive inline — enough for the three fixed package parts.
 */

const TERRAIN_COLOR = '#B0B0B0';

export function exportModel3mf(model: MapModel, baseName = 'mapscad'): void {
    const geo = model.buildGeometry();
    if (!geo || geo.tiles.length === 0) return;
    const blob = new Blob([threeMfArchive(geo.tiles) as BlobPart], { type: 'model/3mf' });
    download(blob, `${baseName}.3mf`);
}

/** Pure: build the 3MF (zip) bytes from the model tiles. Bodies are grouped by `kind` into one named,
 *  coloured `<object>` each. No DOM — separated from `exportModel3mf` so it's unit-testable. */
export function threeMfArchive(tiles: ModelTile[]): Uint8Array {
    // Group bodies by kind, preserving first-seen order (terrain first, then features as built).
    const groups = new Map<string, ModelTile[]>();
    for (const tile of tiles) {
        const kind = tile.kind ?? 'part';
        const list = groups.get(kind);
        if (list) list.push(tile); else groups.set(kind, [tile]);
    }
    const files: ZipEntry[] = [
        { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES) },
        { name: '_rels/.rels', data: utf8(RELS) },
        { name: '3D/3dmodel.model', data: utf8(buildModelXml(groups)) },
    ];
    return zipStore(files);
}

/** A colour for a body group: OSM features use their registry stroke colour, terrain a neutral grey. */
function colorForKind(kind: string): string {
    if (kind === 'terrain' || kind === 'part') return TERRAIN_COLOR;
    try { return osmFeature(kind).strokeColor; } catch { return TERRAIN_COLOR; }
}

/** `#rrggbb` (or an `rgb()/rgba()` string) → 3MF `#RRGGBBFF` display colour. Falls back to grey. */
function displayColor(css: string): string {
    const hex = css.match(/^#([0-9a-fA-F]{6})$/);
    if (hex) return `#${hex[1].toUpperCase()}FF`;
    const rgb = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgb) {
        const h = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0').toUpperCase();
        return `#${h(rgb[1])}${h(rgb[2])}${h(rgb[3])}FF`;
    }
    return `#${TERRAIN_COLOR.slice(1).toUpperCase()}FF`;
}

function buildModelXml(groups: Map<string, ModelTile[]>): string {
    const kinds = [...groups.keys()];
    // One base material per group; objects reference it by index for their colour.
    const bases = kinds
        .map(k => `   <base name="${xml(k)}" displaycolor="${displayColor(colorForKind(k))}"/>`)
        .join('\n');

    const objects: string[] = [];
    const items: string[] = [];
    let objectId = 2; // 1 is the basematerials resource
    kinds.forEach((kind, i) => {
        objects.push(objectMesh(objectId, kind, i, groups.get(kind)!));
        items.push(`  <item objectid="${objectId}"/>`);
        objectId++;
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <basematerials id="1">
${bases}
  </basematerials>
${objects.join('\n')}
 </resources>
 <build>
${items.join('\n')}
 </build>
</model>
`;
}

/** One `<object>` whose mesh concatenates all tiles of a kind (their disconnected volumes stay one
 *  object), coloured via the shared basematerials resource (pid=1, pindex=materialIndex). */
function objectMesh(objectId: number, kind: string, materialIndex: number, tiles: ModelTile[]): string {
    const verts: string[] = [];
    const tris: string[] = [];
    let base = 0; // running vertex offset so each tile's indices stay local to the merged mesh
    for (const { positions, indices } of tiles) {
        for (let i = 0; i < positions.length; i += 3) {
            verts.push(`    <vertex x="${fmt(positions[i])}" y="${fmt(positions[i + 1])}" z="${fmt(positions[i + 2])}"/>`);
        }
        for (let t = 0; t < indices.length; t += 3) {
            tris.push(`    <triangle v1="${base + indices[t]}" v2="${base + indices[t + 1]}" v3="${base + indices[t + 2]}"/>`);
        }
        base += positions.length / 3;
    }
    return `  <object id="${objectId}" name="${xml(kind)}" type="model" pid="1" pindex="${materialIndex}">
   <mesh>
    <vertices>
${verts.join('\n')}
    </vertices>
    <triangles>
${tris.join('\n')}
    </triangles>
   </mesh>
  </object>`;
}

// Compact float: integers stay bare, others trimmed to 4 dp (sub-micron at metre scale).
function fmt(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/\.?0+$/, '');
}

function xml(s: string): string {
    return s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

// --- minimal store-only zip (OPC container for the 3MF) ------------------------------------------

interface ZipEntry { name: string; data: Uint8Array; }

function utf8(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

/** Build an uncompressed (store) zip from the entries. Local headers + central directory + EOCD,
 *  per the .ZIP spec; enough for OPC readers (3MF slicers). */
function zipStore(entries: ZipEntry[]): Uint8Array {
    const chunks: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;

    for (const e of entries) {
        const name = utf8(e.name);
        const crc = crc32(e.data);
        const size = e.data.length;

        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true); // local file header signature
        lv.setUint16(4, 20, true);         // version needed
        lv.setUint16(6, 0, true);          // flags
        lv.setUint16(8, 0, true);          // method 0 = store
        lv.setUint16(10, 0, true);         // mod time
        lv.setUint16(12, 0x21, true);      // mod date (1980-01-01)
        lv.setUint32(14, crc, true);
        lv.setUint32(18, size, true);      // compressed size
        lv.setUint32(22, size, true);      // uncompressed size
        lv.setUint16(26, name.length, true);
        lv.setUint16(28, 0, true);         // extra length
        local.set(name, 30);
        chunks.push(local, e.data);

        const cd = new Uint8Array(46 + name.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true); // central dir header signature
        cv.setUint16(4, 20, true);         // version made by
        cv.setUint16(6, 20, true);         // version needed
        cv.setUint16(8, 0, true);
        cv.setUint16(10, 0, true);         // method
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0x21, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, name.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);    // local header offset
        cd.set(name, 46);
        central.push(cd);

        offset += local.length + size;
    }

    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);        // EOCD signature
    ev.setUint16(8, entries.length, true);    // entries on this disk
    ev.setUint16(10, entries.length, true);   // total entries
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);           // central dir offset

    return concat([...chunks, ...central, eocd]);
}

function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(data: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
