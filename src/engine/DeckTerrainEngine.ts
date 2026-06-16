import type { ManifestMap } from '../TileMapManifest';
import type { CustomMapSpec } from '../customMaps';
import type { GeoView, MapEngine } from './MapEngine';

// deck.gl's MapView zoom (512px tiles) sits ~1 below XYZ/OL zoom (256px tiles).
const toDeckZoom = (z: number) => z - 1;
const toGeoZoom = (z: number) => z + 1;

// Permit a few under-zoom levels below the server's lowest stored DEM zoom (server
// downsamples on demand) so terrain still renders when zoomed out a little.
const DEM_UNDERZOOM = 3;

// Balanced mesh density: max geometric error per tile (metres). Lower => more
// triangles / finer landform but heavier. deck's default is 4.0; unlike MapLibre's
// fixed terrain mesh this is genuinely tunable.
const MESH_MAX_ERROR = 4;

// Neutral land tone the shaded relief sits on; the sun lighting + shadows do the rest.
const TERRAIN_COLOR = [201, 196, 182];

interface SunDirection { azimuth: number; altitude: number; }

/**
 * High-detail 3D terrain renderer (deck.gl). Builds an adjustable-resolution mesh from
 * the terrarium DEM and lights it with a directional sun light that casts real shadows.
 * The heavy deck.gl library is dynamically imported on first mount, so it only enters
 * the load path when this map is actually used.
 */
export class DeckTerrainEngine implements MapEngine {
    readonly sourceIds: string[];
    private el!: HTMLDivElement;
    private dk: any = null;          // deck.gl module namespace (lazy)
    private deck: any = null;
    private moveCb: (() => void) | null = null;
    private activeId = '';
    private specById = new Map<string, CustomMapSpec>();
    private sun: SunDirection = { azimuth: 315, altitude: 45 };
    private shadows = true;
    private viewState: any = { longitude: 0, latitude: 0, zoom: 10, pitch: 60, bearing: 0 };

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
        // Scoped packages only (avoids pulling deck.gl's React/Carto bundles).
        const [core, geo] = await Promise.all([
            import('@deck.gl/core'),
            import('@deck.gl/geo-layers'),
        ]);
        this.dk = { ...core, ...geo };
    }

    setActiveSource(id: string): void {
        if (!this.specById.has(id)) return;
        this.activeId = id;
        if (this.deck) this.deck.setProps({ layers: this.buildLayers() });
    }

    setSun(azimuthDeg: number, altitudeDeg: number): void {
        this.sun = { azimuth: azimuthDeg, altitude: altitudeDeg };
        if (this.deck) this.deck.setProps({ effects: this.buildEffects() });
    }

    setShadows(enabled: boolean): void {
        this.shadows = enabled;
        if (this.deck) this.deck.setProps({ effects: this.buildEffects() });
    }

    show(view: GeoView): void {
        this.el.style.display = 'block';
        this.viewState = { ...this.viewState, longitude: view.lng, latitude: view.lat, zoom: toDeckZoom(view.zoom) };
        if (!this.deck) {
            this.create();
        } else {
            this.deck.setProps({ viewState: this.viewState });
        }
    }

    hide(): void {
        this.el.style.display = 'none';
    }

    getView(): GeoView {
        const v = this.viewState;
        return { lng: v.longitude, lat: v.latitude, zoom: toGeoZoom(v.zoom) };
    }

    onViewChange(cb: () => void): void {
        this.moveCb = cb;
    }

    private create(): void {
        const { Deck, MapView } = this.dk;
        const deck = new Deck({
            parent: this.el,
            views: new MapView({ repeat: false }),
            viewState: this.viewState,
            controller: { maxPitch: 85 },
            effects: this.buildEffects(),
            layers: this.buildLayers(),
            onViewStateChange: ({ viewState }: any) => {
                this.viewState = viewState;
                deck.setProps({ viewState });
                this.moveCb?.();
            },
        });
        this.deck = deck;
    }

    private buildLayers(): any[] {
        const spec = this.specById.get(this.activeId);
        if (!spec) return [];
        const dem = this.mapsById[spec.demSource];
        const { TerrainLayer } = this.dk;
        const k = spec.exaggeration;
        const minZoom = Math.max(dem.minzoom, (dem.mmapsrv.minStoredZoom ?? dem.minzoom) - DEM_UNDERZOOM);
        const terrain = new TerrainLayer({
            id: `terrain-${spec.id}`,
            elevationData: dem.tiles[0],                 // template with {z}/{x}/{y}; deck tiles it
            // Terrarium decode, scaled by the spec's vertical exaggeration.
            elevationDecoder: { rScaler: 256 * k, gScaler: 1 * k, bScaler: (1 / 256) * k, offset: -32768 * k },
            color: TERRAIN_COLOR,
            meshMaxError: MESH_MAX_ERROR,
            tileSize: dem.mmapsrv.tileSize ?? 256,
            minZoom,
            maxZoom: dem.maxzoom,
            material: { ambient: 0.5, diffuse: 0.8, shininess: 32, specularColor: [40, 40, 40] },
        });
        return [terrain];
    }

    private buildEffects(): any[] {
        // Shadows off => empty effects, so deck.gl applies its own default lighting
        // (a known-good, bright two-light setup). This isolates the base terrain from
        // our custom sun lighting for verification.
        return this.shadows ? [this.buildLighting()] : [];
    }

    private buildLighting(): any {
        const { LightingEffect, AmbientLight, DirectionalLight } = this.dk;
        // Never let the light come from below the horizon (would light the underside);
        // at true night this reads as low dusk light rather than going black.
        const effAltitude = Math.max(this.sun.altitude, MIN_LIGHT_ALTITUDE);
        // Bright ambient (matching deck's default) so shadowed slopes stay readable —
        // the cast shadow removes the sun's contribution, ambient is what's left.
        const ambientLight = new AmbientLight({ color: [255, 255, 255], intensity: 1.2 });
        const sunLight = new DirectionalLight({
            color: [255, 250, 240],
            intensity: 1.0,
            direction: sunToDirection(this.sun.azimuth, effAltitude),
            _shadow: this.shadows,
        });
        return new LightingEffect({ ambientLight, sunLight });
    }
}

// Lowest angle (deg) we let the lighting sun sit at, so landform stays readable at night.
const MIN_LIGHT_ALTITUDE = 8;

/** Unit vector the sunlight travels along (from the sun toward the ground). */
function sunToDirection(azimuthDeg: number, altitudeDeg: number): [number, number, number] {
    const altR = altitudeDeg * Math.PI / 180;
    const azR = azimuthDeg * Math.PI / 180;
    const east = Math.cos(altR) * Math.sin(azR);
    const north = Math.cos(altR) * Math.cos(azR);
    const up = Math.sin(altR);
    return [-east, -north, -up];
}
