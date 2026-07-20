# Viva Maya — UI Facelift & Animation Plan (Round 2+)

> **Planning document only — no code changes.** A phased, prioritized backlog of *additive*
> UI/UX facelifts and new animation details for the Phaser 3.90 + TypeScript build.
> Everything here is net-new: it does **not** re-propose the already-shipped motion/juice
> system (see "Explicitly already done" below). Every item respects the hard constraints —
> reduced-motion resting state, the reduce-flashing gate, the `quality` performance governor,
> theme tokens (works on all 4 themes), zero external assets (emoji-baked + procedural
> Graphics, hi-DPI baking pattern), and Phaser 3.90 idioms.

---

## What's already strong (grounded in the source)

- **A mature, tokenized motion + material system.** `src/view/motion.ts` owns duration/ease
  tokens (`D`/`E`/`M`), calibrated `OVERSHOOT`/`backOut`, composable helpers, and a shared
  `heartbeat` clock; `src/view/ui.ts` bakes a real "cap-on-a-pedestal" pressable
  (`buildPressable`, ui.ts:766) with `goldFace()` real-metal material (ui.ts:562) under one
  `LIGHT` key light (ui.ts:493). Buttons sink + thock (`sfx.uiPress`) + haptic on press.
- **Deep board juice already exists.** Charge→hitstop→release detonations (GameScene
  `playWave`/`hitstop`/`chargeFlare`, ~1593/1836/1857), directional trauma shake (`punch`/
  `addTrauma`, 1786), capped impact frames (1808), column-staggered **deal-in** (1226),
  `settleSquash` (1888), `secondaryMotion` (1900), collect-fly arcs (`flyCollect`, 678), and a
  continuous heat-ramping combo counter (`showCombo`, 3250) with a `cascadeRiser`.
- **Signature win identity is shipped.** The **Heartbloom** hero beat + scarce **Maya
  leitmotif** (GameScene 2465 / sfx `mayaMotif` 651), `milestoneSplash` (2549), `allClearFinale`
  (2602), elastic win card with coin roll-up payout (`buildWinCard`/`buildCoinPayout`,
  2812/3009), NEW BEST ribbon, and the Jackpot Wheel overlay (`view/jackpot.ts`).
- **A rich, governed, theme-driven atmosphere.** `view/background.ts` composes wash / aurora /
  spotlight / god-rays / bokeh / vignette / marquee chase / board-bleed + a shared **proscenium
  frame** (`addProscenium`, 535); all negative-depth, governor- and reduced-motion-aware.
- **Accessibility + audio are first-class.** In-app Reduce Motion / Reduce Flashing / Haptics /
  High-Contrast board (`openSettingsPanel`, ui.ts:1527), ≥44pt hit-zones (`MIN_HIT`), a shared
  reverb bus, key-lock, stereo pan, ducking, and per-beat partner voices in `audio/sfx.ts`.

**Design consequence:** the low-hanging fruit is gone. The highest-ROI work now is **(a) wiring
systems that are built but unused, (b) the few surfaces that never got the juice pass
(LevelSelect scrolling, Store, the lose card, empty/idle states), and (c) a handful of
signature-grade new moments.** The plan is organized around exactly that.

---

## Explicitly already done — DO NOT re-add

These exist in the committed source; re-proposing them is out of scope.

- Chunky 3D pressable buttons: cap/pedestal sink + squash, `uiPress` down-thock, press haptic,
  `opts.juice` breathing glow ring, `setDisabled` (`ui.ts` `buildPressable`).
- Cream (never-black) scene cross-fade + **directional push/pop** grammar + `whoosh` partner
  (`startScene`/`applyEntrance`/`consumeEntrance`, ui.ts:114–149).
- **Power-on boot reveal** on Home (marquee `powerOn` sweep, emblem spring, bulb cascade, glow
  bloom, button stagger — HomeScene 64–375).
- Board **deal-in** column rain, `settleSquash`, `secondaryMotion`, height-mapped `land()` thunks.
- Impact system: charge→hitstop→release, directional trauma shake, ≤1 capped impact frame,
  reduce-flashing gate routed through `punch()`.
- **Heartbloom** hero win + Maya leitmotif (scarce), `milestoneSplash`, **ALL CLEAR** finale,
  collect-fly, special-birth ring, score-punch, urgent-moves pulse, continuous combo counter +
  cascade riser.
