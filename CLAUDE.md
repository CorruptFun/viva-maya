# Viva Maya

Casino-styled match-3. Mobile-first installable PWA.
Live: <https://corruptfun.github.io/viva-maya/>

## Do not assume

- **This one *does* have a build step** — unlike the other Creative projects.
  Vite + TypeScript. `npm run build` runs `tsc && vite build`. Don't hand-edit
  anything in `dist/`; it is generated output.
- **It's a Phaser game, not a DOM game.** ~20 files under `src/` import Phaser.
  Game screens are Phaser scenes in `src/scenes/`, not HTML.
- **three.js is used, but barely.** Only `src/view3d/stage.ts`. Don't reach for
  it elsewhere; it's chunked separately in `vite.config.ts` on purpose.
- **Score defence is guard rails, not replay — and it lives in the migrations.**
  Scores are *self-reported*; what the server actually enforces is RLS (a row is
  writable only by its owner), guard triggers that keep a score monotonic per
  (user, week/day) and refuse any day but the current one, and the race-day salt
  check that rejects a score not carrying today's salt. The header comments in
  `supabase/migrations/` are the authority — 0002, 0006, 0007, 0012 and 0024 each
  say what they close *and what they deliberately leave open*. Read those, plus
  the board-salt note below, before touching anything score-, leaderboard-, or
  reward-related, and don't move a guard to the client for convenience.
  Server-side deterministic replay (submit the move list, server replays the
  seeded board) is the known hardening path and is **not** built.
- **`base: './'`** in `vite.config.ts` — relative asset paths, required for
  GitHub Pages. Don't "fix" it to `/`.
- **The RGB cabinet marquee is a light TUBE, not bulbs — and it is one clock.**
  The board and slots frames (`src/view/rgbmarquee.ts`) carry a continuous band of
  light, built from soft `rgbnode` atoms laid along the bezel path and *stretched
  along it* so they overlap into a seamless gradient. Three things are load-bearing
  and easy to undo by accident:
  - **The stretch.** Nodes are ellipses rotated to the path tangent. Circular ones
    need roughly 3× the count to avoid scalloping into visible beads.
    `ALONG_OVERLAP` sets smoothness; `TIER_SPACING` only buys back sprite count.
  - **The band is NORMAL blend, the halo is ADD.** Additive light on bright gold
    desaturates straight to white, so the band is opaque colour sitting in a dark
    baked groove. That groove is doing colour work, not just depth — remove it and
    the hue goes pastel. The band's brightness barely moves (`BAND_MIN`): pulling a
    tint's *value* down turns gold to olive, so the **halo** carries the pulse.
  - **The groove is a baked capsule chain, not a stroke.** A thick
    `strokeRoundedRect` serrates where the corner arc meets the straights, and
    stretched nodes jut out as wings on a tight corner. Discs plus bridging quads,
    all opaque so overlaps don't compound, in one Graphics.
  - **One `UPDATE` hook** drives everything. It replaced 80 per-bulb tweens, so a
    board scene runs 5 tweens with it on and 53 with it off. Never tween nodes
    individually, and don't reach for a shader — the game is `Phaser.AUTO` with no
    pipelines, so a fragment shader would strand the Canvas fallback.

  Colour comes from per-theme hue arcs (`rgbHueFrom`/`rgbHueSpan`/`rgbSat` in
  `theme.ts`), narrow on the rose/gold themes so the ring never fights a theme's
  identity. `rgb.test.ts` guards the arcs, the seam-free wrap and the even
  arc-length spacing. Players can switch it off (Settings → RGB Marquee), which
  restores the original gold/rose bulb ring exactly.
