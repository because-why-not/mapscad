import type { HeightGrid } from './HeightSampler';
import { OsmCanvasProcessor } from './model/OsmCanvasProcessor';
import { addCoverageRaise } from './model/rasterRaise';
import { buildModelGeometry, type BuildInput, type OsmBody } from './model/buildGeometry';
import type { OsmVectorData } from './osm/OsmVectorData';
import { OSM_FEATURES } from './osm/osmFeatures';

/**
 * The single canonical 3D model. Everything that isn't sampling flows through here:
 *
 *   - the 3D-view menu mutates settings via the setters / applySettings()
 *   - consumers (the preview, the STL exporter) subscribe with onChange() and read
 *     buildGeometry() — the ONE place the surface/socket/tile math lives, in real metres
 *
 * It is sync and pure: index.ts owns DEM sampling and feeds the result in via setGrid().
 * Height exaggeration (heightScale) is baked into the geometry so the preview and the
 * exported STL are always the exact same solid.
 */

/** Per-feature OSM raise config (radius is ignored for `area` features like buildings). */
export interface OsmFeatureSettings {
    enabled: boolean;
    raise: number;
    radius: number;
    separate: boolean;  // true → its own body/object (colourable); false → raise the terrain surface
}

export interface ModelSettings {
    heightZoom: number;      // DEM tile zoom to sample at — drives mesh detail/density
    resolutionLimit: number; // hard cap on vertices along the longest side
    heightScale: number;     // vertical exaggeration, baked into geometry
    socketEnabled: boolean;  // add a base below the terrain to make a manifold solid
    socketSize: number;      // metres of socket below the lowest point (+ a small floor)
    tilesEnabled: boolean;   // split into tilesX × tilesY separate printable solids
    tilesX: number;
    tilesY: number;
    waterEnabled: boolean;   // flatten everything below waterCutoff to a single water level
    waterCutoff: number;     // metres: terrain below this is treated as water (e.g. sea)
    waterLevel: number;      // metres: height water is rendered at (e.g. -50 for a clear step)
    lowCutEnabled: boolean;  // replace everything below lowCutLevel with no-data (carve a hole)
    lowCutLevel: number;     // metres (running height, after water, before scale): below this → a hole
    // Per-OSM-feature raise settings, keyed by feature id (see osm/osmFeatures.ts). Generic so
    // adding a feature (tracks, streets, buildings, future cycleways) needs no new field here.
    osm: Record<string, OsmFeatureSettings>;
    shape: SelectionShape;   // footprint cut from the (still rectangular) sampled grid
}

/** The selection still samples a rectangle; Oval masks it to the inscribed ellipse.
 *  String-valued so it serializes to stable, human-readable config/share-link tokens. */
export enum SelectionShape {
    Rectangle = 'rectangle',
    Oval = 'oval',
}

/** One independent solid: a flat buffer of metre-space vertices + triangle indices. */
export interface ModelTile {
    positions: Float32Array;  // x,y,z per vertex; metres; model-centred; +Y up, +Z south
    indices: Uint32Array;     // 3 per triangle, outward-facing winding
    ix0: number;              // tile column index (for export filenames)
    iy0: number;              // tile row index
    kind?: string;            // 'terrain' or an OSM feature id — groups bodies into named/coloured 3MF objects
}

export interface ModelGeometry {
    tiles: ModelTile[];
    widthMeters: number;      // real-world extent, for camera framing
    heightMeters: number;
    vertexCount: number;
    triangleCount: number;
    minY: number;             // lowest / highest vertex Y (model metres, incl. socket + water)
    maxY: number;
    socketStartY: number | null; // Y where the socket begins (lowest surface), null if no socket
    minThickness: number;     // thinnest / thickest solid column, export units (0 without socket)
    maxThickness: number;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
    heightZoom: 0,
    resolutionLimit: 256,
    heightScale: 1,
    socketEnabled: false,
    socketSize: 0,
    tilesEnabled: false,
    tilesX: 1,
    tilesY: 1,
    waterEnabled: false,
    waterCutoff: 0,
    waterLevel: 0,
    lowCutEnabled: false,
    lowCutLevel: 0,
    osm: defaultOsmSettings(),
    shape: SelectionShape.Rectangle,
};

/** Default per-feature OSM settings from the registry: disabled, with each feature's default
 *  raise/radius. The shape stays generic so a new registry entry needs no change here. */
function defaultOsmSettings(): Record<string, OsmFeatureSettings> {
    const osm: Record<string, OsmFeatureSettings> = {};
    for (const def of OSM_FEATURES) osm[def.id] = { enabled: false, raise: def.raise, radius: def.radius, separate: false };
    return osm;
}

