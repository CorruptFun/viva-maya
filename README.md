# Viva Maya ❤️🎰

Casino match-3 made for Maya — a modern match-3 board loop with zero meta-game.
Mobile-first, installable, fully offline PWA. (Formerly "Vegas Match".)

**Play:** https://corruptfun.github.io/viva-maya/ — on iPhone: Share → Add to Home
Screen to install it like an app (works offline after first load).

## Dev

```sh
npm install
npm run dev      # http://localhost:5173 (or $PORT, if set)
npm run build    # typecheck + production build + service worker (dist/)
npm run preview  # serve the production build at http://localhost:4173
npm test         # unit tests (vitest, pure-logic core — no Phaser)
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
- [x] **Levels** — 300 seeded levels with per-level collect objectives + move limits and a
      difficulty curve (`src/core/levels.ts`), drag-scrollable level select with stars/unlocks,
      win/lose overlays, persistent progress (localStorage v8 save)
- [x] **Phase 5 — audio & juice** — procedural WebAudio SFX (pitch-shifting cascades, sirens),
      MEGA WIN choreography, haptics, mute toggle, selectable move sounds
- [x] **Return hooks** — lives/energy pool (lose-only, self-refilling), daily bonus spin with
      streaks, star milestones every 10 levels, endless weekly-seed score race (unlocks at L20)
- [x] **Presentation** — slot-cabinet visuals + ambient casino backdrop, home screen,
      how-to-play panel
- [x] **UI/animation overhaul (rounds 1–3)** — tactile pressables (tap-flash, release
      shine, hero sheen), directional transition light-wipes + launch bloom + screen
      gloss, board depth stack + squash-settle refill + level-intro build-in, score
      medallions, collect comets, special-piece drama, menu entrance choreography
- [x] **Social & economy layer (round 4)** — weekly-race leaderboard + champion prize
      tiers + coronation, referral program, free spins from MEGA WINs, jackpot-wheel
      spectacle, lives tuning (5 / 20 min / grace below L10). See
      `docs/SOCIAL_AND_ECONOMY.md` and `docs/GO_LIVE_CHECKLIST.md`.
- [x] **Lucky Deal & charms** — a card pick'em dealt by a three-win HOT STREAK: nine
      face-down cards, turn them until three match. The first reward surface in the game
      the player *chooses* their way through (the slot, wheel and plinko are all watched),
      and the rig is provable — the deck holds exactly three of the rolled face and at most
      two of anything else, so the outcome is settled up front and the finished table can be
      counted. The ❤️ card pays a **CHARM**: nine to a series in a 3×3 album, duplicates pay
      chips, a completed series pays a purse, and every charm is +1 **LUCK**, which reweights
      the Deal's own table toward the richer cards. Charms are also **spendable** — an exchange
      under the album trades them for things chips can't buy (a wheel pull, a heart refill, a
      Deal on demand), and spending never costs you luck.

## Dev / test knobs (DEV builds only)

Append to the URL: `?level=N` jump to level · `&auto=MS` autoplay hinted moves ·
`&goal=N` / `&moves=N` override objectives/move budget · `&plant=1` seed specials
bottom-left · `&turbo=N` scale tween/timer clocks (embedded panes starve the RAF clock).
Round-4 additions: `?race[=rich|out|empty|loading|error|crownyou]` weekly-race panel
fixtures · `?levels[=rich|out|empty|loading|error]` LEVEL RACE ladder fixtures ·
`?raceline=rich|out|new` Home standings-line fixtures · `?coronation` /
`?friend[=n]` celebration previews · `?invite=in|minting|welcome` store invite fixtures ·
`?wheel` fire the armed jackpot wheel · `?wedge=N` pin the winning wedge ·
`?ticket=N` free-spin ticket beat · `?ref=CODE` referral capture (works in prod too) ·
`?plinko[=PTS]` open the Plinko bonus drop · `?slot=N` pin its landing slot ·
`?deal` open the Lucky Deal · `?face=cherry|clover|bell|bar|diamond|seven|heart` pin its winning
card (the only way to reach the CHARM / SERIES COMPLETE payoffs without grinding a 3% card) ·
`?charms` open the charm album from Home ·
`?repro=upgrade` plant the "special swallowed by its own upgrade" regression case ·
`?lives=N` · `?endless=1` · `?scene=daily|home|levelselect` · `?spin=1` · `?autospin=1` ·
`?help` / `?sound` auto-open those panels.
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
