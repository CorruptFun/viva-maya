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
- **The board's FIRE is saturated colour on a dark ground, laid down in
  overlapping atoms — and each clause there is a bug that shipped in the first
  cut.** `view/firekit.ts` is the board's fire
  vocabulary — a ring of fire out of a blast (`fireRing`), a wall of flame
  standing in the play area while a MEGA chain runs (`blazeField`), and the
  tally burn that traces a region's perimeter white-hot and consumes it
  (`burnAway`). `megafx.ts` still owns the SCREEN; this owns the BOARD, so its
  layers are world-space (they must rattle with the board, the exact opposite of
  megafx's `scrollFactor(0)` rule) and the pure geometry lives Phaser-free in
  `core/fire.ts`, pinned by `fire.test.ts` — the same split as `core/rgb.ts` /
  `view/rgbmarquee.ts`, for the same reason.
  - **Hotter steps go MORE SATURATED, not paler** (`heatTint`). The obvious
    ladder — gold → bright gold → near-white, because hot fire is white — is the
    marquee's desaturation trap wearing a different hat: additive near-white
    over a warm board renders as PALE GREY, and the first cut of the ring came
    out looking like flying paper shards. White heat is the GEOMETRY's job: it
    appears where atoms overlap and the additive sum clips. Colour is the tint's.
  - **A blast wears the colour of the piece that fired it** (`flameColor`, owner's
    call): a red 7 blows up red, a diamond blue, a bell gold. It reads
    `SYMBOL_TINT` — the same table the pieces are drawn from, never a second copy
    — and keeps only the HUE, because a piece tint is picked to read as a small
    object on a lit board and a fire is additive light on a dark ground. `bar` is
    the proof: a half-saturated navy, invisible additively until it is taken to
    full chroma. ⚠️ **Do not "fix" that by equalising perceived LUMINANCE across
    the six.** It looks like the right correction and it was tried: pure red is
    one of the darkest hues there is (luma 0.21, below the navy's 0.26), so any
    rule that lifts the blue lifts the reds harder — cherry came out salmon and
    the 7 coral. `fire.test.ts` pins the reds against exactly that regression.
  - **Every fire lays a dark ground under itself first** (`soot`/`sootSlab`).
    Golden Hour seats the board on a cream wash with near-white cushions, so
    adding orange clips every channel and the fire disappears. This is the
    marquee's baked groove and megafx's `stageDim`, a third time. `burnAway`'s
    ash is a flat SLAB, not the radial `bgglow` the others use — a radial is
    thinnest at the rim, which is precisely where its burning frame lives.
  - **Atoms overlap or they scallop.** Ring petals are laid at exactly `2πi/n`
    (a nearly-even ring parks its one odd gap on screen forever) and their count
    is DERIVED from `RING_OVERLAP`, never hand-picked — tune `flame` to change
    the density, not `petals`. Wall tongues overlap by `TONGUE_OVERLAP` and are
    forbidden from sharing a flicker phase with a neighbour (`MIN_PHASE_GAP`,
    measured the short way round the cycle — a linear test waves through exactly
    the 0.02/0.98 pairing it exists to catch): a wall whose atoms breathe
    together is a strobing rectangle, not fire.
  - **A ring blooms, it does not fly apart.** Travel and growth are budgeted
    against each other (~2.6× out, ~2.7× bigger). An atom count is fixed but a
    circumference is not, so a ring that launches from 0.1R to 1.0R arrives ten
    times sparser than it left and ends as a starburst.
  - `blazeField` is a **veil, never a curtain** — the board stays playable and
    every symbol readable through it, which is what caps its alpha; and its
    floor bed is held mostly inside the region, because GameScene seats the
    standing brief, the JACKPOT deck and the charge bar directly underneath.
  Wired to the beats that earn it: bomb + jackpot detonations, the MEGA finish,
  the gold rush from SUPER MEGA up (handle extinguished by `megaFinish`, exactly
  like `goldRush`), and a special's HERO BIRTH — an oversized ghost of the face
  being born, collapsing onto its cell. ⚠️ That ghost is a throwaway
  `add.image`, never a second `createSprite`: see the duplicate-sprite note
  below, which this would otherwise re-break for the third time.
- **Every screen shake slides the scene off its own edge, and `WASH_BLEED` is the
  only thing behind it.** `Camera.shake` translates the camera MATRIX (and
  `GameScene.update`'s trauma rattle scrolls the camera outright), so a reel
  detent, a blast or a thunderclap moves the WHOLE display list sideways for a
  few frames. The wash (`view/background.ts` `washBase`) is the only opaque layer
  down there, and it was filled at exactly `0 → DESIGN_W` until 2026-08-11 — so
  those frames exposed a full-height strip of the game's CLEAR colour. That
  colour is `#fff9ec` (`main.ts`), which is Golden Hour's `washTop` and a warm
  cream on **every** theme, so on Rose Midnight / Neon Vegas it read as a **white
  line tearing off the side of the cabinet on every hit** (owner video; measured
  at 5–6 device px, alternating sides with the shake). ⚠️ It is invisible on any
  device running the 3D room, which covers the gap — i.e. it only shows on the
  hardware taking the 2D fallback, which is the path you are least likely to be
  testing on. The wash now bleeds `WASH_BLEED` past all four visible edges (the
  vertical half was always there; **the horizontal half is the fix**), the
  camera's own background colour is pointed at the theme as a second floor
  (it fills in SCREEN space, so a shake provably cannot move it), and
  `addFocusScrim`'s +400 overscan is now on both axes for the same reason. The
  bleed is **not a free knob** — the wash is a gradient and the rect it fills is
  what the stops map onto, so growing it re-maps the ramp. Budget a louder effect
  against the 60 that is there (~4× the loudest excursion in the game) rather
  than raising it by reflex. Verify by offsetting `cameras.main.scrollX` ±14 and
  looking at the outermost column, not by eye during a spin.
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
- **The daily streak pays on TWO rhythms, and the big one has no claim latch on
  purpose.** `CHECKIN_CHIPS` (`core/daily.ts`) is a 7-day chip ladder that RESETS
  every week — it answers "how far into this week are you", so day 8 pays what day
  1 pays. `STREAK_REWARDS` is the other half: a named purse at 3/7/14/30/60/100
  consecutive days, repeatable once per streak RUN (break it, climb back, day 7
  pays again — a ladder you can only climb once is dead the day it breaks, and
  re-farming is self-punishing because breaking forfeits the 60/90/150 end of the
  check-in week). A third thing, `milestoneDue`, is the every-5th-day DOUBLE and is
  **not** the ladder — two things in one file were nearly both called "milestone".
  ⚠️ Unlike `chapterRewards` / `championWeeks` / `installRewardClaimed`, the rung
  grants real chips + a boost + free spins with **no latch of its own**, because it
  is paid *inside* `advanceDailyRitual`, in the same statement block that writes
  `lastSpinDate`. **The day latch IS the claim latch.** Lift the grant out to a
  caller for convenience and a caller that runs twice (a retry, a double-tap, a
  re-entered scene) pays the purse twice while the streak moves once. Free spins
  there bypass `FREE_SPIN_DAILY_CAP` deliberately (a rung is not the farmable
  source that cap bounds) but still honour the BANK cap, and the grant reports what
  actually stuck so the card never names spins the player didn't get.
  ⚠️ `streak` + `lastSpinDate` now merge by **recency**, not by progress
  (`pickStreak` in `core/merge.ts`) — they are `pickHandle`'s twin, not a
  magnitude. Before 2026-08-24 they rode the progress winner, so opening a
  further-along tablet silently reset a 30-day streak to 3. MAX is the obvious rule
  and is **wrong**: a device untouched for a fortnight still holds its old count
  and would resurrect a dead streak. `bestStreak` is the opposite — a RECORD, so it
  merges by MAX like `lightningBest`. The two need opposite rules and both are
  pinned by `merge.test.ts`.
  The forward-looking copy is the feature, not the purse: the Home flame badge and
  the cabinet subtitle both name the NEXT rung and its distance
  (`nextStreakReward`), because a reward discovered only by receiving it cannot
  make anybody come back. `?streak=N` (DEV) opens the card for any rung — its plate
  is **measured** from the wrapped footer line, since that string is the longest on
  the card and hung 20px off the plate until it was budgeted rather than guessed.
- **A chip event is a ROW, not a branch — and its window closes when the season does.**
  `core/chipevent.ts` holds every time-boxed multiplier on the level-win purse (the first is
  DOUBLE CHIPS WEEKEND, 2026-09-04 → Monday 2026-09-07). `finishWin` asks `eventChipReward` what
  a win pays and never learns why; the Home live card and the win-card tag read the same row.
  `until` is **derived** from `weekEndsAt(from)` — Monday midnight in RACE_TZ, the instant the
  endless board and the weekly totals reset — never a hand-typed ISO end, so the promo and the
  race cannot disagree about when the weekend is over. The multiplier rides the FINAL purse,
  §G4 replay discount included, and touches nothing else (quests, chapter purses, storm, champion
  purse and endless are all priced against their own faucets). Rows are append-only so a spike in
  `level_win.chips` stays datable; `chipevent.test.ts` refuses overlapping windows. To run a new
  one, add a row with a future `from` — a client that has the code is not yet "in the event".
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
- **The install REWARD pays on the first standalone open, not on the install
  tap** — and that is forced, not a preference. Apple fires no install event, so
  a later `app_open` with `standalone: true` is the only evidence an install
  happened; paying the tap would either pay iOS players for a tap that installed
  nothing or exclude them from the offer entirely, on the one platform where
  installing is hardest *and* is the sole route to a web push.
  `claimInstallReward` (`core/install.ts`) owns the standalone + already-claimed
  checks and grants award-first per the economy's iron rule 4 — the latch
  `save.installRewardClaimed` is unioned on merge, because losing it to a
  progress-winner merge re-pays the purse. The JACKPOT CHIP rides
  `pendingBoosts`, which endless never consumes, so iron rule 2 (the race stays
  boost-free) is untouched. ⚠️ `install_offer_shown` fires at the banner's
  **mount**, not when it is scheduled: the banner self-destructs after 14s and
  on scene change, both silently, so before it existed "few `install_result`s"
  was equally consistent with *nobody saw it* and *everybody ignored it* — two
  problems with opposite fixes. And `onInstallStateChange` must stay subscribed
  (HomeScene): Chromium's `beforeinstallprompt` routinely lands after Home's
  `create()`, and `main.ts` has already `preventDefault()`ed the browser's own
  install bar, so capturing it and then showing nothing is strictly worse than
  never capturing.
- **The game sends AT MOST `DAILY_SEND_CAP` (three) notifications per device per race day, and
  that ceiling is a promise in the product, not a preference.** Five sends (`scripts/send-push.mjs`:
  the house gift, the quest slate, the evening board, the streak last call, the Sunday season) ride
  two opt-in categories (`week_race` from 0011, `daily_play` from 0025). New REASONS to notify (the
  jackpot-wheel and next-level hooks, `jackpotWinsAway`) ride the existing sends as better
  SENTENCES — a new kind of alert is a copy branch and a slot in `send-push.mjs`, never a cron.
  Every player who ever tapped REMIND ME did so against a card printing that number
  (`view/pushoptin.ts` `VOLUME_RULE`), so the count of *kinds* may grow and the count of
  *notifications* may not. The bound is a per-race-day COUNTER (migration 0028) plus a two-hour
  minimum gap, checked on every send; a device that keeps ignoring nudges **backs off** to every
  third day, then weekly, then nothing (`backoffAllows`). `pushcadence.test.ts` pins all of it. A
  bug here is invisible from inside the game — nobody reports "I got two notifications", they switch
  notifications off permanently — and the only trace is a subscription count that quietly stops
  growing. The timetable and the two outages it has had are in the "sender nudges up to three
  times a day" bullet further down.
  ⚠️ The `--drop` and `--daily` activity reads **fail in opposite directions on purpose**: `--drop`
  fails CLOSED (without the answer its whole audience definition is gone and it degrades to a 9am
  blast at people who are already playing), `--daily` fails OPEN (it has shipped since 0011 and
  losing an evening to a transient read failure would be a regression caused by a feature meant to
  add reach).
  ⚠️ `--dry-run` prints the HOOK NAME, never the body, for a message built on private data. A
  leaderboard rank is already public; a **streak count and a jackpot meter are not**, and this
  repo — with its Actions logs — is public.
  ⚠️ A tapped notification opens `./?from=push-<mode>` (sender `notificationUrl`), which the
  client reports as `app_open`'s `from` prop and then strips. `public/push-sw.js` must treat any
  `./?from=` target as the SAME PAGE — focus, never `navigate()`: navigate is a reload, and an
  endless run is deliberately not resumable. The prefix lives in three copies (sender, service
  worker, client allow-list); they move together or a mode's attribution silently reads zero
  (`pushcadence.test.ts` pins the sender↔client pair and names the SW copy in a comment).
- **The HOUSE GIFT is seeded from the DAY ALONE, and that is what lets a notification name it.**
  `core/bonusdrop.ts` pays one surprise a day, claimed on Home. Because the roll takes the race day
  key and nothing else, the sender composes the message once from a byte-identical copy of the table
  and the player finds *exactly* that gift when they arrive — "your Jackpot Chip is on the table" is
  an appointment where "come back" is a request. ⚠️ It is therefore globally predictable, and here
  that is harmless: a gift is not a contest, and "Thursday is Vault day" is a reason to be here on
  Thursday. **Don't reach for `core/racesalt.ts` to "fix" it** — salting would cost the one property
  the feature is built on to close a hole that does not exist. (On the race BOARD foreknowledge *is*
  an advantage, which is why the salt exists there. The two cases look identical and are opposites.)
  The claim is **award-first with the day latch written in the same statement block as the payment**,
  exactly like `advanceDailyRitual`'s streak purse — the day latch IS the claim latch, so a card
  force-quit through keeps every chip and a re-open re-offers nothing. `bonusDropDay` merges by **MAX
  of the date string**, a third distinct rule in `merge.ts`: not `pickStreak`'s recency (that resolves
  fields which may legitimately go DOWN; a claim latch may not) and not a union (it holds one day
  because nothing ever reads a past one). It rides the RACE calendar, not `daily.ts todayKey` — the
  sender runs in CI and has no idea what a player's local clock says. The table is budgeted as a SIDE
  dish — ~23 chips/day against the check-in ladder's ~56 — and weighted toward free spins and boosts,
  which cannot be spent without playing. `bonusdrop.test.ts` pins the budget and the sender parity;
  **retune by moving weights, and re-derive those numbers rather than widening the bounds to make a
  richer table green.**
- **Daily quests are the game's only CLOSED reward loop, and every goal must be
  intent-completable** — nothing luck-gated, and `run_board` may never read a score (scores belong
  to the race's defence story). `core/quests.ts` draws three goals off `<day>#quests` on the RACE
  calendar (the HOUSE GIFT's rule, for its reasons: predictable, and deliberately unsalted), and
  pays each with the claim latch written in the same statement block as the chips — a grant is a
  RECEIPT, never an offer, so no card may gate it. ⚠️ The slate merges by its OWN rule
  (`mergeQuests`): same day → per-goal MAX progress + UNION of claims (SUM is not idempotent
  across repeated reconciles and pays itself out); different days → the later slate wins whole,
  because a claim is a fact about a day, not about a player. Signals fire beside the analytics
  track calls (`level_win` / `slots_spun` / `endless_end`, GameScene + SlotScene); replays DO
  count (a player who cleared all content must not be locked out of their own quests, and the
  farm is bounded by the ≤70-chip daily ceiling `quests.test.ts` pins). The quest CARD gates on
  the endless unlock — a pre-unlock slate can never finish (`run_board` needs the race) — and
  that gate is the surface's, deliberately not the core's.
- **Home is one dominant PLAY, the rose ENDLESS hero, a badged icon rail, and at most ONE live
  card.** The five old notices collapsed into `view/livecard.ts` — an ordered list of PURE providers
  where the first non-null wins. Adding a notice to Home means adding a PROVIDER in priority order,
  never a new pill or a second card; a provider reads state and returns copy, and must never write.
  The ENDLESS hero (`addEndlessHero`, `view/leaderboardpanel.ts`) is the mode's LAUNCHER — the rose
  plate under PLAY, live standings sub-line, dimmed "unlocks at level N" signpost pre-unlock — and
  the rail's 🏆 RANKS tile is the one leaderboard DOOR: the standings panel behind it carries all
  three boards as tabs (TODAY / THIS WEEK / LEVELS). Don't re-add a stash card, a "board not run"
  notice, a locked-race floor or a RACE tile — the hero and the badged 🎁 STASH door say each of
  those permanently, and two buttons for one destination is the exact clutter the 2026-08-26 owner
  pass removed. Every seat below the hero is DERIVED from the named-constant block at the top of
  `HomeScene.ts` — re-derive the band when adding anything, don't seat it against a fresh literal
  (LevelSelect's header rule, for the same reason).
- **The push opt-in gets ONE ask per install, ever, and `pushOfferDue` is what
  spends it.** `Notification.requestPermission()` is one-shot: a denial is
  permanent, the browser never re-prompts, and the player has to dig through site
  settings to undo it. So the real prompt is only ever reached by tapping REMIND
  ME on the opt-in card (`view/pushoptin.ts`) — a soft ask, offered once, at one
  of TWO qualifying moments sharing the single latch: the Home visit after a
  player's FIRST daily race (the NEVER MISS A BOARD copy), or — for the level
  players who may never race — after `PUSH_OFFER_LEVEL_WINS` (5) level wins,
  i.e. right after the first JACKPOT wheel has paid (the A GIFT EVERY MORNING
  copy). That threshold is a deliberate literal, NOT an import of
  `JACKPOT_GOAL`: a jackpot retune must never silently move a
  permanent-permission gate. Never fire the browser prompt on load, and never
  widen the gate for reach: `pushOfferDue` (`core/push.ts`, `push.test.ts` pins
  every branch) refuses before either moment, on an iPhone outside an installed
  PWA, and when the browser has already decided — each of those is a case where
  the card would burn the ask for nothing. ⚠️ The one-time latch (`save.seenPushOffer`) is set on the card's way
  OUT, not on render, unlike `seenRaceUnlock`: a reveal spends itself by being
  seen, an offer spends itself by being *answered*, so a transient network
  failure keeps the retry alive instead of costing the player the feature. The
  Settings → Reminders switches stay as the last door for everyone who says
  no; every door fires the same three analytics events, split by a `surface`
  prop (`card` race copy · `card_leveler` morning-gift copy · `settings`)
  rather than new event names — the dashboard views hardcode the names they chart
  (`name in (...)` across migrations 0014/0015/0021/0022), so a *new* event is
  invisible until a new migration ships and fails silently, whereas a new prop
  rides along for free.
- **The sender nudges up to three times a day, the bound is a COUNTER, and the
  HOME CLOCK picks the send — never the cron.** `scripts/send-push.mjs` has five
  modes in four slots on the home clock (`SLOTS`, America/Edmonton): the house
  gift 08:00–12:00 (`--drop`), the quest slate 12:00–16:00 (`--quests`), the
  board 16:00–19:00 (`--daily`; the Sunday season takes that slot), the streak
  last call 20:00–23:30 (`--laststand`), and quiet hours otherwise.
  `endless-push.yml` is ONE hourly cron running `--auto`; each run asks the
  clock which slot it is in and skips every device that slot already reached
  today (`sentInSlot`). All four slots land on the SAME race day key, so
  "three a day" means three per board.
  ⚠️ **It used to be five fixed-hour crons, and GitHub cannot keep time.**
  Measured 2026-08-26 → 09-03 on this repo, the crons ran 2.4 to 10.9 hours
  late — every run green — so the ~9pm last call fired at 1:40–2:00 AM on the
  NEXT race day, said "your streak ends at midnight, in 22 hours", and (0028
  not yet applied → one-a-day fallback) spent that phone's whole day on it. The
  owner's report was "the only notification I have ever seen is the race
  ending one". Never schedule a mode by cron hour again; a manual real send
  outside its slot needs `--force`, and `--dry-run` may run any mode any time.
  ⚠️ **A migration that ships tolerated is a migration that ships unapplied.**
  0028 merged 2026-08-26 with a sender that degrades to one-a-day without it,
  and sat unapplied for eight days while every run logged the fallback warning
  in stderr. A tolerated migration needs a loud line in the summary, not a
  warning nobody greps for; and "apply before merging" in a commit message is
  not a step anyone runs.
  ⚠️ **A subscription row is stamped with `user_id` at registration and never
  again**, so a device that subscribed signed-out (or signed in later, or on the
  other origin) is anonymous forever — and to the sender an anonymous row has no
  streak, slate, meter or board row, so every weekday send holds it back as
  "no news". One of four live subscribers sat there. `syncPushIdentity`
  (`core/push.ts`, called from `cloud.ts`'s auth listener) re-registers once per
  device per account and restores any category the player had switched off,
  because 0025's ON CONFLICT resets both to on. Two things are load-bearing:
  - **The number is printed to players.** `VOLUME_RULE` (`view/pushoptin.ts`) is
    the sentence every subscriber tapped REMIND ME against, and it names
    `DAILY_SEND_CAP`. Change one, change both — and it has to be a bound
    something REFUSES to exceed (the per-race-day counter in migration 0028),
    never a description of how the crons currently work out.
  - **⚠️ The previous bound was "one a day by disjoint audiences", and it
    silently delivered NOTHING for two days.** `--drop` took `away >= 2` and
    `--daily` took `away === 1`; those look like a partition of everybody and
    leave out `away === 0` — the player who opens the game *every* day, which
    was all four subscribers. Every run was green and logged
    `4 opted in · 4 held back · 0 due`, which reads exactly like a healthy quiet
    evening; the session that shipped it recorded the quiet as correct. The fix
    is `dueForMode`, and the guard against a repeat is a **total** test (a
    player in an ordinary state must match *some* weekday mode) plus the
    **away-histogram** now on every run's log line — `away 0:4` beside
    `4 held back` is the tell. Per-branch tests cannot catch a hole *between*
    branches. `--explain` prints the per-device decision when you need it.
  Modes ride the two existing categories (`week_race` / `daily_play`), so
  Settings still has two switches and no third one is owed.
- **The resume guard reloads the page, so its false-positive guard is critical.**
  `core/resumeguard.ts` watches for the game loop failing to advance after a
  resume. `core/apploop.ts` stops the loop on purpose while hidden, so **a hidden
  page has a frozen frame counter by design**, and Android fires `focus` on
  still-hidden pages — every check re-confirms visibility *at the moment it
  runs*. ⚠️ Its nudge calls `sleep()` **before** `wake()`: Phaser's `wake()` opens
  with `if (this.running) return`, so a loop with `running === true` and a dead
  requestAnimationFrame can never be woken by `wake()` alone.
  Its `boardState` field reads `document.body.dataset.vegas`, which
  `GameScene.publishState()` writes **unconditionally** — that used to sit behind
  `import.meta.env.DEV`, so every production stall reported `boardState: ""`. If
  that field goes blank again, the DEV gate has grown back.
- **Sleeping the loop is one event; waking it is three, and that asymmetry was a
  real freeze.** `core/apploop.ts` owns the anti-drain sleep. It sleeps only on
  `visibilitychange`→hidden, but wakes on `visibilitychange`, **`focus` and
  `pageshow`**, because a phone can foreground an app without firing a visibility
  change (Android's notification shade / split screen / some launchers; an
  installed iOS PWA through the app switcher). `visibilitychange` alone was the
  only wake trigger until 2026-08-06, and it measurably wasn't enough: 41
  `resume_stall` events across 3 devices, **every one** reporting
  `running: false` on a page the watchdog had already confirmed visible —
  i.e. the game came back frozen. Two rules keep the fix from being worse than
  the bug, and `apploop.test.ts` pins both: **never wake a hidden page** (Android
  fires `focus` on hidden pages; waking there throws away the whole battery win)
  and **never sleep on `blur`** (a page can lose focus while fully visible, and
  sleeping there freezes a board the player is looking at). `running` is the only
  real flag — Phaser 3.90's TimeStep has **no `sleeping` property**, so a
  diagnostic reading one is reporting a constant `false`.
- **The game answers on TWO origins, and `corrupt.solutions` is a PROXY of Pages —
  not a second deployment.** `corruptfun.github.io/viva-maya/` is the legacy
  address; `corrupt.solutions/games/viva-maya/` is canonical and is what every
  invite link mints (`view/invite.ts`; the trailing slash is load-bearing). A
  corrupt.solutions response carries `server: Vercel` **and** GitHub's own
  `x-github-request-id` passed through — one deployment, two origins, identical
  bytes. ⚠️ **That is why the fix is not a redirect:** a 3xx on the Pages origin
  would be fetched and re-served by the proxy, pointing the canonical address at
  itself. The handoff therefore lives in the bundle *both* origins serve, and
  `handoffTarget` (`core/originmigrate.ts`) decides by **hostname** which copy it
  is running as. **That gate is the entire safety argument** — answer it wrong and
  the canonical origin redirects to itself forever, for everyone at once, which is
  far worse than the storage split it fixes. `originmigrate.test.ts` pins it, and a
  sessionStorage latch bounds even a wrong answer to one hop per tab.
  Storage does not cross origins, so each one has its own save, device id,
  referral stash, settings, install and push subscription — a real invite was lost
  exactly this way (captured in one context, signed in from another), and one human
  counts as two devices. The handoff travels in the URL **fragment**, never the
  query string, so a save never lands in a Vercel or GitHub access log. On arrival
  it **never overwrites** an existing key and merges a colliding save with
  `mergeSaves` (monotonic), which is what makes a hostile fragment boring rather
  than dangerous; there is deliberately **no `document.referrer` check**, because a
  browser that strips the referrer would silently cost a real player their save.
  Two refusals are deliberate and must stay: an **installed PWA** is never
  redirected (navigating a standalone window off-scope ejects it into the browser
  on iOS, breaking the app the player installed), and an **oversized payload keeps
  the player put** rather than hopping without it. Measured worst case is ~14k
  chars against a 30k cap. `app_open`'s **`host` prop** is what makes any of this
  observable — before it, "how many players are still on the legacy address" could
  not be asked at all.
- **A waiting service worker is APPLIED at boot and only OFFERED mid-session, and
  that asymmetry is the whole design.** The PWA is `registerType: 'prompt'`, and a
  prompt players can decline forever is not an update mechanism: measured
  2026-08-07, 47 devices active over three days sat on **13 distinct builds with
  only 6 on HEAD**, some running a bundle 12 commits old the same day. So
  `onRegisteredSW` finding `registration.waiting` — a worker already waiting
  *before this page loaded*, meaning the player just opened the app and nothing is
  in progress — now applies it silently, while `onNeedRefresh` (it went waiting
  *during* play) still shows the toast. ⚠️ Never collapse the two into
  `registerType: 'autoUpdate'`: that reloads whenever the worker lands, **including
  mid-cascade**, and `levelresume` only snapshots a SETTLED board with endless
  excluded entirely — so the reload it saves you is paid for with a lost level.
  The silent path is gated by `claimAutoUpdate` (`core/swupdate.ts`, pinned by
  `swupdate.test.ts`): a boot window, and a **sessionStorage** latch spent on the
  way IN. The latch's storage is load-bearing — it must survive the reload it
  authorises (or a worker that installs but never takes control reload-loops the
  app with no way out) and die with the tab (or the next launch can't update). A
  blocked-storage or unusable-clock read falls back to the toast, never guesses.
- **`this.sprites` is keyed by piece id and `createSprite` OVERWRITES — so a piece
  drawn twice is a permanent ghost, and the board hides it.** Two sprites for one
  id means the first is stranded: still parented to `pieceLayer`, still drawn, and
  no longer reachable from the map — so the clear path (retires by id),
  `swapBoard`'s teardown and `resyncSprites` (walks the model) are all blind to it.
  ⚠️ **It is invisible at rest.** A duplicated board sits perfectly superimposed and
  looks correct; the corruption only shows as the live set clears and the dead set
  stays put, so it reads as "symbols stacking up" *after* a big clear — worst with a
  jackpot chip or a deep cascade, because those expose the most orphans at once —
  and it cures on restart, which is the signature of a view-only leak over an intact
  model. Shipped twice now: `fireMegaWin`'s `board.plant` (46ebe47, four ghosts per
  fire) and then **every resumed level** dealing its board twice, because
  `buildPieceLayer` defers the deal on `wantsLevelIntro()` while `showGoalCallout`
  re-derived that condition and missed its `!resumed` term. `createSprite` now
  retires the outgoing sprite for an id, `showGoalCallout` *asks* `wantsLevelIntro()`
  rather than re-deriving it, and both reapers work off `pieceLayer` — the thing the
  player actually sees — instead of the map or the model. The invariant to check
  after anything that mints pieces: **live piece-sprites in `pieceLayer` == 64 ==
  `sprites.size`**, with none unmapped. `resyncSprites` reports the orphans it reaps
  on `resume_stall`'s `orphans` prop, so a recurrence surfaces without a player
  having to notice it by eye.
- **`GameScene.t()` must always settle, or the board is bricked.** `resolveLoop`
  awaits a chain of tween promises; one that never resolves pins `state` at
  `resolving` **forever** — no input, no error, no recovery but a force-quit.
  `tweens.killTweensOf()` calls `tween.destroy()`, and 3.90's `destroy()` nulls
  `callbacks` and calls `removeAllListeners()` **without dispatching anything** —
  no `onComplete`, no `onStop`. Since `settleSquash` calls `killTweensOf` on a
  board sprite on every single landing, `t()` resolves on `onComplete` **or**
  `onStop` **or** a deadline (`TWEEN_DEADLINE_SLACK_MS`), and a fired deadline
  sets `tweenStranded` so `resolveLoop` runs `resyncSprites()` — the model was
  never wrong, only the view. ⚠️ That deadline is a **Phaser** timer on purpose: a
  `window.setTimeout` would keep running while the app is backgrounded and tear
  down a cascade that was merely paused. The 64-tween deal-in has the same shape
  and the same kind of net (`DEAL_IN_DEADLINE_MS`).
- **A level in progress survives the page going away — and the rule that keeps
  that honest is "snapshot only on idle".** `core/levelresume.ts` stores the
  board, moves, score, objectives and per-level allowances so a reload doesn't
  cost the player their level (the resume guard reloads deliberately; iOS
  discards a backgrounded PWA's web view; the update toast reloads; things
  crash). Level 104 is 64 moves — losing 54 of them to an app switch is the
  difference between a game you keep and one you delete. ⚠️ The snapshot is
  written **only on a settled board** and **cleared the instant a move is
  spent**, so the only thing restorable is a position the player already reached
  and stopped at. Force-quitting mid-cascade to re-roll a refill or a Plinko drop
  finds nothing and loses the level exactly as before. **Any call site that
  snapshots mid-resolve turns this into a rewind button.** It is single-slot,
  its own localStorage key (never `SaveData` — that would sync a half-played
  board to another device), and endless is deliberately excluded: it seeds from
  the race board and posts a score, so a resumable run adds surface to the
  score-defence story for very little (an endless run is a free, unlimited-retry
  2-minute sprint). On restore, `resumed` suppresses what belongs to the START of
  an attempt rather than to `create()` — the `level_start` event (a resume emits
  `level_resume`, so win rates stay honest), `takePendingBoosts()` (**it
  CONSUMES**, and those boosts are already planted on the restored board) and the
  goal card.
  ⚠️ **Anything the player has already PAID for on this level must be in the
  snapshot, and spending chips does not move the state machine** — so the idle
  transition hook never fires for it, and those sites call `snapshotLevel()`
  themselves. `markerStake` is the one that bites: `placeMarker` spends the chips
  the instant the marker slides and the ending settles them, so dropping it would
  take up to 500 chips and then never pay the hand out — silently, because
  nothing left in the level would remember a bet had been placed. `grantMoves`
  (the single funnel for every bought move, helper shelf *and* continue offer)
  stores on the spot for the same reason. When a new per-level cost lands, the
  test to apply is "did the player pay for this, and would a reload make them pay
  twice or not at all?"
  ⚠️ **The same trap catches anything that LEAVES the level mid-resolve, and the
  storm walked straight into it.** `maybeStorm` fires at the tail of `resolveLoop`
  with `state` still `'resolving'`, so the scene is torn down before the idle
  handoff can store the board — and `spendMove` has already dropped the previous
  snapshot. The player came back to a level rebuilt from scratch: full moves, zero
  objectives, marker stake silently paid for nothing (player-reported 2026-08-09,
  "reset my level"). It now calls `snapshotLevel(true)` before leaving; that
  `settled` flag is **not** a general escape hatch — it asserts the cascade has
  provably finished, and passing it mid-cascade is exactly the rewind button the
  idle rule exists to prevent.
  ⚠️ And the guard is **two-directional**: `snapshotLevel` refuses to WRITE in
  endless, so `spendMove`'s `clearLevelSnapshot()` needed the same `!endless`
  test or endless and the storm could only ever DESTROY a numbered level's board,
  never restore one — which is how the first swap inside a storm (and any daily
  race played over a level left mid-play) ate it. Write and clear must agree on
  who owns the slot.
  ⚠️ Separately, the storm now **defers** rather than taking a board the player is
  about to finish with (`STORM_MIN_MOVES_LEFT` / `STORM_MIN_COLLECTS_LEFT` in
  `core/lightning.ts`). Deferring is free — the charge is only spent past the
  guard and persists in the save — so the storm arrives a board or a level later
  instead of on the move that would have won the level.

## Run it

```sh
npm install
npm run dev      # vite
npm test         # vitest run
npm run build    # tsc && vite build
```

Tests are colocated: `src/core/*.test.ts` (board, merge, hazards, endless,
plinko rate, slots rate, cheat, endless pace, rgb, fire, apploop, level resume,
bonus drop, push cadence). Run them — the game logic has real coverage.

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
| `src/core/bonusdrop.ts` | THE HOUSE GIFT — the day-seeded daily surprise the reminder names in advance; see the note above |
| `src/core/quests.ts` | daily quests — the closed loop: day-seeded draw, award-first grants, its own merge rule (see the note above) |
| `src/view/livecard.ts` | Home's single "what's live now" card — the ordered pure-provider list (see the note above) |
| `src/core/push.ts` | subscription custody + the two notification CATEGORIES (`pushCategories` / `setPushCategory`) |
| `src/core/apploop.ts` | the anti-drain loop sleep + every signal that undoes it — see the note above |
| `src/core/swupdate.ts` | may a waiting service worker be applied SILENTLY right now — the boot window + the anti-reload-loop latch (`main.ts` owns the wiring) |
| `src/core/originmigrate.ts` | the legacy-origin → `corrupt.solutions` profile handoff and its hostname gate — see the two-origins note above |
| `src/core/resumeguard.ts` | recovers a game loop that never restarted after a resume |
| `src/core/levelresume.ts` | mid-level snapshot/restore — see the "snapshot only on idle" note above |
| `src/core/trophies.ts` | chapter trophies — catalog, purse table, tier ladder, the claim latch (see the note above) |
| `src/view/stash.ts` | the stash panel + its two doors (Home line, LevelSelect `🎁 N` pill) |
| `src/view/installsheet.ts` | the install sheet — DOM, so the iOS guide can point at real browser chrome |
| `src/view/raceunlockcard.ts` | the one-time DAILY RACE UNLOCKED reveal |
| `src/view/pushoptin.ts` | the push opt-in card, race + morning-gift variants — see the note above; the gate is `pushOfferDue` in `core/push.ts` |
| `src/view/installrewardcard.ts` | the install reward's payout card — the receipt for `claimInstallReward` |
| `src/view/bonusdropcard.ts` | the house gift's sealed-box reveal — theatre only; `claimBonusDrop` already paid |
| `src/view/showroom.ts` | THE SHOWROOM trophy case — doors on the LevelSelect chapter ribbons |
| `src/view/trophyceremony.ts` | the chapter-complete ceremony + the one-time catch-up card |
| `src/view/platekit.ts` | the material + lighting law (E7): plates, spotlight scrims, `goldFace` — `ui.ts` re-exports the legacy names |
| `src/view/rgbmarquee.ts` | the RGB cabinet chase — see the note above before touching it |
| `src/core/fire.ts` | the fire's pure geometry — ring petals, wall tongues, the burn front (`fire.test.ts` pins the seam, the overlap and the anti-strobe rule) |
| `src/view/megafx.ts` | the SCREEN's celebration kit — rays, burning frame, embers, coins, erupting symbols |
| `src/view/firekit.ts` | the BOARD's fire — ring of fire, wall of flame, tally burn — see the note above before touching it |
| `src/view3d/stage.ts` | the only three.js usage |
| `supabase/migrations/` | `0001_saves` → `0025_push_daily_nudge` |
| `scripts/verify-rls.sh` | RLS audit — run after any migration |
| `scripts/send-push.mjs` | push sender — all three modes; carries the duplicated day keys AND the gift roll |
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

**A duplicate migration number has TWO failure modes, and only one is loud.**
The version is the primary key of `supabase_migrations.schema_migrations`, so
two LOCAL files sharing a prefix abort the run on SQLSTATE 23505 — that is the
duplicate-`0012` incident of 2026-07-30, and it is the one everybody expects.
The other mode is **silent**, and it is the dangerous one: a local file whose
number matches a version **already applied remotely** is reconciled by NUMBER
and never by name, so the CLI decides your file is already applied and drops it
from the plan without a word. ⚠️ **`--dry-run` reports success**, which is
exactly why it slips through. Measured 2026-08-25 (CLI 2.98.2): with `0025`
applied and a branch carrying its own unrelated `0025`, the dry run printed
only `• 0026_…` — the whole paid-entry migration, four money tables and their
RLS, was omitted in silence, and its dependent would then have run
`alter table public.entitlements` against a table that was never created.
So a clean dry run is **not** proof there is no collision. Before pushing from
any branch, check every local prefix against the Remote column of
`supabase migration list --linked`. When you must renumber, move the HIGHEST
file first or `git mv` clobbers, and chase the number everywhere it is written
as prose — the two-sided switches in `src/core/`, the Edge Function comments,
`docs/`, and the header list in `scripts/verify-rls.sh` — not just where it
appears as a path.

**CI never applies migrations.** The workflows only build Pages, send push, and
prune events. So applying a migration to production and merging it to `main`
are two separate acts, and *the repo does not describe production until both
have happened*. Land migration branches promptly — a migration that is live but
unmerged is invisible to whoever looks next.

If a push reports `Remote migration versions not found` and suggests
`migration repair --status reverted <v>`, check whether your branch is simply
behind `main` before running it. It usually is, and marking an applied
migration as reverted re-creates exactly the drift above. The other innocent
cause, seen 2026-08-25: the version was applied from a **different branch** and
your branch has no file for it, so nothing is wrong with production and the
repair would be actively harmful. It clears the moment that branch lands on
`main` and yours rebases; to verify before then, copy the missing migration
into a throwaway tree rather than repairing anything.

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

⚠️ **The `gh-pages` branch is NOT the deploy target and pushing to it ships
nothing.** Pages is configured `build_type: workflow` — the live site is the
artifact `.github/workflows/deploy.yml` uploads via `actions/deploy-pages`. The
API still reports a vestigial `source.branch: gh-pages`, which is what makes
this worth stating: the field is ignored, and the branch has been dead since
the workflow took over. Its last commit (2026-07-21) is **a different project**
— a `jackson/` directory holding a LEGO Brick Dodge game — and
`/viva-maya/jackson/` duly 404s. Keep the branch anyway: it is that project's
only copy, so it is an archive to move somewhere of its own, never a thing to
delete on the grounds that it is unused here.