- **The daily race board is SALTED and NORMALISED, and both are load-bearing.**
  Until 2026-08-04 the board was `mulberry32(seedForKey(day))` — a plain FNV-1a
  hash of the date string, so any future day's board could be generated and
  solved in advance by anyone (the repo's visibility was never the issue; the
  same function ships in the bundle). Two mechanisms now sit in front of it, in
  this order, and the order matters:
  - **The salt** (`core/racesalt.ts`, migrations 0023/0024) — a random string the
    server mints only once a day has OPENED and refuses to hand out before then.
    Mixed into the seed, it makes the board unknowable in advance rather than
    unsolvable. `SALT_ACTIVE_FROM` in `core/endless.ts` and `v_salt_from` in
    0024 are **the same switch on two sides of the wire — change one, change
    both.** A score must carry the day's salt or the guard refuses it, which is
    what stops a stale cached client posting an old-board score.
  - **The normalisation** (`core/boardpick.ts`) — deterministic rejection
    sampling that walks `day`, `day#1`, `day#2` … until a board scores inside
    [8000, 16000] on the greedy sim. Raw day boards spanned **6.1x** (2,940 to
    18,060), so "how big a score is possible today" was mostly the hash's
    decision, not the player's; normalised it is 1.9x.
  ⚠️ Normalisation couples the chosen board to `sim.playEndless`, and therefore
  to Board mechanics, scoring and the Plinko trigger. `boardpick.test.ts` pins
  the chosen offsets as GOLDEN values. **A failure there means the race boards
  moved** — do not re-record it; ship the change behind a new activation date
  the way the salt shipped, so the handover lands on a day boundary for
  everyone at once.
- **Endless has a cheat code**, and it is meant to be there — a secret swipe
  pattern on the dead strip below the board mints a free "mega win", each one
  paying its own Plinko drop (`src/core/cheat.ts`). A run that fires it still
  posts to the daily race at what it ACTUALLY SCORED, clamped to the
  `ENDLESS_MAX_CHEAT_SCORE` backstop (300,000 — `core/endless.ts`).
  `recordEndless({ paced: true })` is the only place that clamp happens; don't
  route a cheat score around it. The cap is a **backstop, not a normaliser**
  (owner calls: 13,000 "pace score" → 100,000 on 2026-07-31 → 300,000 on
  2026-08-04). The old pace score replaced nearly every cheat run's real score
  with a flat substitute — the exact behaviour that was complained about. Now a
  single fire lands in the tens of thousands and posts honestly; what the
  ceiling bounds is a run that re-fires the move-less cheat indefinitely, which
  would otherwise own the board forever. `endless.pace.test.ts` guards the
  CONTRACT, not a recorded number: the ceiling must really clamp, must stay a
  ceiling and never a floor, and must sit above the best honest measured run
  but inside 10× it — a retune that walks it out of either band fails the
  suite. Accepted cost, stated in `endless.ts`'s header: a lightly-cheated run
  outranks most honest ones.
- **The endless board sits LOWER than the numbered board, and four constants are
  budgeted against each other.** `BOARD_Y` is the numbered-level seat; endless
  adds `ENDLESS_BOARD_DROP` so the TODAY'S LEADER strip can live *above* the
  board. Inside `GameScene` the seat is **`this.boardTop`, assigned in `init()`**
  (which runs before `create()`), never `BOARD_Y` directly.
  ⚠️ Piece placement, the mask, the frame, the RGB ring **and `xyToCell`'s hit
  test** all read it. A hit test that disagrees with the render by one row makes
  taps land on the wrong piece — near-unplayable, and it reads as a swap bug, not
  a layout one. If you move any of `ENDLESS_BOARD_DROP`, `ENDLESS_STRIP_Y`, the
  card row, or `STRIP_H`, **re-derive `CHEAT_ZONE_TOP` too** — it has no anchor
  below the board any more except the standing brief, which moves with the board.
  Verify by round-tripping `cellToXY` → `xyToCell` for all 64 cells.
  Anything seated *below* the board reads `boardTop` for the same reason. The
  standing brief did not, until 2026-08-04: it was written `988 +
  ENDLESS_BOARD_DROP`, which applies the endless drop on **every** level, so on a
  numbered level it fell 84px past its own board and printed straight through the
  JACKPOT deck and charge bar at 1086 (owner screenshot). A literal that happens
  to equal the endless seat is not the endless seat.
