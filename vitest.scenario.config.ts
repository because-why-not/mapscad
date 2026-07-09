import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { playwright } from '@vitest/browser-playwright';

// The THIRD test tier — "scenario" runs. Neither a node unit test (vitest.config.ts) nor a full-app
// Playwright e2e: it drives the KIT API directly inside a real headless browser, so browser-only
// stages (the OSM `<canvas>` raise, tile Image decode) run exactly as in production — but with no
// Svelte, no served page. Triggered on demand (`npm run scenario`), NOT part of `npm test`, because
// it hits the live tile server + Overpass (real-world usage, not hermetic).
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const TILE_SERVER_URL = env.LOCAL_TILE_SERVER_URL || env.TILE_SERVER_URL || '';
    return {
        define: { __TILE_SERVER_URL__: JSON.stringify(TILE_SERVER_URL) },
        test: {
            include: ['tests/scenario/**/*.scenario.ts'],
            testTimeout: 120_000, // real DEM download + Overpass + build
            browser: {
                enabled: true,
                provider: playwright(),
                headless: true,
                instances: [{ browser: 'chromium' }],
            },
        },
    };
});
