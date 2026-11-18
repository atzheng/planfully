import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // The user decides when to reload: see src/pwa/UpdatePrompt.tsx.
      registerType: 'prompt',
      includeAssets: ['apple-touch-icon.png', 'icon.svg'],
      manifest: {
        name: 'Planfully',
        short_name: 'Planfully',
        description: 'Trips from your inbox, kept private.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // The manifest has one value; index.html adds per-scheme <meta name="theme-color">.
        theme_color: '#f7f8fa',
        background_color: '#f7f8fa',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the built shell only. No runtimeCaching: /api is never cached by the SW
        // (trip data is cached in IndexedDB by a later bead).
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // (public/fonts/*.ttf is not matched by globPatterns either: PDF fonts stay out of the
        // precache. globIgnores below is a belt-and-braces guard.)
        // PDF export libraries (lazy chunks) stay out of the precache: export needs to be online
        // the first time. index.es is jsPDF's canvg dependency.
        globIgnores: [
          '**/jspdf.es.min-*.js',
          '**/jspdf.plugin.autotable-*.js',
          '**/html2canvas-*.js',
          '**/purify.es-*.js',
          '**/index.es-*.js',
          'fonts/**',
          '**/fontCoverage.generated-*.js',
        ],
        navigateFallback: '/index.html',
        navigateFallbackAllowlist: [/^\/$/, /^\/new$/, /^\/t\//],
        navigateFallbackDenylist: [/^\/api(\/|$)/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://localhost:8787' },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
