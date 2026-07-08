import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react({
      include: /\.(js|jsx|ts|tsx)$/,
    }),
  ],
  server: {
    port: 3000,
    host: true,
    proxy: {
      // Bare-metal dev: the backend publishes localhost:5000 (also via the
      // compose override). Override with BACKEND_PROXY when the backend runs
      // elsewhere, e.g. BACKEND_PROXY=http://backend:5000 inside a container.
      '/api': process.env.BACKEND_PROXY || 'http://localhost:5000',
    },
  },
  build: {
    outDir: 'dist',
    // Don't inline Vite's modulePreload polyfill — it's emitted as an inline
    // <script>, which the strict CSP in index.html (script-src 'self' …, with
    // no 'unsafe-inline'/hash/nonce) would block. All target browsers support
    // <link rel="modulepreload"> natively, so the polyfill is unnecessary.
    modulePreload: { polyfill: false },
  },
  esbuild: {
    loader: 'jsx',
    include: /src\/.*\.jsx?$/,
    exclude: [],
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: { '.js': 'jsx' },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.js',
  },
});
