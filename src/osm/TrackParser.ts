import type { LonLat } from '../mathHelper';

/**
 * Parses GPS track files (GPX, TCX) into the same `{ name?, coords }` shape the Load flow already
 * ingests for OSM ways: `waysFromJson`'s array branch assigns synthetic negative ids and keeps the
 * name, so a parsed track drops into the pipeline exactly like a saved feature file — no changes to
 * `onLoadJson`.
 *
 * Both formats are XML, and we need only a tiny slice of them (lon/lat polylines + a name), so this
 * uses the browser-native `DOMParser` rather than a dependency. Elevation, timestamps and extensions
 * are intentionally discarded. Namespace prefixes are ignored via `localName`, so GPX 1.0/1.1 and
 * TCX (with or without a default namespace) all parse the same way.
 *
 *   - GPX: each `<trkseg>` (a track can have several) and each `<rte>` becomes one polyline. `<wpt>`
 *     waypoints are single points, so they're skipped (they can't form a line).
 *   - TCX: each `<Track>` (under an Activity or a Course) becomes one polyline; trackpoints without a
 *     `<Position>` (e.g. indoor/paused samples) are skipped.
 */

/** A parsed track: an optional name plus its `[lon, lat]` polyline. Structurally an id-less
 *  `OsmElement`, which is exactly what `waysFromJson` accepts. */
export interface ParsedTrack {
    name?: string;
    coords: LonLat[];
}

/** True for a filename this parser handles (case-insensitive extension check). */
export function isTrackFile(filename: string): boolean {
    const lower = filename.toLowerCase();
    return lower.endsWith('.gpx') || lower.endsWith('.tcx');
}

/** Parse a GPX or TCX file's text into tracks. Format is taken from the extension, falling back to
 *  the XML root element. Throws on invalid XML or an unrecognised format. */
export function parseTrackFile(text: string, filename: string): ParsedTrack[] {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    // A parse failure yields a document containing a <parsererror> element rather than throwing.
    if (doc.getElementsByTagName('parsererror').length > 0) {
        throw new Error('File is not valid XML');
    }

    const lower = filename.toLowerCase();
    const root = doc.documentElement?.localName?.toLowerCase();
    if (lower.endsWith('.gpx') || root === 'gpx') return parseGpx(doc);
    if (lower.endsWith('.tcx') || root === 'trainingcenterdatabase') return parseTcx(doc);
    throw new Error('Unsupported track format (expected GPX or TCX)');
}

/** First direct-child element with the given local name, its trimmed text (or undefined). */
function childText(parent: Element, tag: string): string | undefined {
    for (const child of Array.from(parent.children)) {
        if (child.localName === tag) return child.textContent?.trim() || undefined;
    }
    return undefined;
}

/** Collect `[lon, lat]` points from elements carrying `lat`/`lon` attributes (GPX trkpt/rtept). */
function pointsFromAttrs(nodes: HTMLCollectionOf<Element>): LonLat[] {
    const out: LonLat[] = [];
    for (const node of Array.from(nodes)) {
        const lat = parseFloat(node.getAttribute('lat') ?? '');
        const lon = parseFloat(node.getAttribute('lon') ?? '');
        if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lon, lat]);
    }
    return out;
}

function parseGpx(doc: Document): ParsedTrack[] {
    const out: ParsedTrack[] = [];
    for (const trk of Array.from(doc.getElementsByTagName('trk'))) {
        const name = childText(trk, 'name');
        for (const seg of Array.from(trk.getElementsByTagName('trkseg'))) {
            const coords = pointsFromAttrs(seg.getElementsByTagName('trkpt'));
            if (coords.length) out.push({ name, coords });
        }
    }
    for (const rte of Array.from(doc.getElementsByTagName('rte'))) {
        const coords = pointsFromAttrs(rte.getElementsByTagName('rtept'));
        if (coords.length) out.push({ name: childText(rte, 'name'), coords });
    }
    return out;
}

function parseTcx(doc: Document): ParsedTrack[] {
    const out: ParsedTrack[] = [];
    // A Course carries a <Name>; an Activity carries an <Id> (usually a timestamp) — use whichever is
    // present as the track name. Each nested <Track> is one polyline.
    const containers = [
        ...Array.from(doc.getElementsByTagName('Course')),
        ...Array.from(doc.getElementsByTagName('Activity')),
    ];
    for (const container of containers) {
        const name = childText(container, 'Name') ?? childText(container, 'Id');
        for (const track of Array.from(container.getElementsByTagName('Track'))) {
            const coords: LonLat[] = [];
            for (const tp of Array.from(track.getElementsByTagName('Trackpoint'))) {
                const pos = tp.getElementsByTagName('Position')[0];
                if (!pos) continue;
                const lat = parseFloat(childText(pos, 'LatitudeDegrees') ?? '');
                const lon = parseFloat(childText(pos, 'LongitudeDegrees') ?? '');
                if (Number.isFinite(lat) && Number.isFinite(lon)) coords.push([lon, lat]);
            }
            if (coords.length) out.push({ name, coords });
        }
    }
    return out;
}
