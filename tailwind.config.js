import daisyui from 'daisyui';

export default {
    content: [
        './src/**/*.{svelte,ts,js}',
        './index.html',
    ],
    plugins: [daisyui],
    daisyui: {
        themes: ['dark'],
        darkTheme: 'dark',
        logs: false,
    },
};
