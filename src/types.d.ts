// Global ambient declarations. This file must stay a *script* (no top-level import/export), so its
// wildcard module declarations are recognised globally — TS 6 does not apply `declare module '*.x'`
// from a module file. (The `import('svelte')` below is a type-only inline import; it does not make
// this a module.)
declare module '*.svelte' {
    const component: import('svelte').Component<any>;
    export default component;
}

declare module '*.css';

// Injected by Vite's `define` at build time (see vite.config.ts).
declare const __TILE_SERVER_URL__: string;
