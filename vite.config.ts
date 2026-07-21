import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// base './' keeps the build host-agnostic: works at a domain root (Vercel)
// or under a subpath (GitHub Pages) without a rebuild.
export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'favicon.ico', 'favicon.svg', 'favicon-32.png', 'favicon-16.png'],
      manifest: {
        name: 'Viva Ton',
        short_name: 'Viva Ton',
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
        // Social-preview poster is for link unfurlers only — keep it out of the offline cache.
        globIgnores: ['**/og-image.png'],
        // Phaser's bundle is ~1.5 MB raw; keep it under the precache ceiling.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: 'index.html'
      }
    })
  ]
})