- Win result card: elastic entrance, ascending star dings, coin roll-up payout, NEW BEST ribbon,
  JACKPOT READY banner, tap-to-skip settle.
- Jackpot charge meter (Home + HUD) + **Jackpot Wheel** overlay (award-first, honest landing).
- Daily **3-reel** spin with third-reel suspense, panned reel clunks, per-reel win glow,
  streak-milestone tiers (7/30/100), Heartbloom on claim.
- Full atmospheric backdrop stack + proscenium keystone frame; glossy tiles in a recessed gold
  tray; seated-piece contact shadow; armed-glow + "collect-me" goal halos.
- 4 themes + theme picker + **per-theme audio palettes** (reverb/bed rebuilt on `scene.restart`).
- Full a11y suite (Reduce Motion / Reduce Flashing / Haptics / HC board), ≥44pt hit targets,
  reduced-motion resting states across every existing loop.
- Home: suit-shuffle emblem, **secret love note** (long-press / 4-tap), time-of-day greeting,
  special-date shower, drifting satellites, chip pill, streak flame.
- LevelSelect: masked drag-scroll grid, entrance cascade, current-chip "you are here" pulse,
  from-win chip celebrate. Gift Store: chip sink, fly-chip payout, toast, denied shake.
- Quality governor scaling particle counts; background-pause (`loop.sleep()` on tab-blur).
- **Note:** the custom hi-DPI 2× backing subsystem was *deliberately removed* (stock Phaser FIT;
  main.ts:38–46) and the board-wide **light-sweep shimmer was removed as "repetitive"** (git
  `2868f`). Do **not** re-introduce either — any new idle sparkle must be sparse/one-shot, not a
  board-wide sweep.

---

## Phase 1 — quick, high-ROI micro-interactions

### Cross-cutting

**C1 · Phase-lock the hero breathers to the shared `heartbeat` clock**
- *What:* The Home emblem breath, the PLAY glow, the daily SPIN glow, and the in-game
  `cabinetGlow` each run independent yoyo tweens at different periods, so the app "shimmers
  incoherently" — exactly the failure `heartbeat` was built to fix. Drive their scale/alpha from
  `heartbeat.amp()` in each scene's `update()` so the whole machine pulses as one organism (the
  E1 intent that was never wired).
- *Where:* `HomeScene.create/update` (emblem 148, PLAY glow 248), `GameScene.update` (cabinetGlow
  887), consuming `heartbeat.amp()` from `src/view/motion.ts:259` (currently **zero consumers**).
- *Impact:* The single cheapest "expensive-feel" win — coherent breathing is the tell of a
  premium product; incoherent is the tell of ad-hoc juice.
- *Effort:* **M** (adds `update()` reads; must retire the replaced loops carefully).
- *A11y + perf:* `motion.reduced()` already no-ops `breathe`; keep the static resting scale under
  reduced motion (read the clock only when not reduced). Net **fewer** tweens (one clock read
  replaces N loops) — zero fill-rate change.
- *Reuse:* `heartbeat.amp()/phase()`, `D.breath`, `E.hero`.

**C2 · Adopt the unused `popIn` / `fadeRise` / `stagger` entrance helpers**
- *What:* Scenes hand-roll their entrances (Home's button stagger, HomeScene:358; overlay card
  scale-ins) while `motion.ts`'s composable helpers sit unused. Route existing entrances through
  them for one consistent entrance grammar and less duplicated tween code.
- *Where:* `src/view/motion.ts` (`popIn` 123, `fadeRise` 192, `stagger` 218) consumed by
  HomeScene button loop, `StoreScene.renderList`, and the overlay cards; no behavior change where
  timings already match the tokens.
- *Impact:* Coherence + maintainability; makes every subsequent entrance item trivial to author.
- *Effort:* **M** (mechanical refactor, verify zero visual diff).
- *A11y + perf:* Helpers already collapse to the instant resting state under `reduced()`. Zero
  perf change.
- *Reuse:* `stagger`, `fadeRise`, `popIn`, `M.pop`.

**C3 · Ambient-bed toggle in Settings (unlock a fully-built system)**
- *What:* `sfx.startBed()` / `toggleAmbience()` / theme `audio` palettes are **completely built
  but unreachable** — no UI ever calls `toggleAmbience` (only its definition, sfx.ts:189). Add an
  "Ambient sound" row to the Settings panel so players can turn on the warm lounge bed that
  already rebuilds per theme.
