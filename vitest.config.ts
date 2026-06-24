import { defineConfig } from 'vitest/config';

// Unit tests only. Playwright owns tests/e2e (browser-driven), so keep it out of Vitest's
// glob or the two runners collide on the same files.
export default defineConfig({
    test: {
        include: ['tests/unit/**/*.test.ts'],
        environment: 'node',
    },
});
