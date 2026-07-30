import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// base './' keeps the build host-agnostic: works at a domain root (Vercel)
// or under a subpath (GitHub Pages) without a rebuild.
export default defineConfig({
  base: './',
  // 5173 by default; PORT overrides it so a second dev server (another agent/dev on the same repo)
  // can run side by side instead of colliding on strictPort.
  server: { port: Number(process.env.PORT) || 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  // Split the (lazy, optional) Supabase client into its own named chunk so it can be excluded from the
  // PWA precache below — a LOCAL-ONLY build never downloads it; it's fetched on demand only if cloud
  // save is ever configured. See core/cloud.ts (dynamic import).
  //
  // three.js gets its own chunk too: it is dynamically imported by view3d/stage.ts (loaded in parallel
  // with the cloud bootstrap, before Phaser boots), and a named chunk keeps it long-lived in the HTTP
  // cache across app deploys that don't bump the three version. Unlike supabase it IS precached — the
  // 3D room must work offline like the rest of the PWA.
  build: {
    rollupOptions: {
      // Two entries: the game, and the owner-only analytics dashboard (stats.html →
      // src/stats/main.ts). A separate entry — not a route in the game — so the dashboard ships
      // zero Phaser/three and the game ships zero dashboard; they share only the supabase chunk.
      input: { main: 'index.html', stats: 'stats.html' },
      output: { manualChunks: { supabase: ['@supabase/supabase-js'], three: ['three'] } },
    },
  },
  // Stamp the build into the bundle so every analytics event says which code produced it. Under a
  // 'prompt'-mode PWA players sit on several bundles at once (they update when they tap the toast,
  // not when we deploy), so a metric that moves after a release is unreadable without this — you
  // cannot otherwise tell "the change worked" from "half the players haven't got the change yet".
  // GITHUB_SHA is set by Actions; 'dev' locally.
  define: {
    __APP_VERSION__: JSON.stringify((process.env.GITHUB_SHA ?? 'dev').slice(0, 7)),
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
        // Web Push handlers, layered onto the GENERATED worker rather than replacing it. Switching to
        // injectManifest to hand-write a worker would mean owning the precache wiring, the
        // navigateFallback denylist and the SKIP_WAITING plumbing the update toast depends on — all
        // of which already work. See public/push-sw.js (which must never throw at top level: it is
        // evaluated during install, so a failure there would take offline + updates down with it).
        // Resolved relative to the worker's own URL, so it works under the /viva-maya/ Pages subpath
        // and at a domain root without a rebuild — same reason `base` is './'.
        importScripts: ['push-sw.js'],
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest,woff2}'],
        // Social-preview poster is for link unfurlers only; the Supabase chunk is optional + lazy —
        // keep both out of the offline precache so local-only builds never download the cloud client.
        // The stats.html dashboard (entry + its js/css) is owner-only: precaching it would push it
        // onto every player's device with the offline bundle, paying bytes for a page only one
        // person can use.
        globIgnores: ['**/og-image.png', '**/supabase-*.js', '**/stats.html', '**/stats-*.js', '**/stats-*.css'],
        // Phaser's bundle is ~1.5 MB raw; keep it under the precache ceiling.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: 'index.html',
        // Standalone content pages (about / privacy / terms — linked from the Google OAuth consent
        // screen and the app) must always serve as THEMSELVES, never the SPA game fallback — even for
        // an installed PWA. Without this, the navigate-fallback would hand back index.html (the game).
        // stats.html is in the same boat: it is not precached (above), so a navigation to it from an
        // installed PWA would otherwise be answered with the game.
        navigateFallbackDenylist: [/\/(about|privacy|terms|stats)\.html(\?.*)?$/]
      }
    })
  ]
})
