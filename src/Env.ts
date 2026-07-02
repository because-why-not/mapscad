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
}