- **LevelSelect's header is a budgeted band, not four literals.** The title row
  (`HEADER_ROW_Y`), the LEVEL RACE marquee (`RACE_STRIP_Y`, `RACE_MARQUEE_H`
  tall) and the grid mask sit in ~130px, and the mask top is **derived** from the
  strip. It went wrong the obvious way: the stash door arrived as a 52px chip
  with a count badge hanging 29px below its own centre, so its true reach was
  implicit and it landed on the marquee's top edge with one pixel to spare. The
  door is now a pill with the count *inside* (`STASH_DOOR_W/H`, exported so this
  screen can budget against them) — a control next to something else should have
  a real bounding box, not an overhang. Re-derive the whole band if you add
  anything up here; don't seat it against a fresh number.
- **A control next to the board must arm on `pointerdown`, not fire on
  `pointerup`.** Phaser dispatches `pointerup` to whatever is under the finger at
  *release*, however far away the press began — so a swipe off the board fires
  any control it happens to end on. `addRaceStrip` (`view/leaderboardpanel.ts`)
  therefore only opens if the gesture *started* on it. `ui.ts`'s `buildPressable`
  still has the bare `pointerup` **on purpose**: every other control sits where
  you tap, and only the race strip abuts a swipe surface. Spacing alone can never
  fix this class of bug. The LevelSelect chapter ribbons (doors to the trophy
  showroom) sit on the grid's scroll surface and use the level chips' own guard —
  `dragMoved` + viewport-clipped hit area — for the same reason.
- **Leaderboard trophy badges are DERIVED, never submitted.** The tier glyph next
  to a name is `floor(level_progress.cleared / 10)` mapped through `TROPHY_TIERS`
  (`core/trophies.ts chaptersFromCleared` — deliberately the only place that
  coupling lives). No badge column exists anywhere: the race boards batch-read
  `level_progress.cleared` (world-readable, and 0007's monotonic guard is what
  makes a derived badge trustworthy) and decorate client-side, degrading to an
  unbadged board when the read fails. Changing `cleared`'s semantics moves every
  badge; a new writable "flair" column would need guard-trigger + two-phase
  treatment, which this design exists to avoid. Chapter trophies themselves are
  claimed once per chapter into `save.chapterRewards` (`core/trophies.ts`,
  award-first, unioned on merge) — the SAME list the showroom renders, so the
  purse latch and the trophy shelf can never disagree.
- **`splitPendingBoosts` is shared, and that is the point.** The stash panel
  promises "these go in next level" and the level start consumes — both call it,
  so they cannot disagree. Two copies of the cap rule would diverge the first
  time a cap moved, and the symptom is a player watching a promised boost fail to
  appear. Boost *choice* is expressed by **reordering `pendingBoosts`** (the
  queue is consumed from the front) and *exclusion* by `heldBoosts`, a set of
  TYPES. Neither adds a second inventory to keep in sync across grants, spends
  and device merges. **A held type frees its slot rather than wasting it** —
  setting a Jackpot Chip aside must not silently cost one of the three.
- **`BOOST_META` (`core/inventory.ts`) is the only place a boost is named.** The
  free prize table (`daily.ts`) and the paid one (`store.ts`) both read from it,
  and `inventory.test.ts` pins them. Three different things were once called
  "+5 MOVES" — the free slots prize, a 40-chip store boost, and a 30-chip
  in-level shelf item — and a player reasonably concluded he was being charged
  for his own winnings. ⚠️ The HELPER shelf items are **not** boosts: they act on
  the level being played, so `BLAST` is deliberately not `DICE BOMB`. Only one
  free-substitution mapping is honest (`moves5 ← extraMoves`); the negative cases
  carry tests.