/**
 * Holds the current `HeightGrid` + `ModelSettings` and turns them into neutral metre-space
 * geometry on demand. Stateful only for caching and observation:
 *
 *   - `setGrid` / `applySettings` mutate inputs and `notify()` listeners; both mark the
 *     cache `dirty`. `buildGeometry()` lazily rebuilds once and memoises until the next change,
 *     so the preview and the STL exporter share one build (and one identical solid).
 *
 * `build()` runs the processor pipeline in four fixed stages (the order between stages is the
 * load-bearing invariant; the order *within* a stage is decided by the list-builder methods):
 *
 *   1. grid     — `gridProcessors()` reshape the whole grid; may change its dimensions
 *                 (tiling injects no-data dividers here).
 *   2. elevation — `applyElevation()` runs `elevationValueProcessors()` per cell into a
 *                 `processed` height field (water → low-cut → height-scale).
 *   3. surface  — the fixed 2D→3D lift: `processed` heights become a vertex grid.
 *   4. vertex   — `vertexProcessors()` mutate the assembled mesh (the socket closes it).
 *
 * Two build paths produce the same welded, shared-vertex representation:
 *   - the fast `buildTile` sheet, for a gap-free rectangle, and
 *   - `buildKept` → `buildMaskedTile`, a per-cell walled solid used whenever cells are
 *     dropped — ovals AND no-data holes (real DEM gaps or injected tile dividers) both route
 *     here, so tiling emits ONE solid whose disconnected, walled bodies are the tiles.
 *
 * This pluggable chain is the seed of the planned CAD-style feature history (see CLAUDE.md /
 * todo.md): keep the stage boundary intact when adding processors.
 */
export class MapModel {
    private grid: HeightGrid | null = null;
    // Downloaded OSM features bound to the current grid (lon/lat → [col,row]), keyed by feature id;
    // each feeds an OsmCanvasProcessor. A missing/empty entry means that feature isn't loaded.
    // index.ts keeps these in sync with the grid via setOsmData().
    private osmData = new Map<string, OsmVectorData>();
    private settings: ModelSettings;
    private listeners = new Set<() => void>();
    private cache: ModelGeometry | null = null;
    private dirty = true;

    constructor(initial: Partial<ModelSettings> = {}) {
        this.settings = sanitize({ ...DEFAULT_MODEL_SETTINGS, ...initial });
    }

    // --- observation ---------------------------------------------------------

