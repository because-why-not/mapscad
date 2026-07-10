import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { playwright } from '@vitest/browser-playwright';

// The THIRD test tier — "scenario" runs. Neither a node unit test (vitest.config.ts) nor a full-app
// Playwright e2e: it drives the KIT API directly inside a real headless browser, so browser-only
// stages (the OSM `<canvas>` raise, tile Image decode) run exactly as in production — but with no
// Svelte, no served page. Triggered on demand (`npm run scenario`), NOT part of `npm test`, because
// it hits the live tile server + Overpass (real-world usage, not hermetic).
// `SCENARIO_DEBUG=1 npm run scenario:debug` (see package.json) opens a real, visible Chromium with
// its CDP port exposed, so VSCode's "Attach: scenario (real browser, no mocks)" launch config
// (.vscode/launch.json at the workspace root, mapscad/) can attach and hit breakpoints in the actual
// kit code as it actually runs — no stubs, no Node-side substitute for the browser. This
// deliberately runs in watch mode (see the script), not `vitest run`: the browser stays open long
// enough to attach before triggering a rerun.
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const TILE_SERVER_URL = env.LOCAL_TILE_SERVER_URL || env.TILE_SERVER_URL || '';
    const debug = !!process.env.SCENARIO_DEBUG;
    return {
        define: { __TILE_SERVER_URL__: JSON.stringify(TILE_SERVER_URL) },
        test: {
            include: ['tests/scenario/**/*.scenario.ts'],
            testTimeout: debug ? 0 : 120_000, // 0 = disabled, so breakpoints can pause indefinitely
            browser: {
                enabled: true,
                provider: playwright({
                    launchOptions: debug ? { args: ['--remote-debugging-port=9222'] } : undefined,
                }),
                headless: !debug, // debug mode wants a visible, attachable Chromium, not headless
                instances: [{ browser: 'chromium' }],
            },
        },
    };
});