- **`beforeinstallprompt` is captured, not observed.** `core/install.ts` takes
  custody so the game can offer its own button (`view/installsheet.ts`); the
  passive listener that used to sit in `main.ts` is gone. ⚠️ **iOS exposes no
  install API at all** — never add a one-tap path there. The iOS half is an
  illustrated Share → Add to Home Screen guide, tailored per browser, and
  `install_result` with outcome `guided` is the closest signal Apple permits.
- **The resume guard reloads the page, so its false-positive guard is critical.**
  `core/resumeguard.ts` watches for the game loop failing to advance after a
  resume. `main.ts` stops the loop on purpose while hidden, so **a hidden page
  has a frozen frame counter by design**, and Android fires `focus` on
  still-hidden pages — every check re-confirms visibility *at the moment it
  runs*. ⚠️ Its nudge calls `sleep()` **before** `wake()`: Phaser's `wake()` opens
  with `if (this.running) return`, so a loop with `running === true` and a dead
  requestAnimationFrame can never be woken by `wake()` alone.

## Run it

```sh
npm install
npm run dev      # vite
npm test         # vitest run
npm run build    # tsc && vite build
```

Tests are colocated: `src/core/*.test.ts` (board, merge, hazards, endless,
plinko rate, slots rate, cheat, endless pace, rgb). Run them — the game logic has
real coverage.

`slots.rate.test.ts`, `plinko.rate.test.ts` and `endless.pace.test.ts` are
**economy guards**, not unit tests: they measure what a machine actually pays
against what it charges, and what the board actually scores against the number
the race posts. If you retune a strip, a price, a paytable or the cheat
ceiling, the recorded numbers in them are what you re-derive — never what you
edit to make green.

## Layout

| path | role |
|---|---|
| `src/main.ts`, `src/config.ts` | entry + tunables |
| `src/scenes/` | Phaser scenes — Boot, Home, Game, LevelSelect, Store, Slot |
| `src/core/` | game logic + its tests — board, merge, levels, endless, daily, slots, hazards, analytics, push, cheat, rgb |
| `src/core/inventory.ts` | canonical boost names (`BOOST_META`) + the stash model — see the note above |
| `src/core/install.ts` | "add to home screen" custody; the platform split lives here |
| `src/core/resumeguard.ts` | recovers a game loop that never restarted after a resume |
| `src/core/trophies.ts` | chapter trophies — catalog, purse table, tier ladder, the claim latch (see the note above) |
| `src/view/stash.ts` | the stash panel + its two doors (Home line, LevelSelect `🎁 N` pill) |
| `src/view/installsheet.ts` | the install sheet — DOM, so the iOS guide can point at real browser chrome |
| `src/view/raceunlockcard.ts` | the one-time DAILY RACE UNLOCKED reveal |
| `src/view/showroom.ts` | THE SHOWROOM trophy case — doors on the LevelSelect chapter ribbons |
| `src/view/trophyceremony.ts` | the chapter-complete ceremony + the one-time catch-up card |
| `src/view/platekit.ts` | the material + lighting law (E7): plates, spotlight scrims, `goldFace` — `ui.ts` re-exports the legacy names |
| `src/view/rgbmarquee.ts` | the RGB cabinet chase — see the note above before touching it |
| `src/view3d/stage.ts` | the only three.js usage |
| `supabase/migrations/` | `0001_saves` → `0024_race_board_salt_enforced` |
| `scripts/verify-rls.sh` | RLS audit — run after any migration |
| `scripts/send-push.mjs` | push sender |
| `scripts/gen-icons.mjs` | `npm run icons` |

## Supabase

Migrations are numbered and sequential. Use the **`supabase-migrations` skill**
for schema, RLS, and migration work — it covers the two-phase rule that matters
here, since cached PWA clients keep running old code after a deploy.
Verify with `scripts/verify-rls.sh` afterward.

**Applying them.** Run from the repo root — the project ref lives in
`supabase/.temp/`, so anywhere else these fail with `Cannot find project ref`
and the link is not actually broken:

```sh
supabase db push --dry-run --include-all   # always look first
supabase db push --include-all             # apply
```

