import { defineConfig } from 'vitest/config'

// A minimal, standalone Vitest config — deliberately NOT the app's vite.config (whose VitePWA plugin has
// no place in a Node unit-test run). The only tests are pure-logic: src/core/merge.ts plus the
// Phaser-free save/config/types chain it pulls in through coerceSave. Node environment; no DOM needed.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
