declare module '*.svelte' {
    const component: import('svelte').Component<any>;
    export default component;
}

declare global {
    const __TILE_SERVER_URL__: string;
}

export {};
