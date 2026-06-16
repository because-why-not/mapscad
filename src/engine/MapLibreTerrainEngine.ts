import 'maplibre-gl/dist/maplibre-gl.css';
import type { ManifestMap } from '../TileMapManifest';
import type { CustomMapSpec } from '../customMaps';
import type { GeoView, MapEngine } from './MapEngine';

// MapLibre's camera zoom (512px tiles) sits ~1 below XYZ/OL zoom (256px tiles), so
// translate when crossing the engine boundary to keep the view continuous.
const toMlZoom = (z: number) => z - 1;
const toGeoZoom = (z: number) => z + 1;

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
        if (this.map) this.map.setStyle(buildTerrainStyle(spec, this.mapsById));
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
        const style = spec ? buildTerrainStyle(spec, this.mapsById) : { version: 8, sources: {}, layers: [] };
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
 * Build a MapLibre GL StyleSpecification (a plain object) that drapes the imagery
 * raster over terrain from the terrarium-encoded DEM. Returned loosely-typed so the
 * abstraction above carries no compile-time dependency on maplibre's style types.
 */
function buildTerrainStyle(spec: CustomMapSpec, mapsById: Record<string, ManifestMap>): any {
    const imagery = mapsById[spec.imagerySource];
    const dem = mapsById[spec.demSource];
    return {
        version: 8,
        sources: {
            imagery: {
                type: 'raster',
                tiles: [imagery.tiles[0]],
                tileSize: imagery.mmapsrv.tileSize ?? 256,
                minzoom: imagery.minzoom,
                maxzoom: imagery.maxzoom,
                attribution: imagery.attribution,
            },
            dem: {
                type: 'raster-dem',
                tiles: [dem.tiles[0]],
                tileSize: dem.mmapsrv.tileSize ?? 256,
                minzoom: dem.minzoom,
                maxzoom: dem.maxzoom,
                encoding: 'terrarium',
            },
        },
        layers: [
            { id: 'bg', type: 'background', paint: { 'background-color': '#0b1021' } },
            { id: 'imagery', type: 'raster', source: 'imagery' },
        ],
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
