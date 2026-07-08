import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Enables `<script lang="ts">` in components: vitePreprocess transpiles the TS (via esbuild) before
// the Svelte compiler runs. Plain `<script>` blocks pass through untouched, so the UI can migrate to
// TypeScript one component at a time — JS and TS components coexist. Shared by vite-plugin-svelte
// (the build) and the tooling (svelte-check / the IDE extension both read this file).
export default {
    preprocess: vitePreprocess(),
};
