# Viva Maya ❤️🎰

Casino match-3 made for Maya — the Homescapes board loop with zero meta-game.
Mobile-first, installable, fully offline PWA. (Formerly "Vegas Match".)

**Play:** https://corruptfun.github.io/viva-maya/ — on iPhone: Share → Add to Home
Screen to install it like an app (works offline after first load).

## Dev

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build + service worker (dist/)
npm run preview  # serve the production build at http://localhost:4173
npm run icons    # regenerate public/ PWA icons (procedural, no deps)
```

Board size, symbol count, and all timing/feel constants live in `src/config.ts`.
Game logic is pure TypeScript in `src/core/` (no Phaser imports) — rendering,
input, and tweens live in `src/scenes/` and `src/view/`.

## Roadmap

- [x] **Phase 1** — Vite + TypeScript + Phaser 3 + PWA scaffold
- [x] **Phase 2** — grid, swap input (swipe + tap-tap), match detection, turn state machine
- [x] **Phase 3** — gravity, refill, bounce-settle falls, cascade multipliers
- [x] **Phase 4** — power-ups: Wild Reel (match-4), Dice Bomb (L/T), Jackpot Chip (match-5),
      full combo matrix (reel+reel cross, bomb+bomb 5x5, reel+bomb triple-cross,
      jackpot+reel/bomb color conversion, jackpot+jackpot board wipe), chain detonations
- [x] **MVP levels** — 30 levels, seeded per-level collect objectives + move limits with a
      difficulty curve (`src/core/levels.ts`), level select with stars/unlocks, win/lose
      overlays, persistent progress (localStorage v2 save)
- [ ] **Phase 5** — audio (pitch-shifting cascades, sirens), MEGA WIN choreography, heavier juice

## Dev / test knobs (DEV builds only)

Append to the URL: `?level=N` jump to level · `&auto=MS` autoplay hinted moves ·
`&goal=N` / `&moves=N` override objectives/move budget · `&plant=1` seed specials
bottom-left · `&turbo=N` scale tween/timer clocks (embedded panes starve the RAF clock).
An on-screen strip + `document.body.dataset.vegas` mirror expose model state
(needed because the Claude browser pane's JS eval binds to a stale document —
screenshots are the only reliable channel, so the game surfaces its state visually).

Install to home screen: on iOS Safari, Share → Add to Home Screen (service worker
makes it fully offline after first load).

## License

**Proprietary — © 2026 CorruptFun LLC. All rights reserved.** This repository is public
for reference only; no license or right to the code, design, or assets is granted.
Copying, modifying, redistributing, or reusing any part of it without prior written
permission is prohibited. See [LICENSE](LICENSE).
