import 'maplibre-gl/dist/maplibre-gl.css';
import type { ManifestMap } from '../TileMapManifest';
import type { CustomMapSpec } from '../customMaps';
import type { GeoView, MapEngine } from './MapEngine';

// MapLibre's camera zoom (512px tiles) sits ~1 below XYZ/OL zoom (256px tiles), so
// translate when crossing the engine boundary to keep the view continuous.
const toMlZoom = (z: number) => z - 1;
const toGeoZoom = (z: number) => z + 1;

// Allow requesting DEM tiles a few zooms below the server's lowest stored level: the
// server can downsample further on demand (just increasingly inefficiently), and it
// lets terrain stay 3D when zoomed out a bit rather than flattening abruptly.
const DEM_UNDERZOOM = 3;

interface SunDirection { azimuth: number; altitude: number; }

/**
 * 3D renderer: drapes a raster imagery source over terrain derived from a
 * terrarium-encoded DEM. The heavy maplibre-gl library is dynamically imported on
 * first mount so it only enters the bundle's load path when a custom map is used.
 */
export class MapLibreTerrainEngine implements MapEngine {
    readonly sourceIds: string[];
    private el!: HTMLDivElement;
    private gl: any = null;          // maplibre-gl module default export (lazy)
    private map: any = null;
    private moveCb: (() => void) | null = null;
    private activeId = '';
    private specById = new Map<string, CustomMapSpec>();
    private sun: SunDirection = { azimuth: 315, altitude: 45 };

    constructor(specs: CustomMapSpec[], private mapsById: Record<string, ManifestMap>) {
        this.sourceIds = specs.map(s => s.id);
        for (const s of specs) this.specById.set(s.id, s);
        this.activeId = specs[0]?.id ?? '';
    }

    async mount(parent: HTMLElement, _view: GeoView): Promise<void> {
        const el = document.createElement('div');
        el.className = 'map-surface';
        el.style.display = 'none';
        parent.appendChild(el);
        this.el = el;
        const mod = await import('maplibre-gl');
        this.gl = mod.default;
    }

    setActiveSource(id: string): void {
        const spec = this.specById.get(id);
        if (!spec) return;
        this.activeId = id;
        if (this.map) this.map.setStyle(buildTerrainStyle(spec, this.mapsById, this.sun));
    }

    setSun(azimuthDeg: number, altitudeDeg: number): void {
        this.sun = { azimuth: azimuthDeg, altitude: altitudeDeg };
        this.applySunToMap();
    }

    show(view: GeoView): void {
        this.el.style.display = 'block';
        if (!this.map) {
            this.create(view);
        } else {
            this.applyView(view);
            this.map.resize();
        }
    }

    hide(): void {
        this.el.style.display = 'none';
    }

    getView(): GeoView {
        if (!this.map) return { lng: 0, lat: 0, zoom: 0 };
        const c = this.map.getCenter();
        return { lng: c.lng, lat: c.lat, zoom: toGeoZoom(this.map.getZoom()) };
    }

    onViewChange(cb: () => void): void {
        this.moveCb = cb;
        if (this.map) this.map.on('moveend', cb);
    }

    private create(view: GeoView): void {
        const spec = this.specById.get(this.activeId);
        const style = spec ? buildTerrainStyle(spec, this.mapsById, this.sun) : { version: 8, sources: {}, layers: [] };
        const map = new this.gl.Map({
            container: this.el,
            style,
            center: [view.lng, view.lat],
            zoom: toMlZoom(view.zoom),
            pitch: 60,
            maxPitch: 85,
            attributionControl: { compact: true },
        });
        const nav = new this.gl.NavigationControl({ visualizePitch: true });
        map.addControl(nav, 'bottom-left');
        if (this.moveCb) map.on('moveend', this.moveCb);
        // Re-apply the current sun whenever a style (re)loads, e.g. after setStyle.
        map.on('style.load', () => this.applySunToMap());
        this.map = map;
    }

    private applyView(view: GeoView): void {
        this.map.jumpTo({ center: [view.lng, view.lat], zoom: toMlZoom(view.zoom) });
    }

