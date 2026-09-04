import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy /api to the backend so the browser sees one origin and the session
    // cookie is first-party — no CORS dance, no SameSite surprises in dev.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        // SSE must not be buffered by the proxy.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => { proxyRes.headers['x-accel-buffering'] = 'no'; });
        },
      },
    },
  },
});
