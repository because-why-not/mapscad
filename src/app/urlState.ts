import { Env } from '../Env';
import { SelectionShape } from '../kit/MapModel';
import type { GeoView } from '../kit/ui/MapEngine';
import type { LonLat } from '../kit/common/mathHelper';

// The URL hash carries only human-readable state: the map (name + lat/lng/zoom) always, and the
// selected area (corner lon/lats + shape) once one exists, e.g.
//   #map=north_island_hillshade_8m&lat=-41.27&lng=174.78&z=8.4
//   …&shape=oval&sel=174.7,-41.2;174.9,-41.2;174.9,-41.4;174.7,-41.4   (after a selection)
// The rest of the export config (DEM, model settings) is NOT shared — it lives in localStorage.
// These are the pure parse/format + localStorage helpers; the live debounced address-bar sync
// (which needs the controller + config) stays with the renderer.

export const DEFAULT_VIEW: GeoView = { lng: 174.82131, lat: -41.14554, zoom: 6 };

/** Parse the human-readable state from the URL hash (map, view, selected area), if present. */
export function readUrlMapState(): { map?: string; view?: GeoView; selection?: LonLat[]; shape?: SelectionShape } {
    try {
        const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const lat = parseFloat(params.get('lat') ?? '');
        const lng = parseFloat(params.get('lng') ?? '');
        const zoom = parseFloat(params.get('z') ?? '');
        const view = [lat, lng, zoom].every(Number.isFinite) ? { lat, lng, zoom } : undefined;
        const shape = params.get('shape') === SelectionShape.Oval ? SelectionShape.Oval
            : params.get('shape') === SelectionShape.Rectangle ? SelectionShape.Rectangle : undefined;
        return { map: params.get('map') || undefined, view, selection: parseSelection(params.get('sel')), shape };
    } catch (e) { Env.error('read url map state', e); return {}; }
}

/** `lon,lat;lon,lat;lon,lat;lon,lat` -> four [lon,lat] corners, or undefined if malformed. */
function parseSelection(s: string | null): LonLat[] | undefined {
    if (!s) return undefined;
    const corners = s.split(';').map(pair => pair.split(',').map(Number) as LonLat);
    if (corners.length !== 4 || corners.some(c => c.length !== 2 || !c.every(Number.isFinite))) return undefined;
    return corners;
}

/** Compose the full hash URL from the live map view + selection: readable map state, plus the
 *  selected area (corners + shape) when one exists. */
export function composeShareUrl(view: GeoView | undefined, activeId: string | undefined, selection: LonLat[] | null, shape: SelectionShape): string {
    const v = view ?? DEFAULT_VIEW;
    const params: string[] = [];
    if (activeId) params.push(`map=${encodeURIComponent(activeId)}`);
    params.push(`lat=${v.lat.toFixed(5)}`, `lng=${v.lng.toFixed(5)}`, `z=${v.zoom.toFixed(2)}`);
    if (selection) {
        params.push(`shape=${shape}`);
        params.push(`sel=${selection.map(c => `${c[0].toFixed(5)},${c[1].toFixed(5)}`).join(';')}`);
    }
    const url = new URL(window.location.href);
    url.hash = params.join('&');
    return url.toString();
}

// --- last-used map view / active source (localStorage, not shared in the URL) ---

export function loadView(): GeoView {
    try {
        const s = localStorage.getItem('mapView');
        if (s) return JSON.parse(s);
    } catch (e) { Env.error('load mapView', e); }
    return DEFAULT_VIEW;
}

export function saveView(v: GeoView): void {
    try { localStorage.setItem('mapView', JSON.stringify(v)); } catch (e) { Env.error('save mapView', e); }
}

export function saveActive(id: string): void {
    try { localStorage.setItem('activeProvider', id); } catch (e) { Env.error('save activeProvider', e); }
}