    /** Push the current sun direction onto the live hillshade layer, if present. */
    private applySunToMap(): void {
        const map = this.map;
        if (!map) return;
        try {
            if (!map.getLayer || !map.getLayer('hillshade')) return;
            const paint = hillshadePaint(this.sun);
            for (const key of Object.keys(paint)) map.setPaintProperty('hillshade', key, paint[key]);
        } catch {
            // style not ready yet — the style.load handler will re-apply.
        }
    }
}

/**
 * Build a MapLibre GL StyleSpecification (a plain object) for a 3D terrain map. The
 * terrarium-encoded DEM always drives the terrain; the surface painted on top is
 * either a draped raster (e.g. aerial imagery) or a computed hillshade derived from
 * the DEM itself. Returned loosely-typed so the abstraction above carries no
 * compile-time dependency on maplibre's style types.
 */
function buildTerrainStyle(spec: CustomMapSpec, mapsById: Record<string, ManifestMap>, sun: SunDirection): any {
    const dem = mapsById[spec.demSource];
    const sources: Record<string, any> = {
        dem: {
            type: 'raster-dem',
            tiles: [dem.tiles[0]],
            tileSize: dem.mmapsrv.tileSize ?? 256,
            // Respect the server's lowest stored zoom (requesting below it 404s), but
            // permit a few extra under-zoom levels that the server downsamples on demand.
            minzoom: Math.max(dem.minzoom, (dem.mmapsrv.minStoredZoom ?? dem.minzoom) - DEM_UNDERZOOM),
            maxzoom: dem.maxzoom,
            encoding: 'terrarium',
            attribution: dem.attribution,
        },
    };
    const layers: any[] = [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0b1021' } },
    ];

    if (spec.surface.type === 'imagery') {
        const imagery = mapsById[spec.surface.source];
        sources.imagery = {
            type: 'raster',
            tiles: [imagery.tiles[0]],
            tileSize: imagery.mmapsrv.tileSize ?? 256,
            minzoom: imagery.minzoom,
            maxzoom: imagery.maxzoom,
            attribution: imagery.attribution,
        };
        layers.push({ id: 'imagery', type: 'raster', source: 'imagery' });
    } else {
        // Shaded relief computed straight from the DEM — no separate tileset needed.
        layers.push({
            id: 'hillshade',
            type: 'hillshade',
            source: 'dem',
            paint: hillshadePaint(sun),
        });
    }

    return {
        version: 8,
        sources,
        layers,
        terrain: { source: 'dem', exaggeration: spec.exaggeration },
        sky: {
            'sky-color': '#9ec9ff',
            'horizon-color': '#cfe3ff',
            'fog-color': '#ffffff',
            'sky-horizon-blend': 0.5,
            'horizon-fog-blend': 0.5,
            'fog-ground-blend': 0.5,
        },
    };
}

/**
 * Hillshade paint derived from the sun direction. MapLibre's hillshade layer only
 * takes an illumination azimuth (not an altitude), so we additionally use the sun's
 * altitude to modulate the relief: a low sun yields long, strong shadows, and once
 * the sun is below the horizon the surface goes dark and flat (night).
 */
function hillshadePaint(sun: SunDirection): Record<string, any> {
    // 0 at/below the horizon, 1 once the sun is ≥ 45° up.
    const daylight = Math.max(0, Math.min(1, sun.altitude / 45));
    const exaggeration = 0.4 + (1 - daylight) * 0.5;            // 0.4 (high sun) .. 0.9 (low sun)
    const highlight = sun.altitude <= 0 ? '#3a4660' : '#ffffff'; // dim the lit side at night
    return {
        'hillshade-exaggeration': exaggeration,
        'hillshade-shadow-color': '#1b2230',
        'hillshade-highlight-color': highlight,
        'hillshade-accent-color': '#3a4a5a',
        'hillshade-illumination-direction': Math.round(sun.azimuth),
        // Anchor the light to the map (north), not the viewport, so rotating the
        // camera doesn't swing the shading around.
        'hillshade-illumination-anchor': 'map',
    };
}
