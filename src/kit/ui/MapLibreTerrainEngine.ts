import 'maplibre-gl/dist/maplibre-gl.css';
import type { ManifestMap } from '../maptiles/TileMapManifest';
import type { CustomMapSpec } from '../config/customMaps';
import type { GeoView, MapEngine } from './MapEngine';

// MapLibre's camera zoom (512px tiles) sits ~1 below XYZ/OL zoom (256px tiles), so
// translate when crossing the engine boundary to keep the view continuous.
const toMlZoom = (z: number) => z - 1;
const toGeoZoom = (z: number) => z + 1;

// Allow requesting DEM tiles a few zooms below the server's lowest stored level: the
// server can downsample further on demand (just increasingly inefficiently), and it
// lets terrain stay 3D when zoomed out a bit rather than flattening abruptly.
const DEM_UNDERZOOM = 3;

interface Light { azimuth: number; altitude: number; }

// Fixed illumination for the 3D hillshade — top-left at 45°, the usual cartographic
// convention. (There are no time-of-day controls; the light is a constant.)
const DEFAULT_LIGHT: Light = { azimuth: 315, altitude: 45 };

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
        if (this.map) this.map.setStyle(buildTerrainStyle(spec, this.mapsById, DEFAULT_LIGHT));
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
        const style = spec ? buildTerrainStyle(spec, this.mapsById, DEFAULT_LIGHT) : { version: 8, sources: {}, layers: [] };
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
        this.map = map;
    }

    private applyView(view: GeoView): void {
        this.map.jumpTo({ center: [view.lng, view.lat], zoom: toMlZoom(view.zoom) });
    }
}

/**
 * Build a MapLibre GL StyleSpecification (a plain object) for a 3D terrain map. The
 * terrarium-encoded DEM always drives the terrain; the surface painted on top is
 * either a draped raster (e.g. aerial imagery) or a computed hillshade derived from
 * the DEM itself. Returned loosely-typed so the abstraction above carries no
 * compile-time dependency on maplibre's style types.
 */
function buildTerrainStyle(spec: CustomMapSpec, mapsById: Record<string, ManifestMap>, light: Light): any {
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
    // Land base under the hillshade (flat ground shows this, since the hillshade layer
    // only paints slopes); imagery maps just use a dark void behind the raster.
    const baseColor = spec.surface.type === 'hillshade' ? terrainBaseColor(light) : '#0b1021';
    const layers: any[] = [
        { id: 'bg', type: 'background', paint: { 'background-color': baseColor } },
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
            paint: hillshadePaint(light),
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

// How much of full daylight we have: 0 at/below the horizon, 1 once the light is high.
function daylightFactor(altitudeDeg: number): number {
    return Math.max(0, Math.min(1, altitudeDeg / 25));
}

/**
 * Land base colour the relief sits on, from the light's altitude (the hillshade layer
 * alone only shades slopes, leaving flat ground showing this colour). With the fixed
 * daytime light this resolves to the daylit tan.
 */
function terrainBaseColor(light: Light): string {
    const day = daylightFactor(light.altitude);
    return lerpHex('#141823', '#c9c3b2', day); // night blue-grey -> daylit tan
}

/**
 * Hillshade paint derived from the light. MapLibre's hillshade layer only takes an
 * illumination azimuth (not an altitude), so we use the altitude to modulate the
 * relief strength: a lower light yields stronger relief.
 */
function hillshadePaint(light: Light): Record<string, any> {
    const day = daylightFactor(light.altitude);
    const exaggeration = 0.45 + (1 - day) * 0.35;   // 0.45 (high light) .. 0.8 (low light)
    return {
        'hillshade-exaggeration': exaggeration,
        'hillshade-shadow-color': '#23252e',
        'hillshade-highlight-color': '#ffffff',
        'hillshade-accent-color': '#6b7280',
        'hillshade-illumination-direction': Math.round(light.azimuth),
        // Anchor the light to the map (north), not the viewport, so rotating the
        // camera doesn't swing the shading around.
        'hillshade-illumination-anchor': 'map',
    };
}

/** Linear interpolate between two #rrggbb colours. */
function lerpHex(a: string, b: string, t: number): string {
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const mix = (sh: number) => {
        const ca = (pa >> sh) & 0xff;
        const cb = (pb >> sh) & 0xff;
        return Math.round(ca + (cb - ca) * t) & 0xff;
    };
    const r = mix(16), g = mix(8), bl = mix(0);
    return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}
