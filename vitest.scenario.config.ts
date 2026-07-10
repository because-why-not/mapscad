import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { playwright } from '@vitest/browser-playwright';

// The THIRD test tier — "scenario" runs. Neither a node unit test (vitest.config.ts) nor a full-app
// Playwright e2e: it drives the KIT API directly inside a real headless browser, so browser-only
// stages (the OSM `<canvas>` raise, tile Image decode) run exactly as in production — but with no
// Svelte, no served page. Triggered on demand (`npm run scenario`), NOT part of `npm test`, because
// it hits the live tile server + Overpass (real-world usage, not hermetic).
// `npm run scenario:debug` runs vitest with `--inspect-brk` (vitest's own browser-debug bridge on
// ws://127.0.0.1:9229): a real, visible Chromium opens and execution PAUSES before the test file
// starts — nothing runs until VSCode's "Attach: scenario (real browser, no mocks)" launch config
// (.vscode/launch.json at the workspace root, mapscad/) is attached and you continue. Breakpoints
// then bind to the actual TS sources (kit + scenario) as they actually run — no stubs, no
// Node-side substitute for the browser. (A raw --remote-debugging-port attach does NOT work here:
// VSCode lands on vitest's orchestrator page instead of the tester iframe.)
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
                provider: playwright(),
                headless: !debug, // debug mode wants a visible Chromium, not headless
                instances: [{ browser: 'chromium' }],
            },
        },
    };
});