- *Where:* `openSettingsPanel` rows list (`ui.ts:1576`), new `ToggleConfig`
  `{ get: () => sfx.ambience, set: v => sfx.toggleAmbience() }`.
- *Impact:* Lights up an entire finished subsystem (multi-sensory themes) for a one-row change —
  the best effort-to-payoff ratio in the plan.
- *Effort:* **S**.
- *A11y + perf:* Entirely off the fill-rate budget; already mute-gated and `ctx.suspend()`s on
  tab-blur. Default OFF (a gift never surprises with a drone).
- *Reuse:* `buildToggleRow`, `sfx.toggleAmbience`, theme `audio{}`.

### Home

**H1 · Greeting + tagline `fadeRise` entrance**
- *What:* The time-of-day greeting and "cascades · power-ups · jackpots" tagline pop in static.
  Give them a gentle fade-rise so the top of Home feels composed, not stamped.
- *Where:* `HomeScene.create` greeting (129) + tagline (237).
- *Impact:* Small but every-session polish on the first thing the eye lands on.
- *Effort:* **S**.
- *A11y + perf:* `fadeRise` is reduced-motion-aware (instant place). Transient, zero steady cost.
- *Reuse:* `fadeRise` (via C2), `E.release`.

**H2 · Lives-regen "heart fills" micro-beat**
- *What:* When the Home lives countdown crosses a regen boundary, the newly-earned heart currently
  just flips to full alpha on the next 1s tick. Instead, pop + tint-flash the specific heart as it
  fills, paired with a soft chime (see C5) — a small reward for the return loop.
- *Where:* `addLivesHud.update` (`ui.ts:187`) — detect the count increase and animate the crossing
  heart; called from `HomeScene.refreshLivesHud` (118) and the lives gate.
