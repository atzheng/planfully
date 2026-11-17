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
        theme_color: '#f7f7f5',
        background_color: '#f7f7f5',
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
