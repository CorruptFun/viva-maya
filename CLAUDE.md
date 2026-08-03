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
- **The backend is server-authoritative by design.** Supabase validates game
  outcomes to prevent score manipulation — see `Supabase_Architecture.md` before
  touching anything score-, leaderboard-, or reward-related. Do not move
  validation to the client for convenience.
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
  paying its own Plinko drop (`src/core/cheat.ts`). A run that fires it posts to
  the daily race as a **pace score**: `recordEndless` takes `{ paced: true }` and
  clamps it to `ENDLESS_PACE_SCORE` — a top line worth chasing that a typical
  player beats about one run in seven, so it can never run away with the board.
  That clamp is the only place it happens; don't route a cheat score around it.
  The cap is measured, not chosen — `endless.pace.test.ts` re-derives it from the
  real board and fails if a tuning change puts it out of human reach.

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
the race posts. If you retune a strip, a price, a paytable or the pace ceiling,
the recorded numbers in them are what you re-derive — never what you edit to
make green.

## Layout

| path | role |
|---|---|
| `src/main.ts`, `src/config.ts` | entry + tunables |
| `src/scenes/` | Phaser scenes — Boot, Home, Game, LevelSelect, Store, Slot |
| `src/core/` | game logic + its tests — board, merge, levels, endless, daily, slots, hazards, analytics, push, cheat, rgb |
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

In this repo: `Supabase_Architecture.md` (schema + anti-cheat handshake) and
`Implementation_Roadmap.md`. Read the relevant one before changing economy or
security behavior.

**Not in this repo — the private vault.** `SOCIAL_AND_ECONOMY.md` (reward loops
and the fairness "iron rules"), `IN_GAME_PURCHASES.md`, plus the Web3 tokenomics
docs, moved to `CorruptFun/corrupt-brain-vault` on 2026-07-30. This repo is
public, and those are product strategy rather than code documentation. Code
comments in `src/core/charms.ts`, `daily.ts` and `leaderboard.ts` still cite
`docs/SOCIAL_AND_ECONOMY.md`; that path is gone, but each cite restates its rule
inline, so nothing is lost by not having it.

Anything describing monetization, tokenomics, or unreleased strategy belongs in
the vault, not here — it is the one category this repo's visibility makes
expensive.

## Deploy

GitHub Pages. PWA via `vite-plugin-pwa` (Workbox) — a deploy invalidates
precached assets, so verify offline behavior after shipping. **Public repo.**
