import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// Relative base so the static build works from any host path (GitHub Pages, Netlify, Cloudflare Pages...).
export default defineConfig({
  base: './',
  plugins: [
    preact(),
    // The dev server injects CSS as inline <style> tags, which the strict CSP blocks.
    // Allow inline styles in dev only; the production build links its CSS file and keeps the strict policy.
    {
      name: 'dev-only-csp',
      apply: 'serve',
      transformIndexHtml: (html: string) => html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
    },
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Pebble',
        short_name: 'Pebble',
        description: 'Remember the people you meet.',
        theme_color: '#1d3557',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          // Placeholder art.
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // App shell only for now; runtime caching comes later.
        navigateFallback: 'index.html',
      },
    }),
  ],
  test: { environment: 'node' },
});