    /** Subscribe to any change of grid or settings. Returns an unsubscribe fn. */
    onChange(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    private notify(): void {
        this.dirty = true;
        this.cache = null;
        for (const cb of this.listeners) cb();
    }

    // --- data in -------------------------------------------------------------

    /** Feed in freshly sampled heights (or null to clear the model). */
    setGrid(grid: HeightGrid | null): void {
        this.grid = grid;
        this.notify();
    }

    getGrid(): HeightGrid | null {
        return this.grid;
    }

    /** Set one OSM feature's downloaded data (grid-bound, see OsmVectorData.withGrid), or null to
     *  clear it. Rebuilds so the matching OsmCanvasProcessor picks it up. */
    setOsmData(id: string, data: OsmVectorData | null): void {
        if ((this.osmData.get(id) ?? null) === data) return; // no-op (covers clearing already-empty)
        if (data) this.osmData.set(id, data); else this.osmData.delete(id);
        this.notify();
    }

    hasModel(): boolean {
        return !!this.grid;
    }

    // --- settings ------------------------------------------------------------

    getSettings(): ModelSettings {
        return { ...this.settings };
    }

    /** Merge a (partial) settings object from the UI and notify. */
    applySettings(partial: Partial<ModelSettings>): void {
        this.settings = sanitize({ ...this.settings, ...partial });
        this.notify();
    }

    // --- geometry out --------------------------------------------------------

    /** Build (and cache) the neutral geometry both the preview and StlMaker consume. */
    buildGeometry(): ModelGeometry | null {
        if (!this.dirty && this.cache) return this.cache;
        this.dirty = false;
        this.cache = this.grid ? this.build(this.grid) : null;
        return this.cache;
    }

    private build(grid: HeightGrid): ModelGeometry {
        const { grid: terrain, bodies } = this.prepareOsm(grid);
        return buildModelGeometry({ grid: terrain, settings: this.settings, osmBodies: bodies });
    }

    /** Snapshot for an off-thread build: the terrain grid (with any "raise" features folded in) + a
     *  settings copy + the "separate" OSM coverage bodies. The OSM rasterisation runs here, since
     *  `OsmCanvasProcessor` needs a canvas the worker lacks; grid and coverage arrays are plain typed
     *  arrays — postMessage copies them, so handing over `this.grid` directly is safe. */
    prepareBuildInput(): BuildInput | null {
        if (!this.grid) return null;
        const { grid, bodies } = this.prepareOsm(this.grid);
        return { grid, settings: this.getSettings(), osmBodies: bodies };
    }

    /** The DOM-bound OSM pre-pass. Each enabled feature is painted into a coverage mask over `grid`,
     *  then routed by its `separate` flag: separate → its own draped body (`buildFeatureBody`, kept as
     *  a serialisable coverage mask); not separate → folded straight into the terrain surface here
     *  (`addCoverageRaise`). This is the ONE main-thread stage — the canvas can't run in the worker.
     *  Registry order is preserved so overlapping features stay deterministic. */
    private prepareOsm(grid: HeightGrid): { grid: HeightGrid; bodies: OsmBody[] } {
        const s = this.settings;
        const bodies: OsmBody[] = [];
        let out = grid;
        for (const def of OSM_FEATURES) {
            const fs = s.osm[def.id];
            const data = this.osmData.get(def.id);
            if (!(fs?.enabled && fs.raise !== 0 && data && !data.isEmpty())) continue;
            const raster = new OsmCanvasProcessor(data, def, fs.radius);
            const coverage = raster.coverage(grid);
            if (!coverage) continue;
            if (fs.separate) bodies.push({ id: def.id, coverage, raise: fs.raise });
            else out = { ...out, heights: addCoverageRaise(out.heights, coverage, fs.raise) };
        }
        return { grid: out, bodies };
    }

}

function sanitize(s: ModelSettings): ModelSettings {
    return {
        heightZoom: Math.round(num(s.heightZoom, 0)),
        resolutionLimit: Math.min(4096, Math.max(2, Math.floor(num(s.resolutionLimit, 256)))),
        heightScale: Math.max(0.01, num(s.heightScale, 1)),
        socketEnabled: !!s.socketEnabled,
        socketSize: Math.max(0, num(s.socketSize, 0)),
        tilesEnabled: !!s.tilesEnabled,
        tilesX: Math.max(1, Math.floor(num(s.tilesX, 1))),
        tilesY: Math.max(1, Math.floor(num(s.tilesY, 1))),
        waterEnabled: !!s.waterEnabled,
        waterCutoff: num(s.waterCutoff, 0),
        waterLevel: num(s.waterLevel, 0),
        lowCutEnabled: !!s.lowCutEnabled,
        lowCutLevel: num(s.lowCutLevel, 0),
        osm: sanitizeOsm(s),
        shape: s.shape === SelectionShape.Oval ? SelectionShape.Oval : SelectionShape.Rectangle,
    };
}

// Old flat per-feature setting keys (pre-registry share links / saved configs) → feature id, so a
// user's saved raise/radius survive the move to the nested `osm` map.
const LEGACY_OSM_KEYS: Record<string, { enabled: string; raise: string; radius?: string }> = {
    tracks: { enabled: 'tracksEnabled', raise: 'trackRaise', radius: 'trackRadius' },
    streets: { enabled: 'streetsEnabled', raise: 'streetRaise', radius: 'streetRadius' },
    buildings: { enabled: 'buildingsEnabled', raise: 'buildingRaise' },
};

/** Build the nested `osm` settings from the registry, reading the new `s.osm[id]` if present and
 *  otherwise falling back to the legacy flat keys, then to each feature's defaults. */
function sanitizeOsm(s: any): Record<string, OsmFeatureSettings> {
    const out: Record<string, OsmFeatureSettings> = {};
    for (const def of OSM_FEATURES) {
        const cur = s?.osm?.[def.id];
        const legacy = LEGACY_OSM_KEYS[def.id];
        const enabled = cur ? !!cur.enabled : !!(legacy && s?.[legacy.enabled]);
        const raise = cur ? num(cur.raise, def.raise) : num(legacy && s?.[legacy.raise], def.raise);
        const radius = cur ? num(cur.radius, def.radius)
            : num(legacy?.radius ? s?.[legacy.radius] : undefined, def.radius);
        // Default to folding the feature into the terrain surface; set true for a separate body
        // (the colourable multi-object workflow). Legacy configs with no flag default off too.
        const separate = cur && 'separate' in cur ? !!cur.separate : false;
        out[def.id] = { enabled, raise, radius: Math.max(0, radius), separate };
    }
    return out;
}

function num(v: unknown, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
