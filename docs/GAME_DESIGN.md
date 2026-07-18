# Viva Maya — Game Design & Mechanics Reference

Casino match-3 PWA (Phaser 3.90 + Vite 7 + TS strict). Live: https://corruptfun.github.io/viva-maya/
Repo: github.com/CorruptFun/viva-maya · Local: `~/Creative/viva-maya/` (Mac mini)
This file is the canonical mechanics reference — keep it updated when rules change.

## Pillars
- The match-3 board IS the game. Everything else is a doorway back into it.
- Additions must create reasons to RETURN, never chores to clear. No energy systems,
  no purchasable currencies, no meta-building. Boosters are earned (daily spin), not bought.
- Warm "modern slot screen" look: off-white #f6f3ec, gold #f2b234/#c9930a, rose #d3304f,
  navy #26304d, system-emoji symbols. Heart motif = Maya tribute (name carries it; no
  explicit dedication text in product copy).

## Board & matching (src/core/board.ts — pure TS, no Phaser imports)
- 8×8 grid (config.ts: ROWS/COLS/CELL=80, board at BOARD_X=40, BOARD_Y=300, design 720×1280).
- Symbols: cherry 🍒, seven (styled red 7), diamond 💎, bell 🔔, clover 🍀, bar (navy pill).
  Levels 1–3 use first 5; level 4+ all 6 (levelSpec.symbolCount).
- Swap adjacent pieces via swipe (drag ≥ 0.3·CELL) or tap-select→tap-adjacent. Invalid swaps
  snap back (no move consumed). A swap is valid if it creates a run ≥3 OR activates specials.
- Board generation: never spawns pre-existing matches; guarantees ≥1 valid move; reshuffles
  (regenerate) when no valid move remains. findFirstValidMove doubles as the autoplay/hint engine.
- Resolve loop (GameScene state machine): idle → swapping → resolving (wave→gravity→refill,
  repeat while matches exist) → idle | ended. Cascade counter increments per wave.

## Special pieces
Created at the swapped cell when possible, else run intersection, else run middle.
Specials keep their symbol (still match by color); Jackpot is colorless (never in runs).
Match-created specials are blast-protected during their birth wave.

| Shape | Piece | Effect |
|---|---|---|
| 4 in a row | Wild Reel (chevrons) | Clears full line PERPENDICULAR to the match |
| L/T (two crossing runs) | Dice Bomb (🎲 badge) | 3×3 blast |
| 5+ straight | Jackpot Chip (gold 🎰 disc) | Swap with anything: clears all of that color |

Chain rule: any blast that hits a special detonates it (chainExpand). Jackpot hit by a blast
clears a RANDOM present color. Swap-combos (both consumed, epicenter = drag destination):
- Reel+Reel: full cross (row+col)
- Bomb+Bomb: 5×5 blast
- Reel+Bomb: 3 rows + 3 cols through epicenter
- Jackpot+normal: clears that color
- Jackpot+Reel/Bomb: converts every piece of that color into that special, detonates all
- Jackpot+Jackpot: clears the entire board

## Scoring
- 20 pts/piece × cascade number (wave 1 ×1, wave 2 ×2, …). Specials count as their symbol.
- COMBO popup at cascade ≥2; MEGA WIN at ≥4 (siren + big vibrate).
- Win: +60 pts per unused move (moves bonus). doubleScore boost multiplies EVERYTHING
  that level ×2 (including moves bonus) — GameScene.addScore applies scoreMult.
- BEST = highest single-level score, shown home/level-select.

## Levels (src/core/levels.ts)
- levelSpec(n) is deterministic per level (seed 0xC0FFEE ^ n·2654435761): same goals every
  attempt; boards are random per attempt. LEVEL_COUNT = 30 (UI); spec works for any n.
- Objectives: collect N of 1 symbol (L1–2), 2 symbols (L3–7), 3 (L8+); per-objective
  N = min(45, 10 + round(2.2n)). Collected = cleared pieces of that symbol (jackpot pieces excluded).
- Moves: max(14, 26 − floor(n/2)) + 2·objectiveCount, +4 breather on every 5th level.
- Win when all objectives hit 0 (cascades count); lose when moves hit 0 first.
- Stars by remaining-moves fraction: ≥50% → 3★, ≥25% → 2★, else 1★. recordResult persists
  best-of stars, unlocks n+1.
- Star milestone: clearing a level where n%10===0 plays a full-screen "LEVEL n! · N STARS
  EARNED" splash (heart shower + fanfare) before the normal result card (GameScene.milestoneSplash).

## Endless weekly race (src/core/endless.ts + GameScene endless mode)
- Unlocks once the last numbered level is cleared (save.unlocked > LEVEL_COUNT). Entry: rose
  ENDLESS pill on Home and LevelSelect.
- weekKey(now) = ISO-8601 week "YYYY-Www" (local, Thursday-anchored). seedForWeek() = FNV-1a →
  endlessRng() = mulberry32(seed): EVERYONE gets the SAME board that week; every attempt that
  week replays the identical starting board (a BEST-score race, not per-attempt random).
- Score attack: ENDLESS_MOVES=30, all 6 symbols, NO objectives, NO boosts applied (planting
  specials would change the board and break fairness). Ends only on moves-out → finishEndless.
- recordEndless persists endlessBest per week (resets when weekKey rolls over); also flows into
  all-time save.best. HUD shows a "WEEK'S BEST" card; end card shows NEW BEST! / TIME'S UP.

