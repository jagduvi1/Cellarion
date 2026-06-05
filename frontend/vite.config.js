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
      '/api': 'http://backend:5000',
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
