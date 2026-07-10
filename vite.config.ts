import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Vite build for the app (Svelte 5 + Tailwind). The dev server serves everything from memory with
// instant HMR; `vite build` emits a self-contained `dist/`. Tailwind/daisyui run through the
// auto-detected postcss.config.js — no CSS wiring needed here. Unit tests use vitest.config.ts.
export default defineConfig(({ mode }) => {
    // Load .env WITHOUT the default `VITE_` prefix filter, so the private (unprefixed) tile-server
    // vars are readable here. They stay config-side: only what we bake via `define` reaches the
    // client, so a bare `.env` secret is never auto-exposed to the bundle.
    const env = loadEnv(mode, process.cwd(), '');
    const TILE_SERVER_URL = env.LOCAL_TILE_SERVER_URL || env.TILE_SERVER_URL || '';

    return {
        plugins: [svelte()], // reads svelte.config.js (vitePreprocess); compiles .svelte + .svelte.ts
        define: {
            // Baked in like webpack's DefinePlugin. '' when unset → the app falls back to the public
            // base maps + DEMs (see src/kit/config/externalMaps.ts).
            __TILE_SERVER_URL__: JSON.stringify(TILE_SERVER_URL),
        },
        server: {
            port: 8003,       // playwright's webServer + the private start script expect this
            strictPort: true, // fail loudly rather than hopping to another port
            host: true,       // listen on 0.0.0.0 (matches the old allowedHosts: 'all')
            allowedHosts: true
        },
        worker: {
            format: 'es', // the geometry build worker is an ES module (see PreviewController)
        },
        build: {
            outDir: 'dist',
            emptyOutDir: true,
        },
    };
});