## Daily Bonus (src/core/daily.ts + DailyBonusScene)
- One spin per LOCAL calendar day (lastSpinDate 'YYYY-MM-DD'; device clock trusted — offline toy).
- 3-reel slot machine that ALWAYS lands 3-of-a-kind of the prize (gift, not gambling).
  Prize + streak computed & persisted BEFORE the animation (performSpin) — closing app loses nothing.
- Prize table (weights): Wild Reel 30, Dice Bomb 25, +5 Moves 20, Double Score 15, Jackpot Chip 10.
- Streak: consecutive days (+1 if yesterday spun, else reset to 1). Every 5th streak day = TWO prizes.
- Prizes land in save.pendingBoosts; GameScene.applyBoosts consumes ALL on the next NUMBERED
  level start (win or lose; endless never consumes them): plants specials at random cells rows
  3–7 (board.plant keeps cell's symbol), +5 moves each, ×2 scoreMult. Shown at level start as a
  self-sizing gold banner over the top of the board (GameScene.showBoostBanner — pops in, holds,
  fades up) plus a ×2 badge. (Was a flat toast at BOARD_Y−44 that overlapped the objective row.)
- Home button: gold+pulse when ready ("DAILY BONUS"), ghost "SPUN · DAY N" after.
  NOTE: no emoji in pill labels — letterSpacing splits surrogate pairs (renders tofu).

## Save (src/core/save.ts — localStorage key 'viva-maya:v1', all access try/catch)
v4: { v:4, best, unlocked, stars{level:1..3}, lastSpinDate|null, streak, pendingBoosts[],
      endlessWeek|null, endlessBest }
Migrations: v1 {best} → v2 (+unlocked/stars) → v3 (+daily fields) → v4 (+endless race:
endlessWeek "YYYY-Www", endlessBest); loader is shape-tolerant (old saves default new fields).
Mute flag is separate: 'viva-maya:muted'.

## Audio (src/audio/sfx.ts — procedural WebAudio, zero assets)
Singleton, lazy AudioContext, unlocked on first pointerdown (iOS), master gain 0.5 →
compressor. Muted flag persisted; every call guarded (never throws; silent if unavailable).
Map: uiTap (buttons) · swapWhoosh · invalidThud (snap-back) · pop(cascade) rises one
semitone per cascade (2^((c−1)/12)) · reelSweep · bombBoom (+30ms vibrate) · jackpotStrike ·
MEGA WIN → jackpotStrike + vibrate [60,40,120] · winFanfare + starDing per earned star +
vibrate 80 · loseWah · reshuffleSwirl.

## Scenes & UI
Boot (textures) → Home (streak flame badge when streak>0, heart emblem, marquee, PLAY→current
level, LEVELS, DAILY BONUS, ENDLESS when unlocked) → LevelSelect (5×6 chips, stars, locks,
back‹, mute, ENDLESS banner when unlocked) → Game (numbered or endless) → DailyBonus.
Shared: ui.ts (addMarquee, addPillButton, addMuteChip, addStreakBadge, GOLD/GHOST/ROSE pill
styles — ROSE marks the endless "special mode"; streak flame keeps 🔥 in its own text object
to dodge the letterSpacing surrogate-pair bug),
background.ts addCasinoBackdrop(scene, 'home'|'menu'|'game') — gradient wash, twinkling
marquee dot strips, corner bokeh, ♥♦♣♠ watermarks, drifting motes (not on 'game').
All textures generated at boot (textures.ts): emoji → DynamicTextures; specials composed
lazily (ensurePieceTexture); NEVER destroy a RenderTexture you saveTexture'd — use
addDynamicTexture instead.

## Mobile/PWA
Portrait design 720×1280, Scale.FIT + CENTER_BOTH (no CSS flex on #app — double-centering).
touch-action:none, no pinch zoom, viewport-fit=cover, apple-touch meta, standalone display.
vite-plugin-pwa autoUpdate SW precaches everything except og-image.png. Install: Safari →
Share → Add to Home Screen. base:'./' keeps builds host-agnostic.

## Icons & social (scripts/gen-icons.mjs — macOS: headless Chrome + sips)
icon.html → 5×5 emoji board + VIVA MAYA banner (checkerboard = (row+col)%2). Banner on
≥180px; 16/32/48 + favicon.ico are board-only (#plain hash). og.html → 1200×630 poster.
`npm run icons` regenerates all of public/. favicon.svg is hand-authored.

## Dev/test knobs (DEV builds only; see GameScene/BootScene/DailyBonusScene create)
?level=N jump · ?endless=1 boot the weekly race · ?scene=daily|home|levelselect ·
?auto=MS autoplay hinted moves · ?turbo=N scale tween/timer clocks · ?goal=N ?moves=N
override level · ?plant=1 seed specials · ?spin=1 force spin available · ?autospin=1 auto-trigger spin.
DEV strip (top-left) mirrors model state (level/state/moves/score/objectives/hint) — the
Claude browser pane starves the RAF clock and drops clicks while hidden; screenshots are
the only reliable channel there, so verify via strip + autoplay/autospin, and confirm
tap-targets on a real device.

## Build & deploy
npm run dev (5173) · build (tsc+vite→dist) · preview (4173) · icons.
Deploy: GitHub Pages. With workflow scope: push to main → .github/workflows/deploy.yml
builds and deploys automatically. Legacy fallback: publish dist/ to gh-pages branch.

## Roadmap (agreed direction)
DONE: streak flame on Home (addStreakBadge) · endless weekly-seed race after L30 (shared board,
BEST race — src/core/endless.ts) · star-milestone celebration every 10 levels (milestoneSplash).
TODO: surface streak in more places if wanted · tune levelSpec from Maya's real play.
Explicitly rejected: lives/energy, currencies, home-decorating meta.
