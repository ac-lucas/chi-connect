import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

/** The relay's origin, from VITE_RELAY_URL. Must be https (http only for a local relay). */
function relayOrigin(mode: string): string | null {
  const raw = loadEnv(mode, process.cwd(), 'VITE_').VITE_RELAY_URL;
  if (!raw) return null;
  const url = new URL(raw);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('VITE_RELAY_URL must be https');
  return url.origin;
}

// Relative base so the static build works from any host path (GitHub Pages, Netlify, Cloudflare Pages...).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    preact(),
    // Let the page talk to the relay, and nothing else: add only its origin to connect-src.
    {
      name: 'csp-relay-origin',
      transformIndexHtml: (html: string) => {
        const origin = relayOrigin(mode);
        return origin ? html.replace("connect-src 'self'", `connect-src 'self' ${origin}`) : html;
      },
    },
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
}));
