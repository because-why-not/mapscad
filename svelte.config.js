const sveltePreprocess = require('svelte-preprocess');

// Enables `<script lang="ts">` in components: svelte-preprocess transpiles the TS to JS before the
// Svelte compiler runs. Plain `<script>` blocks pass through untouched, so the UI can migrate to
// TypeScript one component at a time — JS and TS components coexist. Shared by svelte-loader (see
// webpack.config.js) and the tooling (svelte-check / the IDE extension both read this file).
module.exports = {
    preprocess: sveltePreprocess(),
};
