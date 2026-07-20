import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// base './' keeps the build host-agnostic: works at a domain root (Vercel)
// or under a subpath (GitHub Pages) without a rebuild.
export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  // Split the (lazy, optional) Supabase client into its own named chunk so it can be excluded from the
  // PWA precache below — a LOCAL-ONLY build never downloads it; it's fetched on demand only if cloud
  // save is ever configured. See core/cloud.ts (dynamic import).
  build: {
    rollupOptions: { output: { manualChunks: { supabase: ['@supabase/supabase-js'] } } },
  },
  plugins: [
    VitePWA({
      // 'prompt' (not 'autoUpdate') so a new deploy surfaces a visible "new version — refresh" toast
      // the player taps, instead of a silent update that lands a launch late. See main.ts onNeedRefresh.
      registerType: 'prompt',
      includeAssets: ['apple-touch-icon.png', 'favicon.ico', 'favicon.svg', 'favicon-32.png', 'favicon-16.png'],
      manifest: {
        name: 'Viva Maya',
        short_name: 'Viva Maya',
        description: 'A casino match-3 — spin up cascades, chase the jackpot.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f6f3ec',
        theme_color: '#f6f3ec',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest,woff2}'],
        // Social-preview poster is for link unfurlers only; the Supabase chunk is optional + lazy —
        // keep both out of the offline precache so local-only builds never download the cloud client.
        globIgnores: ['**/og-image.png', '**/supabase-*.js'],
        // Phaser's bundle is ~1.5 MB raw; keep it under the precache ceiling.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: 'index.html',
        // Standalone content pages (about / privacy / terms — linked from the Google OAuth consent
        // screen and the app) must always serve as THEMSELVES, never the SPA game fallback — even for
        // an installed PWA. Without this, the navigate-fallback would hand back index.html (the game).
        navigateFallbackDenylist: [/\/(about|privacy|terms)\.html(\?.*)?$/]
      }
    })
  ]
})
