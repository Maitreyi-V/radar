/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#0a0c10', 900: '#0f1218', 850: '#141821', 800: '#1a1f2b', 700: '#262d3d', 600: '#3a4356' },
        up: '#00c48c',
        down: '#ff5c5c',
        accent: '#5b8cff',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