`--include-all` is not optional. A migration numbered below the highest one
already applied gets skipped with only a hint buried in the output — that is
how `0009` sat unapplied under `0019` without anyone noticing.

**CI never applies migrations.** The workflows only build Pages, send push, and
prune events. So applying a migration to production and merging it to `main`
are two separate acts, and *the repo does not describe production until both
have happened*. Land migration branches promptly — a migration that is live but
unmerged is invisible to whoever looks next.

If a push reports `Remote migration versions not found` and suggests
`migration repair --status reverted <v>`, check whether your branch is simply
behind `main` before running it. It usually is, and marking an applied
migration as reverted re-creates exactly the drift above.

## Secrets

Web-push VAPID keys live at `~/.secrets/viva-maya/` — **pointer only, never
commit or paste key material.** Publishable client config belongs in
`src/config.ts`.

## Design docs

In this repo, all under `docs/`: `GAME_DESIGN.md`, `BUILD_OVERVIEW.md`,
`UI_COOKBOOK.md`, `ANALYTICS_AND_PUSH.md`, `CLOUD_SAVE_SETUP.md`,
`CLOUD_SAVE_GOOGLE_SIGNIN.md`, `GIFT_STORE.md`, `GO_LIVE_CHECKLIST.md`. For
schema and score security the authority is the migration header comments, not a
design doc — see the score-defence bullet at the top.

**There is no `Supabase_Architecture.md` or `Implementation_Roadmap.md`, and
don't recreate them.** Both sat at the repo root until 2026-08-03 and *neither
was about this game* — they were **Viva Ton**'s plan (ad revenue, a multi-chain
treasury, `wallets` / `ledger` / `game_sessions`, KMS signing). Viva Ton is a
separate product that was forked out of this repo and still has a branch here,
`feature/gift-store`; it is a different game with a different economy. **Never
merge that branch into `main`** — it renames `package.json` to `viva-ton` and
trails `main` by well over a hundred commits, so merging it would rebrand the
live game and revert most of it — and never delete it either; it is the fork's
history. (It reads as merge-worthy because this repo rebase-merges, so `git
cherry` marks it `+`. That signal is meaningless here.)
Nothing about Viva Ton belongs in this repo (owner's call, 2026-08-03).
The architecture doc described a backend that has never existed here:
there is no `supabase/functions/` directory, and its schema shares **zero**
tables with the twelve real ones. This file used to cite both — including a bullet
sending you to the architecture doc "before touching anything score-,
leaderboard-, or reward-related" — which is how an agent following these
instructions ended up reading a different product's crypto design. Moved to the
vault at `01_Projects/Viva_Ton_Web3/`.

Some comments still cite the moved paths, and that is fine — every one restates
its point inline, so nothing is lost by the path being gone:
`supabase/migrations/` 0002, 0006, 0007 and 0012 name `Supabase_Architecture.md`
for deterministic-replay validation (they each spell out "submit the move list,
replay the seeded board"), and `src/core/charms.ts`, `daily.ts` and
`leaderboard.ts` cite `docs/SOCIAL_AND_ECONOMY.md`. Applied migrations are
historical records — don't rewrite them to chase a link.

**Not in this repo — the private vault** (`CorruptFun/corrupt-brain-vault`).
`SOCIAL_AND_ECONOMY.md` (reward loops and the fairness "iron rules") and
`IN_GAME_PURCHASES.md` moved there 2026-07-30; the Web3 docs followed on
2026-08-03. **The actual Viva Maya roadmap lives there too** —
`01_Projects/Viva_Maya/RETENTION_AND_POLISH_ROADMAP.md`. It is product strategy,
so read it there and **do not copy it into this repo.**

Anything describing monetization, tokenomics, or unreleased strategy belongs in
the vault, not here — it is the one category this repo's visibility makes
expensive.

## Deploy

GitHub Pages. PWA via `vite-plugin-pwa` (Workbox) — a deploy invalidates
precached assets, so verify offline behavior after shipping. **Public repo.**
