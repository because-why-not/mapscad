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
}
