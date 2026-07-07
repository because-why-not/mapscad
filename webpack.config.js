const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const webpack = require('webpack');
const dotenv = require('dotenv');
const svelteConfig = require('./svelte.config.js'); // { preprocess } — lets components opt into <script lang="ts">

const env = dotenv.config().parsed || {};
// Optional self-hosted tile server. Unset => '' (the app falls back to the public
// OpenStreetMap / OpenTopoMap base maps + public elevation DEMs; see src/externalMaps.ts).
const TILE_SERVER_URL = env.LOCAL_TILE_SERVER_URL || env.TILE_SERVER_URL || '';

// Exported as a function so the release build (`webpack --mode production`, i.e. `npm run build`)
// can differ from the dev config: a hardcoded `devtool` is NOT overridden by the CLI's --mode,
// and eval-source-map in a production bundle defeats minification and inlines the full source
// (~12 MB instead of ~1 MB). Dev builds (compile/watch/dev) are unchanged.
module.exports = (cliEnv, argv) => {
    const release = argv.mode === 'production';
    return {
        mode: release ? 'production' : 'development',
        devtool: release ? false : 'eval-source-map',
        entry: './src/index.ts',
        output: { filename: 'index.js', path: path.resolve(__dirname, 'www/js'), clean: true },
        resolve: {
            extensions: ['.svelte', '.ts', '.mjs', '.js'],
            mainFields: ['svelte', 'browser', 'module', 'main'],
            conditionNames: ['svelte', 'browser', 'import'],
        },
        module: {
            rules: [
                { test: /\.svelte$/, use: { loader: 'svelte-loader', options: { preprocess: svelteConfig.preprocess } } },
                // `.svelte.ts` = a runes MODULE (reactive state/logic outside a component). svelte-loader
                // compiles it via `compileModule` but does NOT preprocess, so it can't parse TS itself:
                // ts-loader (transpile-only — svelte-check is the type gate, and $state has no ambient type
                // here) strips the types first, then svelte-loader compiles the runes. Its own instance so
                // it doesn't share config with the main `.ts` rule below.
                {
                    test: /\.svelte\.ts$/,
                    use: ['svelte-loader', { loader: 'ts-loader', options: { transpileOnly: true, instance: 'svelte-modules' } }],
                },
                { test: /node_modules\/svelte\/.*\.mjs$/, resolve: { fullySpecified: false } },
                { test: /\.ts$/, use: 'ts-loader', exclude: [/node_modules/, /\.svelte\.ts$/] },
                { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader', 'postcss-loader'] },
            ],
        },
        plugins: [
            new webpack.DefinePlugin({ __TILE_SERVER_URL__: JSON.stringify(TILE_SERVER_URL) }),
            new MiniCssExtractPlugin({ filename: 'css/index.css' }),
        ],
        devServer: {
            port: 8003,
            host: '0.0.0.0',
            allowedHosts: 'all',
            static: [{ directory: path.resolve(__dirname, 'www') }],
            devMiddleware: { writeToDisk: true },
        },
    };
};
