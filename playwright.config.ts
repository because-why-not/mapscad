import { defineConfig, devices } from '@playwright/test';

const PORT = 8003; // matches webpack.config.js devServer port

// E2E smoke tests. Playwright boots the webpack dev server itself (reusing one if already
// running) and drives a real browser against it.
export default defineConfig({
    testDir: './tests/e2e',
    use: {
        baseURL: `http://localhost:${PORT}`,
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        command: 'npm run dev',
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