- *Impact:* Turns invisible regen into a felt "you got a life back" beat.
- *Effort:* **S–M** (needs `update` to diff old→new count).
- *A11y + perf:* Reduced motion → instant fill (today's behavior). One transient tween per
  regen; no steady cost.
- *Reuse:* `popIn`/scale-pop, theme `rose`/`gold` tint, `sfx` chime (C5).

### Board / pieces

**B1 · Swipe-intent sparkle trail**
- *What:* During a drag-swap, a faint sparkle/heart trail follows the moving piece so the gesture
  reads as physical intent before the pieces snap.
- *Where:* `GameScene.onMove`/`trySwap` (1432/1498); a short particle follow on the dragged
  sprite, stopped on swap resolve.
- *Impact:* Makes the core input verb feel tactile; near-invisible cost.
- *Effort:* **S**.
- *A11y + perf:* Reduced motion → no trail; `quality.count()` caps the emitter (0 on low tier).
  Never crosses the board rect illegibly (it rides the piece, above tiles).
- *Reuse:* `sparkEmitter`/`heart` texture, `quality.count`.

**B2 · Magnetic select telegraph**
- *What:* On tap-select, the up-to-4 swappable neighbors lean ~3px toward the selected piece and
  settle — a tactile hint of "these are your options," complementing the existing selection ring.
- *Where:* `GameScene.select` (1466), nudging the neighbor sprites; disarmed by `clearSelection`
  (1486) and `trySwap`.
- *Impact:* Core-loop clarity for a non-gamer (the exact target player) — telegraphs valid moves
  every turn without a hint timer.
- *Effort:* **S–M**.
- *A11y + perf:* Reduced motion → static (the ring alone carries the tell, as today). Transforms
  only; ≤4 tiny tweens, disarmed on any board change.
- *Reuse:* `E.settle`/`backOut(OVERSHOOT.gentle)`, `PIECE_SCALE`.

### Win / Lose

**W1 · Lose card: gentle entrance + "so close" emphasis**
- *What:* The win card enters elastically; the **lose** card just appears after a 400ms delay
  (`showOverlay` lose path, 2746). Give it the same calm scale/fade-in, and shimmer the
  nearest-to-complete objective in the "STILL NEEDED" row (the one with the smallest `remaining`)
  so a loss reads as "you almost had this," matching the warm lose copy already present.
- *Where:* `GameScene.showOverlay` lose branch (2746–2803).
- *Impact:* Softens the only genuinely negative moment in the game — emotional, every failure.
- *Effort:* **S–M**.
- *A11y + perf:* Reduced motion → instant card (no scale-in), static highlight. Transient only.
- *Reuse:* `buildWinCard` entrance pattern (`Back.easeOut`), theme `warn`/`gold`, `overlayCard`.

### LevelSelect

**L1 · Scroll inertia / flick**
- *What:* The level grid drag stops **dead** on release (`pointerup` just sets `dragging=false`,
  LevelSelectScene:118). Add flick velocity + friction decay so the map scrolls like a native
  list — the biggest single "this feels dead" fix on that surface.
- *Where:* `LevelSelectScene` input handlers (106–118) + a small `update()` that decays velocity
  and clamps to `[minScroll, maxScroll]`.
- *Impact:* High — 300 chips make the flat drag feel sluggish; inertia transforms the browsing feel.
- *Effort:* **M**.
- *A11y + perf:* Reduced motion → keep the direct 1:1 drag (no fling). Pure transform on the
  masked container; already one mask, zero new draws.
- *Reuse:* Existing `Phaser.Math.Clamp` bounds; `E.settle` feel for the decay curve.

### Store

**S1 · Boost-row entrance stagger**
- *What:* `renderList` (StoreScene:88) builds all 5 cards instantly. Stagger them in with the
  shared `fadeRise` so the Store matches the composed entrance of every other scene.
- *Where:* `StoreScene.renderList`/`boostRow` (88–131).
- *Impact:* Brings the plainest scene up to the app's polish bar.
- *Effort:* **S**.
- *A11y + perf:* `stagger` is reduced-motion-aware. Transient.
- *Reuse:* `stagger` (via C2).

### DailyBonus

**D1 · Next-spin live countdown**
- *What:* The already-spun state shows only "⏳ come back tomorrow" (DailyBonusScene:174). Replace
  with a live "next spin in HH:MM:SS" that ticks to local midnight — the same return-hook clarity
  the lives system already gives.
- *Where:* `DailyBonusScene.create` unavailable branch (174–183); a 1s timer computing time to next
  `todayKey()` rollover (reuse the `formatCountdown` style from `core/lives.ts`).
- *Impact:* Converts a dead-end screen into a countdown that pulls the next visit.
- *Effort:* **S–M**.
- *A11y + perf:* Purely text; no motion. One 1s timer.
- *Reuse:* `formatCountdown` pattern, `onBackdropMuted` token.

### Boot

**BT1 · Power-on audio swell (Signature #1 audio finish)**
- *What:* The power-on reveal is visually rich but its only audio is `whoosh` on the sweep. Add a
  one-shot theme-tinted **rising chord** as the wordmark lights (using the theme's `audio.bedRoot`
  + `waveBias`), so the app's identity open is multi-sensory.
- *Where:* `ui.ts` `marquee.powerOn` (303) and/or `HomeScene` boot branch (192); a new
  `sfx.powerOn()` voice built from `tone()` in `audio/sfx.ts`.
- *Impact:* Completes the signature open; scarce (boot only), memorable.
- *Effort:* **S**.
- *A11y + perf:* Audio is never motion-gated (plays in reduced motion too, like `mayaMotif`); mute-
  gated; off the fill budget. Do **not** add a boot splash — BootScene stays hard by design.
- *Reuse:* `sfx.tone`/`snap`, theme `audio{}`, existing `powerOn` timing.

**Phase 1 sequencing + risk.** Land **C1–C3 first** (they're foundations later items lean on:
heartbeat coherence, the entrance helpers, the ambient toggle). C2 must be verified as a
zero-visual-diff refactor before H1/S1 build on it. All Phase-1 items touch disjoint scene files
except C1/H1/H2 (Home) — sequence those within Home. **Risk is low**: every item is a transform,
a text change, or a one-row toggle; the only care point is C1 correctly retiring the old
independent loops so breathers don't double-drive (validate the reduced-motion resting scale).

---

## Phase 2 — signature moments & richer transitions

### Cross-cutting

**C4 · Idle "attract" layer via the unused `quality.idle()`**
- *What:* `quality.idle()` (quality.ts:97, flips true after 6s no-input) has **zero consumers**.
  Wire it into an attract layer: after idle on Home/LevelSelect, play a gentle attention beat
  (see H3), and let the backdrop throttle (see A2). Disarms on the next input (`noteActivity`).
- *Where:* New small helper read in `HomeScene.update`/`LevelSelectScene.update`; consumes
  `quality.idle()`.
- *Impact:* Gives the app "life while waiting" and a battery-saving lever, from a governor feature
  already ticking every frame.
- *Effort:* **M**.
- *A11y + perf:* Reduced motion → no attract beat (idle simply throttles ambient). Net perf **win**
  (throttles on idle).
- *Reuse:* `quality.idle()`, `quality.noteActivity()`.

**C5 · Sound↔visual pairing pass for the remaining silent beats**
- *What:* A few beats still land silent or unpaired: lives-regen fill (H2), theme **apply** (the
  `scene.restart` after the picker repaints with no sonic confirmation), and an objective nearing
  zero. Add small key-locked partners: a soft "life restored" chime, a theme-swap chord in the new
  palette, and an optional rising tone as an objective approaches completion.
- *Where:* new tiny voices in `audio/sfx.ts`; call sites in `addLivesHud` (H2), theme apply
  (`openThemePanel` close / `sfx.refreshTheme`, sfx.ts:1112), and `settleCollect` (GameScene:639).
- *Impact:* Closes the "every beat has an audible partner" contract on the last few gaps.
- *Effort:* **M**.
- *A11y + perf:* Audio only, off the fill budget, mute-gated, key-locked via `snap()`.
- *Reuse:* `sfx.tone`/`snap`, theme `audio.bedRoot`, `refreshTheme`.

**A2 · Idle backdrop throttle** *(rides C4)*
- *What:* When `quality.idle()` is true, dim/slow the ambient breathing loops (aurora, marquee
  chase) a notch to save battery on a left-open PWA, restoring on input.
- *Where:* `background.ts` breathing builders (aurora 185, marquee 449) reading `quality.idle()`.
- *Impact:* Thermal/battery win on the "left on the home screen" case; invisible when active.
- *Effort:* **S**.
- *A11y + perf:* Pure perf item; reduced motion already static. No new draws.
- *Reuse:* `quality.idle()`, existing breathe tweens.

### Home

**H3 · Idle attract beat**
- *What:* After idle (C4), the PLAY button does one slightly larger "come play" pulse and a single
  card-suit ghosts across behind the hero, then rests — a soft invitation, not a loop.
- *Where:* `HomeScene.update` gated on `quality.idle()`; reuses the PLAY container + `sweep`/suit
  textures.
- *Impact:* Warmth + a nudge for a hesitant first-timer.
- *Effort:* **S** (rides C4).
- *A11y + perf:* Reduced motion → none. Single transient sprite, governor-capped, disarms on input.
- *Reuse:* `sweep`/`suitHeart` textures, `M.pop`, `quality.idle`.

**H4 · Jackpot-ready Home teaser**
- *What:* When the charge meter is full on Home it merely breathes (jackpot.ts halo). Add a periodic
  single spark off the meter + a subtle label shimmer so "ready to spin" reads at a glance.
- *Where:* `addJackpotMeter` full-state branch (`view/jackpot.ts:127`) used by `HomeScene` (306).
- *Impact:* Telegraphs the reward loop's payoff without opening the wheel out of context.
- *Effort:* **S**.
- *A11y + perf:* Reduced motion → static lit halo (today). One tiny periodic spark, governor-capped.
- *Reuse:* `sparkEmitter`-style burst, `T.gold`, existing halo tween.

### Board / pieces

**B3 · Floor-impact dust on deep drops**
- *What:* Deal-in and refill land with a `land()` thunk but no visual at the floor. Add a small
  ground-dust puff (soft `bgglow` + a few `spark`) at the deepest-settling cell per column, sized
  by drop distance — the visual partner to the existing audio thunk.
- *Where:* `GameScene.animateFalls` per-column settle (2112–2157) + deal-in (1258).
- *Impact:* Sells the board's "mass" that E5's squash started; makes cascades feel weighty.
- *Effort:* **M**.
- *A11y + perf:* Reduced motion → none. One puff **per settling column** (not per piece),
  `quality.count()`-capped, self-destroying; stays below the pieces.
- *Reuse:* `bgglow`/`spark`, `colPan`, `quality.count`, `settleSquash` timing.

**B4 · Rare single-piece "twinkle" (NOT a board sweep)**
- *What:* While idle, at most one random piece does a subtle one-off gleam every ~8–12s. Explicitly
  **not** the removed board-wide light-sweep (git `2868f`) — it's a single, sparse, non-repetitive
  glint so the board feels alive without the "distracting shimmer" the owner rejected.
- *Where:* `GameScene.update` gated on `state==='idle'` + `quality.idle()`; a masked `sweep`/`spark`
  on one sprite.
- *Impact:* Life on the idle board, carefully scoped to avoid the prior complaint.
- *Effort:* **S**.
- *A11y + perf:* Reduced motion → none. One transient sprite at a time; disarms the instant the
  board is touched or resolving. Governor-gated off on low tier.
- *Reuse:* `sweep`, `quality.idle`, existing bitmap-mask trick.

### Win / Lose

**W2 · Third-star flourish**
- *What:* When the 3rd star dings in on the win card, crown it with a small gold burst (a tier below
  the Heartbloom, which already fires on PERFECT) so "you maxed it" reads on the card itself.
- *Where:* `GameScene.buildWinCard` star loop (2893).
- *Impact:* Rewards the mastery goal at the moment it's confirmed.
- *Effort:* **S**.
- *A11y + perf:* Reduced motion → static star (no burst). One capped `sparkEmitter.explode`.
- *Reuse:* `sparkEmitter`, `star`, `starDing`.

**W3 · Score-milestone pop**
- *What:* When the rolling HUD score crosses a round threshold (10k / 25k / 50k…), fire a one-off
  gold flash + tick on the score readout — a small dopamine hit during play, distinct from the
  per-gain `scorePunch`.
- *Where:* `GameScene.addScore`/`scorePunch` (3200/3227) — detect threshold crossings.
- *Impact:* Adds texture to the score climb on long/endless runs.
- *Effort:* **S**.
- *A11y + perf:* Reduced motion → colour flash only, no scale punch (mirrors `scorePunch`).
  Transient.
- *Reuse:* `scorePunch`, `sfx.scoreTick`, `gold` token.

### LevelSelect

**L2 · Milestone-chip styling (map-as-journey)**
- *What:* The 10/20/30… milestone levels look identical to normal chips (`buildChip`, 153). Give
  them a distinct gold crown/frame (via `goldFace`) and a small star-tally so the map reads as a
  journey with landmarks — the payoff the `milestoneSplash` promises.
- *Where:* `LevelSelectScene.buildChip` (153), branching on `n % 10 === 0`.
- *Impact:* Turns a flat grid into a legible progression with waypoints.
- *Effort:* **M**.
- *A11y + perf:* Static baked styling; theme-tokened (`gold`/`goldBezel`). No motion required;
  reduced motion unaffected.
- *Reuse:* `goldFace`, `star`, theme tokens.

**L3 · Frontier "keep going" marker**
- *What:* A soft directional cue at the current-level chip pointing toward the next locked run, so a
  returning player instantly sees "here's where you're headed."
- *Where:* `LevelSelectScene.buildChip` current-chip branch (already has `celebrateCurrentChip`, 225).
- *Impact:* Wayfinding for the core progression loop.
- *Effort:* **S**.
- *A11y + perf:* Reduced motion → static arrow (no bob). Reuses `ring`/a baked chevron.
- *Reuse:* `celebrateCurrentChip` hook, `ring`, `E.hero`.

### Store

**S2 · Boost-icon idle bob + first-affordable highlight**
- *What:* Boost icons sit static and every affordable price pill looks the same. Add a gentle idle
  bob to the icons and give the cheapest **affordable** item's price pill a breathing `juice` glow
  to guide a first purchase.
- *Where:* `StoreScene.boostRow` (93) — icon tween + `opts.juice` on the lowest affordable pill.
- *Impact:* Life + a merchandising nudge for the chip sink.
- *Effort:* **S–M**.
- *A11y + perf:* Reduced motion → static (today). Governor-safe; the glow is one ADD sprite reusing
  the button `juice` path.
- *Reuse:* `breathe`, `addPillButton({ juice:true })`, `bgglow`.

**S3 · "Play to earn" empty state**
- *What:* When nothing is affordable, the Store is all ghosted pills with no guidance. Add a warm
  line + a PLAY shortcut so the empty state points back into the loop.
- *Where:* `StoreScene.renderList`/`create` (68) — detect `chips < min(prices)`.
- *Impact:* Closes the loop instead of dead-ending a broke player.
- *Effort:* **S**.
- *A11y + perf:* Static text + one button; theme-tokened. No motion.
- *Reuse:* `addPillButton`, `startScene`, `onBackdropMuted`.

### DailyBonus

**D2 · Pre-spin reel tease + wind-up**
- *What:* Idle reels sit dead until SPIN. Add a subtle idle bob to the idle symbols and a quick
  wind-up dip on SPIN press before the reels launch (anticipation → release, matching the E6 charge
  language).
- *Where:* `DailyBonusScene.create` idle reels (186) + `doSpin` (190).
- *Impact:* Casino anticipation on the daily return hook.
- *Effort:* **S**.
- *A11y + perf:* Reduced motion → static (the existing instant-settle path is untouched). Transforms
  only.
- *Reuse:* `M.snappy`, `backOut`, existing reel containers.

### Backdrop

**A1 · Per-theme ambient flourish**
- *What:* One tasteful, theme-specific accent so the 4 themes feel distinct in the margins beyond
  color: e.g. Neon Vegas → a faint cyan marquee flicker; Rose Midnight → 1–2 slow drifting "stars";
  Golden/Maya → a warm dust mote. One accent per theme, margin-confined.
- *Where:* `background.ts` — a small `themeFlourish(scene, variant)` reading `getThemeId()` +
  tokens, added to `addCasinoBackdrop` (584).
- *Impact:* Makes the theme picker feel like changing rooms, not repainting.
- *Effort:* **M**.
- *A11y + perf:* Reduced motion + low tier → static/none. Capped via `quality.count`; negative
  depth, ≤0.20 α, margin-confined — never crosses the board rect.
- *Reuse:* `addGlow`/`bgdot`/`sparkle`, theme `accent`/`sparkleTint`, `quality`.

### Boot

**BT2 · First-paint texture warm-up**
- *What:* `warmButtonTextures` pre-warms button textures, but the first cascade lazily bakes special
  overlays (`ensurePieceTexture`) and the tile/particle textures aren't pre-touched — a possible
  first-deal-in hitch on a cold PWA. Pre-warm the common piece/special/tile signatures at boot.
- *Where:* `createAllTextures` (textures.ts:664) + a `warmPieceTextures(scene)` alongside
  `warmButtonTextures`.
- *Impact:* Guarantees the signature deal-in never stutters on first play.
- *Effort:* **S–M**.
- *A11y + perf:* Baking is generate-once (guarded); a few ms at boot, zero runtime cost. No visible
  splash (BootScene stays hard).
- *Reuse:* `ensurePieceTexture`, `warmButtonTextures` pattern.

**Phase 2 sequencing + risk.** Build **C4 first** (H3 + A2 both consume `quality.idle()`), then C5
(H2's chime + theme-apply pairing). The board items (B3/B4) touch `GameScene` — sequence them and
run against the on-device soak (checklist #8 in `VISUAL_OVERHAUL.md`) since they add transient light
during the busiest frames. **Main risk:** B3/B4 must stay strictly capped and idle/`state`-gated so
they never re-create the "repetitive shimmer" complaint or breach the ≤2.0 FSE game budget —
validate particle counts through `quality.count()` on a low-tier device. A1 must be verified on both
dark themes for the "nothing crosses the board rect" rule.

---

## Phase 3 — ambitious / systemic

**C6 · Shared-element scene transitions**
- *What:* Beyond the flat cream cross-fade, add an optional "focus element" to `startScene`: the
  tapped element (Home **PLAY**, or a LevelSelect **chip**) scales/fades from its origin into the
  destination as the cameras cross-fade — the Candy-Crush "the thing I picked opened into the
  board" feel.
- *Where:* `startScene`/`applyEntrance` (ui.ts:114/140) + opt-in hooks in `HomeScene` PLAY (281)
  and `LevelSelectScene` chip tap (202); the destination `GameScene.create` receives the focus and
  resolves it into the board frame.
- *Impact:* Signature-grade spatial continuity; the most "designed" the navigation could feel.
- *Effort:* **L** (cross-scene handoff of a transient element + reduced-motion + input-lock timing).
- *A11y + perf:* Reduced motion → today's flat fade (no shared element). One transient sprite during
  the transition; input already locked by `startScene`.
- *Reuse:* `startScene` input-lock, `consumeEntrance` direction, `bgglow`/element textures.

**B5 · Win "board sweep-clean" flourish**
- *What:* On a win, before the result card, the remaining board pieces fly off / collect toward the
  score in a quick cascade so the board visibly **empties into the win** — a satisfying "you cleared
  it" beat richer than the current flash + token burst (`celebrateBoard`, 1041).
- *Where:* `GameScene.finishWin` (2190) → a new beat before `runWinSequence`, reusing the
  `flyCollect` arc machinery (678) generalized to all remaining sprites.
- *Impact:* A signature win moment that reads the objective→reward link at full-board scale.
- *Effort:* **L** (must not delay/steal the tap-to-skip; interacts with the existing win beats).
- *A11y + perf:* Reduced motion → skip the sweep, go straight to the card. Capped fly count via
  `quality.count()`; reuses one arc helper.
- *Reuse:* `flyCollect` arc, `sparkEmitter`, tap-to-skip guard.

**L4 · Connecting "path" trail through the level map**
- *What:* A faint dotted/winding trail connecting the chips row-to-row, lit up to the current level
  and dim beyond — the classic map "journey" line that makes progression tangible.
- *Where:* `LevelSelectScene.create` — a baked `Graphics`/`bgdot` trail behind the chip grid (48),
  scrolling with `content`.
- *Impact:* Converts the grid into a map; strong retention/identity for the progression surface.
- *Effort:* **L** (routing the path through a 5-wide, 60-row grid; masking + scroll).
- *A11y + perf:* Static baked graphics (one object under the mask); reduced motion unaffected.
  Theme-tokened (`suitWatermark`/`gold` dim).
- *Reuse:* `bgdot`, `graphics`, the existing grid geometry + mask.

**D3 · Streak "calendar" strip**
- *What:* A small 7-dot week strip on the daily screen showing the streak building, with the
  5th-day **double-prize** day marked — making the streak's payoff structure visible and worth
  returning for.
- *Where:* `DailyBonusScene.create` (near the streak text, 79); reuse `bulb`/`heart` + theme tokens.
- *Impact:* Turns an invisible counter into a visible goal; strengthens the daily loop.
- *Effort:* **M**.
- *A11y + perf:* Static (filled vs. empty dots); one optional pop on today's dot (reduced-motion
  gated). No steady cost.
- *Reuse:* `bulb`/`heart`, `daily.ts` streak math, `gold`/`rose` tokens.

**Phase 3 sequencing + risk.** These are independent and can be scheduled by appetite. **C6 and B5
carry the most risk**: both add cross-cutting timing to already-choreographed sequences (scene
transitions; the multi-beat win), so they must preserve the existing input-lock / tap-to-skip
guarantees and fall back cleanly under reduced motion — build each behind a flag and verify the
non-shared-element / no-sweep path is byte-for-byte today's behavior. L4 and D3 are lower-risk
(static, self-contained) and are the safer places to start Phase 3.

---

## At-a-glance phase rollup

| Phase | Items | Theme |
|---|---|---|
| **1** | C1 heartbeat-coherence, C2 entrance-helpers, C3 ambient-toggle, H1 greeting-rise, H2 lives-fill, B1 swipe-trail, B2 magnetic-select, W1 lose-card, L1 scroll-inertia, S1 store-stagger, D1 spin-countdown, BT1 boot-swell | quick, high-ROI micro-interactions |
| **2** | C4 idle-attract, C5 sound-pairing, A2 idle-throttle, H3 attract-beat, H4 jackpot-teaser, B3 floor-dust, B4 rare-twinkle, W2 third-star, W3 score-milestone, L2 milestone-chips, L3 frontier-marker, S2 icon-bob, S3 empty-state, D2 reel-tease, A1 theme-flourish, BT2 texture-warmup | signature moments & richer transitions |
| **3** | C6 shared-element-transition, B5 board-sweep-clean, L4 map-path-trail, D3 streak-calendar | ambitious / systemic |

*32 items total. Every item has a reduced-motion resting state, routes flashes/impacts through the
existing `punch()`/reduce-flashing gate where relevant, scales particle work via
`quality.count()`/`quality.scale()`, draws color from theme tokens (all 4 themes), and adds no
external assets — emoji-baked or procedural Graphics only, following the hi-DPI baking pattern
(BASE 128 · SS 2 · TEX_SIZE 256).*
