module.exports = {
    content: [
        './src/**/*.{svelte,ts,js}',
        './www/index.html',
    ],
    plugins: [require('daisyui')],
    daisyui: {
        themes: ['dark'],
        darkTheme: 'dark',
        logs: false,
    },
};
