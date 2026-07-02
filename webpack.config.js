const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const webpack = require('webpack');
const dotenv = require('dotenv');
const { LicenseWebpackPlugin } = require('license-webpack-plugin');

const env = dotenv.config().parsed || {};
// Optional self-hosted tile server. Unset => '' (the app falls back to the public
// OpenStreetMap / OpenTopoMap base maps + public elevation DEMs; see src/externalMaps.ts).
const TILE_SERVER_URL = env.LOCAL_TILE_SERVER_URL || env.TILE_SERVER_URL || '';

module.exports = {
    mode: 'development',
    devtool: 'eval-source-map',
    entry: './src/index.ts',
    output: { filename: 'index.js', path: path.resolve(__dirname, 'www/js'), clean: true },
    resolve: {
        extensions: ['.svelte', '.ts', '.mjs', '.js'],
        mainFields: ['svelte', 'browser', 'module', 'main'],
        conditionNames: ['svelte', 'browser', 'import'],
    },
    module: {
        rules: [
            { test: /\.svelte$/, use: 'svelte-loader' },
            { test: /node_modules\/svelte\/.*\.mjs$/, resolve: { fullySpecified: false } },
            { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
            { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader', 'postcss-loader'] },
        ],
    },
    plugins: [
        new webpack.DefinePlugin({ __TILE_SERVER_URL__: JSON.stringify(TILE_SERVER_URL) }),
        new MiniCssExtractPlugin({ filename: 'css/index.css' }),
        // Collects the license text of every package actually bundled (not all of
        // node_modules) into www/THIRD_PARTY_LICENSES.txt for distribution attribution.
        new LicenseWebpackPlugin({
            outputFilename: '../THIRD_PARTY_LICENSES.txt',
            perChunkOutput: false,
            // three's package.json `exports` map doesn't expose "./package.json", so the plugin's
            // require.resolve-based package detection throws and silently skips it. Attribute it
            // manually. (glfx.js / d3-color that appear in the output are NOT separate deps — they
            // are riders inside maplibre-gl's own LICENSE.txt.)
            additionalModules: [
                { name: 'three', directory: path.resolve(__dirname, 'node_modules/three') },
            ],
        }),
    ],
    devServer: {
        port: 8003,
        host: '0.0.0.0',
        allowedHosts: 'all',
        static: [{ directory: path.resolve(__dirname, 'www') }],
        devMiddleware: { writeToDisk: true },
    },
};
