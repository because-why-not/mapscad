// Boot-time override for the forced raster resolution: a `rasterResolution` localStorage key (read
// once at module load) pins the grid density — used by the e2e to build a small deterministic mesh,
// and handy for dev tuning. Absent/invalid, or where there's no localStorage (worker), → the default.
function rasterResolutionOverride(fallback: number): number {
    try {
        const v = Number(localStorage.getItem('rasterResolution'));
        if (Number.isFinite(v) && v >= 2) return v;
    } catch { /* no localStorage available */ }
    return fallback;
}

function timestamp(): string {
    const t = new Date();
    const p = (n: number, l = 2) => n.toString().padStart(l, '0');
    return `[${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}.${p(t.getMilliseconds(), 3)}]`;
}

export class Env {
    static get log()   { return console.log.bind(console,   timestamp()); }
    static get warn()  { return console.warn.bind(console,  timestamp()); }
    static get error() { return console.error.bind(console, timestamp()); }

    static get tileServerPrefix(): string {
        return __TILE_SERVER_URL__;
    }

    // Max selection side length (metres) for which each OSM feature can be downloaded. Above this
    // the area would yield too many elements to fetch/hold, so the UI blocks it with a warning.
    static readonly BUILDINGS_LIMIT = 5000;
    static readonly STREET_LIMIT = 5000;
    static readonly TRACK_LIMIT = 10000;
    static readonly RIVER_LIMIT = 10000;
    static readonly WATER_LIMIT = 10000;

    // The model raster-grid resolution (samples along the longest side) forced on every page load —
    // the DEM is bilinearly filled into a grid this size, so it sets mesh density independent of the
    // DEM zoom. Deliberately mutable (not readonly) so it can be overridden at runtime while tuning;
    // seeded from the optional `rasterResolution` localStorage override, else 512.
    static rasterResolution = rasterResolutionOverride(512);
}
