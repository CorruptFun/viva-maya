# Viva Ton — ULTIMATE UI/UX ELEVATION

*Creative-director synthesis of 7 expert lenses (game-juice, art-direction, motion, delight, a11y-ux, sound↔visual, perf-realist) into ONE prioritized plan that goes BEYOND the shipped 9-phase `docs/VISUAL_OVERHAUL.md`.*

**Prime directive unchanged:** procedural / zero-asset, mobile 60fps on A9–A11, warm heart-motif brand, board readability (40–680 × 300–940 untouched, emoji never re-tinted), reduced-motion is a first-class path. Everything below respects the §5 fill-rate budget (≤2.0 FSE game incl. the 0.71 `cabinetGlow`, ≤3.0 FSE menu) and adds essentially zero steady-state overdraw — the elevation is in transforms, timing, audio, and transient capped beats, not new persistent light.

---

## The gap the 9 phases leave

The overhaul makes Viva Ton look **generically expensive** (gloss, depth, themes, transitions) but it leaves four things on the table that separate "polished" from best-in-class:

1. **No impact language** — nothing on the board ever winds up before it strikes, no hitstop registers a big hit, survivor tiles are inert. (game-juice)
2. **No ownable identity** — the heart is decoration, not the game's structural signature; the four themes look different but **sound identical**; there's no memorable "you did it" beat. (art + sound + delight)
3. **Motion is a *phase*, not a *layer*** — ~40 magic-number durations and inline eases with no shared language, exactly the gap `theme.ts` closed for color. (motion)
4. **Accessibility is guarded only for *new* code** — existing loops/shakes/flashes and today's contrast failures ship unguarded; touch targets sit at ~27pt. (a11y)

The plan below adds **two new foundation modules that parallel `theme.ts`** — `motion.ts` (timing/easing language) and a `maya.ts` personal-config surface — plus one **cross-cutting perf keystone** (adaptive quality governor) that turns §5's fixed budgets into adaptive ones so full juice ships safely on old hardware.

---

## KEY CROSS-LENS CALLS (conflicts resolved)

1. **Camera shake/flash: accessibility wins over juice.** The trauma-based screenshake (juice) is adopted *because* it reduces chaos, but every shake/flash routes through one `punch()` authority that no-ops under reduced-motion AND under a separate **"reduce flashing"** toggle (photosensitivity ≠ vestibular — two switches). Impact-frame white flashes are capped at **1 concurrent full-screen ADD flash**; stacked detonations share it (perf red line).
2. **Hitstop is free and adopted** (`tweens.timeScale`/`time.timeScale`, restored on wall-clock `setTimeout`). Graded, not uniform: reel 0ms / bomb ~45ms / jackpot·mega ~70ms. One hitstop per resolve loop, deepest event owns it. Reduced-motion → skip freeze, keep a single 1-frame flash.
3. **Contrast token nudge is an explicit carve-out from P7's "zero-visual-diff" pledge.** `inkMuted`, the HUD-caps grey, `inkFaint`, and gold *display text* fail WCAG AA on cream **today**; P7 as written preserves the failure. Nudge the tokens (darker muted ink; gold text → ~`#9a6d00`/navy for *text*, keep bright gold for fills/bezels). One fix satisfies all four themes because cards stay cream everywhere.
4. **Ambient audio bed ships behind a toggle, default subtle** — restraint matters; menus only, `ctx.suspend()` on tab-blur, gated by mute + a new ambience switch. Never a forced drone.
5. **Personal/named warmth is hidden or owner-gated, never on the front door** — honors `GAME_DESIGN.md`'s "no explicit dedication in product copy." The default product stays clean; the love-letter is *discovered* (heart easter egg) or *config-flagged* (`maya.showName`).
6. **Tween/loop count is a non-issue; fill-rate is the only ceiling.** Motion items are transforms on existing objects → ~0 overdraw. The governor (not layer-cutting) absorbs the few transient glows on weak hardware.

---

## RANKED ELEVATIONS

Effort: **S** ≈ hours · **M** ≈ a phase-day · **L** ≈ multi-file. "Slots" = where it sits relative to the 9 phases.

### E1 — `motion.ts`: the timing/easing language + shared heartbeat clock — **M**
- **What:** the missing sibling of `theme.ts` — one module owning duration tokens (`D.micro…breath`), named brand curves (`E.press/release/pop/hero/glide/arc/exit` — *calibrated* overshoot, not one anonymous `Back.easeOut` for everything), the canonical `reduced()` guard, composable presets (`enter/press/pop/breathe/stagger/countUp`), and a single `heartbeat.phase` clock (~72bpm lub-dub).
- **Why high-impact:** every later motion item speaks this vocabulary instead of re-inventing timings; it makes P1-buttons/P5/P6 *cheaper*. The heartbeat clock (merges art#8 + motion·P8 + delight#13) phase-locks the hero breathers — Home emblem, PLAY glow, `cabinetGlow` — so the whole machine "breathes as one organism" instead of shimmering incoherently. This is the brand signature made structural.
- **How:** create `src/view/motion.ts`; route the 5 reduced-motion copies + ~40 magic durations through `D`/`E` (pick tokens equal to today's values → zero visual diff on migration); expose `heartbeat` proxy read in each hero breather's `update`.
- **Perf:** zero fill-rate. Fewer tweens than today (shared clock replaces independent loops).
- **Slots:** **NEW foundation phase, built alongside P0** (hard gate, exactly like `theme.ts`) — *before* P1/P5/P6 so they consume tokens.

### E2 — Adaptive quality governor + on-device dev HUD + background-pause — **M**
- **What:** a global `QUALITY ∈ {high,med,low}` every `create()`/spawn reads, seeded from device hints + a boot timing probe and auto-demoting on sustained <52fps (`low` freezes aurora static, drops rays/bokeh, halves particle caps, kills board shimmer). Plus a dev-only fps/draw-call/est-FSE overlay, and `visibilitychange` → pause tweens/emitters + `ctx.suspend()` audio.
- **Why high-impact:** this is what lets **full juicy ship on an A14 and a guaranteed 60 on an A9 from one build** — it converts §5's fixed budgets into adaptive ones, so every juice/atmosphere item below becomes *safe because this exists*. The HUD makes checklist #8 (the mandatory A9 soak) measurable instead of eyeballed. Background-pause stops a backgrounded PWA cooking the battery.
- **How:** small standalone `src/view/quality.ts`; sample `game.loop.actualFps`; wire `document.hidden` handler in `main.ts`.
- **Perf:** the enabler for everything. Maps `prefers-reduced-transparency`/`Save-Data` → `low` (reduced-*fill* sibling of reduced-motion).
- **Slots:** **NEW, land before P4** so the atmospheric phase is verified against live on-device numbers. RT-bake (E13) folds into P4; atlas (E13) into P2/P3.

### E3 — Audio-Visual Cohesion track (the entire missing audio layer) — **L (as a track)**
- **What:** the 9-phase overhaul has **no audio at all** — every new visual beat ships silent, and the 4 themes sound identical. This track gives each beat a partner and makes the themes four *rooms you can hear*. Foundation → per-beat, in order:
  - **A1 shared reverb/space bus** — one algorithmic FDN (3–4 `DelayNode`s, the `swapAurora` shimmer generalized) as a `reverbSend`; every one-shot drops a tail into the same lounge (the sonic vignette).
  - **A2 ambient bed** — warm detuned pad + low room-tone under one LFO *whose period matches the backdrop breath*; toggle-gated, suspend on blur.
  - **A3 theme audio palettes** — add a tiny `audio{}` block to the `Theme` interface (bedRoot, waveBias, filterWarmth, reverbMix); Golden=warm sine, Ton's Heart=softer/higher/more reverb, Rose Midnight=darker/longer tail, Neon Vegas=saw bias + cyan shimmer. P8's `scene.restart()` rebuilds the bed in the new palette **for free**.
  - **A4 ducking** — bed inhales under `winFanfare`/`jackpotStrike`/`bombBoom`.
  - **A10 harmonic key-lock** — snap all pitched voices (pop climb, coinCount, dings) to C-pentatonic on `bedRoot` so busy cascades *arpeggiate consonantly*.
  - **A8 positional stereo pan** — `pop`/detonations pan by board column; the clear you see right you hear right.
  - **Per-beat partners:** `uiPress()` down-thock on P1 pointerdown, `whoosh()` on P5/P6 scene fades + panels, clear-pop "tink", special-birth charge shimmer, score-tick, reel-landing clunks, `land()` height-mapped thunk (see E5), `cascadeRiser()` (see E11).
- **Why high-impact:** the single biggest cohesion win in the whole program — nothing lands silent, and the theme picker becomes multi-sensory.
- **Perf:** **entirely off the fill-rate budget.** Voice polyphony tamed by the existing master compressor; only discipline is suspend-on-blur.
- **Slots:** **NEW parallel track "Phase A," runs alongside P0–P8** — A1–A4 land early (touch only `sfx.ts` + a tiny `theme.ts` interface add, zero scene-file contention); partner beats land *with* their visual phase (A-press with P1, whoosh with P5/P6, clear-pop with P3).

### E4 — The Heartbloom + Ton leitmotif (the ownable signature win) — **M**
- **What:** replace the generic big-win beat (fireworks+confetti+coins) with the game's memorable hero moment — on PERFECT wins, jackpot strikes, and the daily claim, a giant translucent **heart of light blooms from board-center, beats twice (lub-DUB), and heart-particles stream from its apex**, under a 3-note "Ton" leitmotif that plays *nowhere else*.
- **Why high-impact:** this is the identity the 9 phases lack entirely — the thing people remember and hum. Promotes the heart from decoration to the win's structural keystone.
- **How:** bake one `heartglow` texture (feathered heart via `fillPoints` at ~10 falling-alpha passes, same trick as `bgglow`); ADD, tint bloom/accent, double-`Back.easeOut` scale envelope matching Home's existing 620/340 heartbeat; fire in `runWinSequence` Beat 1 (~L1318) and `DailyBonusScene.celebrate`. `sfx.mayaMotif()` = 3 `tone()` calls with the `winFanfare` sparkle tail.
- **Perf:** 1 ADD sprite + 1 bake, transient <500ms during a win where nothing competes (~0.9 FSE, safe). Reduced-motion → single static heart, no beat.
- **Slots:** **extends P6** (motion wiring / win sequence); leitmotif rides E3's audio track.

### E5 — Weight on the three most-repeated moments: deal-in + fall-squash + landing thunk + secondary motion — **M**
- **What:** the swap, the fall, and the clear are 90% of what the player feels — make each *physical*.
  - **Board deal-in:** instead of `buildPieceLayer` placing 64 sprites at rest, rain them in column-staggered (~40ms/col) via the existing `animateFalls` machinery + `E.release` landing overshoot (the board is already grid-masked, so pieces clip to "fall from the top edge"). Best-in-class match-3 all open this way; here it's near-free.
  - **Fall squash-&-settle:** on each fall/spawn complete, scaleY 0.84→1 (~110ms `Back`), amplitude ∝ drop distance.
  - **Landing thunk:** new pooled `sfx.land()`, pitch-mapped to drop height, **throttled to one voice per settling column** so a refill reads as a rain of thunks, not mush (≤8 voices/refill).
  - **Secondary motion:** after a detonation/chunky clear, nudge the ring of *surviving* neighbors ~4–8px outward then `Back` settle (falloff by distance, cap 8–12) — "the board is physical."
- **Why high-impact:** converts "nicely animated sprites" into "objects with mass," at zero fill-rate.
- **Perf:** transforms + audio only. Reduced-motion → no squash, single soft thunk per batch, no neighbor flinch, instant board fill.
- **Slots:** deal-in = **extends P6**; squash/secondary-motion = **GameScene juice pass** folded into P6 (`animateFalls` ~L1174, `playWave` ~L939).

### E6 — Impact system: hitstop + impact frames + charge→release wind-up + trauma shake — **S–M**
- **What:** the AAA differentiators the game entirely lacks — anticipation, impact frames, and shake discipline.
  - **Hitstop** (see call #2) — freeze ~45–70ms before big explosions expand.
  - **Impact frame** — on the detonation frame, one cell-sized full-white silhouette α1→0 over ~60ms (reuse `fireball` tinted white, self-destroys, caps at 1).
  - **Charge→release** — special tiles scale-punch *down* (~0.9) + glow flare for ~70ms, then release into the existing explosion (charge → freeze → release template) with an `sfx.charge()` tick.
  - **Trauma screenshake** — replace ~6 hand-tuned additive `shake()` sites (which *stack into muddy rumble* on deep cascades) with one `addTrauma(amount, dirX?, dirY?)` accumulator decayed in the already-running `update()`; **directional** for reel/missile (horizontal blast → horizontal kick = force with a vector, not generic noise). Routes through the `punch()` a11y authority.
- **Why high-impact:** the single biggest missing juice primitive; every heavy hit suddenly *registers*.
- **Perf:** timeScale + camera transform are free; the flash is one tiny capped short-lived ADD sprite. **Net reduction** in perceived chaos.
- **Slots:** **NEW GameScene juice pass, extends P6** (`detonateBomb` ~L1094, jackpot ~L930, combo ~L964).

### E7 — Coherent lighting law + real-metal gold material module — **M**
- **What:** the coherent lighting/material pass that makes *everything already on screen* read expensive, near-zero runtime cost.
  - **One key light** — declare `LIGHT = {x:360, y:-200}`; route all ~8 baked drop-shadows through one `dropShadow()` helper so every shadow agrees where the light is (disagreeing shadows are *the* tell of cheap UI).
  - **Real metal** — a canonical `goldFace()` (stacked flat-alpha rounded rects bright-crown→deep-belly + one thin `glossHi` specular band at ~40% height) replacing flat `0xf2b234` "yellow plastic" on pills, marquee lozenge, win-card tab, payline. Tokens already exist (`goldBright/gold/goldDeep/goldDarkest/glossHi`).
  - **Dark-theme accent rim** — 1–2px `accent`-tinted inner stroke on the top edge of cards/tiles for dark themes only (neon reads expensive because of a colored lit rim). Zero cost on Golden/Ton.
  - **Board tray AO** — bake soft dark corner occlusion + under-bezel inner-shadow into the tray floor (sells "recessed" more than the bevel).
- **Why high-impact:** one material/lighting module makes the entire existing surface look like money for baked-once (zero runtime) cost, and *reduces* draw calls where shared textures replace per-instance pill graphics.
- **Perf:** all baked, +0 runtime; shares/reduces draws.
- **Slots:** **extends P1 + P3** (a shared material module in `ui.ts`/`textures.ts` consumed by both).

### E8 — Accessibility floor: settings panel + reduced-motion/flash retrofit + contrast + touch targets — **M**
- **What (non-negotiable):** the overhaul guards only *new* effects. Fix the existing surface:
  - **In-app Settings/Accessibility panel** (clone `openSoundPanel`) with persisted **Reduce Motion** (in-app override so users needn't change OS), **Reduce Flashing** (separate photosensitivity switch), **Haptics off**, and hooks for High-Contrast board / Bigger symbols. Canvas games are invisible to Dynamic Type/screen readers — in-app toggles are the *only* lever low-vision users get.
  - **Retrofit `prefersReducedMotion()`** onto every existing loop (Home heartbeat/satellites/breathe, LevelSelect pulse — currently started *even when reduced*, `cabinetGlow`, bulb chase, selected-piece + urgent-moves pulse, and `background.ts` which has **no reduced-motion handling at all**) → static resting state.
  - **Route all `shake`/`flash` through `punch()`** (no-op/halve under reduced-motion + reduce-flashing).
  - **Contrast nudge** (call #3) — one token pass, all four themes.
  - **Touch targets** — enlarge invisible hit-zones to ≥84 design-px (≥44pt) on corner chips (~27pt today), back pills (~29pt), win-card skip; keep visual art size.
- **Why high-impact:** converts the whole program from "juicy" to "juicy *and* WCAG-AA + reduced-motion-honest on all four themes" — low-effort, zero-perf, and it's the ethical floor for a gift meant to be *used* by a non-gamer.
- **Perf:** zero (hit-rect area is free; gated loops are neutral/positive).
- **Slots:** panel = **NEW, extends P8's panel family**; retrofit + contrast + touch = **hard gates folded into P6/P7** (A2/A3/A4/A5 must land *before* P8 ships dark themes, per the doc's own P7 gate).

### E9 — Personal warmth layer: `maya.ts` + hidden note + greeting + special-date + warm copy — **M**
- **What:** the emotional soul, all hidden or owner-gated (call #5). New `src/core/maya.ts` (`{name?, showName, secretMessage?, occasions[]}`) + save v6→v7 (`firstPlayDate`, `lastOpenDate`, `occasionsSeen[]`, shape-tolerant like the rest of `save.ts`):
  - **Secret love note** — long-press/4-tap the Home heart → cream+gold card + heart-shower + slow full heartbeat (reuse `openHelpPanel` recipe + `overlayHearts`). Discovered, not plastered.
  - **Time-of-day greeting** — "Golden hour" / "Still up?" keyed to `getHours()`; appends her name only when `showName`.
  - **Special-date dress-up** — `occasionFor(date)` on every `create()`: on a configured date the app quietly leans rose/heart-heavy, the daily spin guarantees generous, and a once-per-day heart-shower fires (gated by `occasionsSeen`). The "it knew" moment.
  - **Warm win/lose copy** — rotate encouragement under the rank word; swap cold "OUT OF MOVES" for kind rotating lines ("So close! One more?"). Touches *every* session.
  - **New-best ribbon** on numbered wins; **ALL CLEAR grand finale** on L100 (one-time `finaleSeen`).
- **Why high-impact:** makes the game feel like it *loves Ton back* — the retold "it knew my birthday" moment and the flip from "did you clear the chore?" to "come back soon."
- **Perf:** transient beats + copy only; no steady overdraw. Reduced-motion → static cards/hearts.
- **Slots:** **NEW warmth phase after P6/P7**; `maya.ts` + save-v7 are the foundation (build with P0-era foundations).

### E10 — Scene grammar (directional push/pop) + collect-fly + power-on boot — **M**
- **What:** spatial continuity beyond the plan's flat cream fade.
  - **Push/pop** — extend `startScene` so going *deeper* (Home→Game) fades destination in rising 24px + `E.release` settle; *back* settles down. The app gains spatial memory.
  - **Collect-fly** — when an objective decrements (`playWave` ~L939), arc a small copy of the symbol from the clear cell to its counter chip, *then* tick + pop (cap ~3/wave). The player finally sees "I cleared cherries → the counter dropped."
  - **Power-on boot reveal** — the machine *wakes up*: heart draws in, one gold sweep reveals the wordmark, marquee bulbs cascade-light, warm glow blooms (all existing objects; gate to actual boot entry). The app's recognizable open.
- **Why high-impact:** first-impression identity + core-loop legibility; the Candy-Crush "the level I picked opened into the board" feel.
- **Perf:** transforms + transient capped glow; reuses existing textures/emitters/masks.
- **Slots:** push/pop **replaces/extends P5/P6's flat fade**; collect-fly = P6 GameScene; power-on = P6 Home (leave BootScene hard, choreograph Home's first entrance).

### E11 — Cascade connective tissue: continuous combo counter + riser + match-size weighting — **M**
- **What:** make a long chain feel like one crescendo, not discrete pops. A single persistent combo counter that *punches in place* and color-ramps warm→hot (x2→x3→x4) instead of spawning fresh text per wave; a low `sfx.cascadeRiser()` bass bed ratcheting per wave and resolving into `winFanfare` (ties audio arc to visual arc); and **first-wave feedback weighted by run length** (a 5-match gets brighter flash + extra spark + a touch of trauma *before* any cascade, so length reads as weight instantly).
- **Why high-impact:** the busiest, most-satisfying moments currently feel flat/binary; this gives them an arc.
- **Perf:** one reused text object + one audio voice; particle counts already capped. Reduced-motion keeps counter, drops color pulse/riser.
- **Slots:** **extends P6** (`showCombo` ~L1969, `playWave`); riser rides E3.

### E12 — Special-piece legibility + high-contrast board mode — **S–M**
- **What:** a bomb/missile signals *which color it clears* mainly via a thin color-only ring + a tiny ~10–23px glyph, and the armed halo is gold regardless — colorblind/low-vision players can't tell them apart. Enlarge the embedded glyph / stamp a high-contrast corner badge; make the armed-glow tint follow `SYMBOL_TINT`. Plus a **high-contrast board toggle** (darker `WELL_FLOOR` + 1px cell separators + thicker selection ring) — since P3 tiles are one white texture + per-tile tint, it's just a second tint set, no new draws.
- **Why high-impact:** the specials are the highest-stakes reads on the board; this is core-loop clarity for the exact player this gift is for.
- **Perf:** baked, zero.
- **Slots:** legibility = **extends P3** (`textures.ts` ~L322/335/443/458); HC board = **feeds E8's settings panel**.

### E13 — Steady-state perf: RT backdrop bake + symbol atlas + emitter pooling + shine-proxy — **M**
- **What:** the honest fixes behind the doc's optimistic claims. Bake wash+vignette+corner-bokeh+watermarks into **one `RenderTexture`** so the static half of the depth ladder collapses from N translucent draws → 1 opaque blit (biggest steady-state overdraw win). Pack per-key 128² symbol/special DTs into **one atlas** (mixed board ~6–8 draws → 1 — the doc *claims* 1–2 but ships 6–8). **Pool** the mid-cascade emitters (missile-trail/fire/fireworks/confetti/hearts currently `new`+`destroy` at the busiest frame → GC hitch). One global shine-proxy tween keeps all gloss in phase.
- **Why high-impact:** buys back the fill-rate headroom that funds E4/E6/E11's transient light on old hardware.
- **Perf:** pure wins.
- **Slots:** RT-bake **inside P4**; atlas **inside P2/P3 texture track**; pooling **GameScene, with P6**.

### E14 — First-run onboarding + idle-hint ship + CSS letterbox frame — **S–M**
- **What:** a gentle first-launch overlay ("swipe two neighbors to match 3") gated on `seenIntro`; **ship the idle hint now** (P6-3d) — `board.findFirstValidMove()` already exists but is DEV-only — pulse a valid pair after ~5s idle (reduced-motion → static ring); pulse the `?` chip once on first run. Plus a **CSS radial-gradient warm frame** on `<body>` so the FIT letterbox bars (large on iPad) read intentional — *literally free* (browser compositor, zero FSE).
- **Why high-impact:** a stuck first-timer (Ton) currently gets nothing; the letterbox frame is free premium on every non-9:16 device.
- **Perf:** transient / free.
- **Slots:** onboarding **extends P6**; letterbox = **extends P0's `applyPageChrome`** (flat `pageBg` → gradient).

### E15 — Proscenium frame + streak-milestone celebrations + daily-spin anticipation — **S–M**
- **What:** a shared arched **proscenium crown with the heart as keystone** + bottom console lip, drawn at identical margin coords on all four scenes so they feel like *the same machine* (baked once, margin-confined, negative depth). Plus tiered streak-milestone flourishes (7/30/100-day) and slot-machine **third-reel suspense** on the daily spin (longer settle + near-miss shimmy — the cheapest dopamine in casino design, on the daily return hook).
- **Why high-impact:** framing unifies the app silhouette; the spin/streak beats reward the return loop.
- **Perf:** baked static frame (margin-confined); spin/streak reuse existing emitters/tweens.
- **Slots:** proscenium = **NEW `addProscenium` beside `addCasinoBackdrop`, extends P4**; spin/streak = warmth phase (E9-adjacent), DailyBonusScene.

---

## SIGNATURE MOMENTS (the memorable beats)

1. **Power-on (first open).** BootScene→Home is choreographed as the app's identity reveal: heart draws in → single gold sweep unveils the VIVA·TON wordmark → marquee bulbs cascade-light left-to-right → warm glow blooms → button stagger → an audio "power-on" swell tinted by the active theme. (E10 + E3-A12)
2. **The Deal-In (every level start).** 64 tiles rain into the recessed gold tray column-by-column with `E.release` overshoot and a per-column rain of height-mapped thunks — the board *assembles* instead of blinking on. (E5)
3. **The Heartbloom (the hero win).** On PERFECT / jackpot / daily claim, a giant heart of light blooms from center, beats twice (lub-DUB), streams heart-particles from its apex, under the 3-note Ton leitmotif heard nowhere else — the "you did it" people hum. (E4)
4. **The Mega-Combo strike.** A special fires: charge (scale-down + glow flare + rising `charge()` tick) → **hitstop freeze** → release into explosion + a single crisp white impact frame + a *directional* trauma kick along the blast axis + the cascade riser resolving into fanfare. Anticipation buys the impact. (E6 + E11)
5. **"It knew" (special dates).** On her birthday/anniversary the app opens already dressed up — rose-leaning backdrop, occasion greeting, a guaranteed-generous spin, a once-that-day heart-shower. The moment that gets retold. (E9)
6. **ALL CLEAR (level 100).** A bespoke one-time crescendo before the win card — full marquee celebration, a lingering heart shower, a heartfelt line, and (owner-gated) a personal sign-off. The finale a 100-level journey earns. (E9)

---

## AUDIO-VISUAL COHESION (non-negotiables)

- **Every new visual beat gets an audible partner** — no button depress, scene fade, clear-pop, special-birth, score-punch, reel-landing, or theme swap ships silent (E3 partner beats).
- **One shared acoustic space** — the reverb bus (E3-A1) makes disparate one-shots sound like one lounge; the audio equivalent of the vignette.
- **The four themes are four rooms you can hear** — theme `audio{}` palettes (E3-A3) rebuild the bed on `scene.restart()` for free; pick Neon Vegas and the room turns electric.
- **The bed breathes with the backdrop** — the ambient LFO period matches the aurora/`cabinetGlow` breath, and phase-locks conceptually to the E1 heartbeat clock; the machine sounds "powered on."
- **Busy moments stay musical** — harmonic key-lock (E3-A10) snaps cascades to a consonant scale; positional pan (E3-A8) ties sound to the visual grid; the cascade riser (E11) mirrors the visual chain's arc; ducking (E3-A4) makes wins hit harder.
- **The leitmotif is scarce** — the Ton motif plays *only* on the Heartbloom and daily claim, so it stays special.
- **Haptics are one event with sound + visual** — routed through the same call sites (button thock→light tap, win→heavier), not authored separately.
- **All of it is procedural/zero-asset, off the fill-rate budget, mute- and ambience-toggle-gated, and `ctx.suspend()`s on tab-blur.**

## ACCESSIBILITY GUARANTEES (non-negotiables)

- **Reduced-motion is honored *everywhere*, not just in new code** — every existing loop, shake, and flash degrades to a static/instant resting state; an in-app Reduce-Motion override exists for users who can't change the OS setting. (E8)
- **A separate Reduce-Flashing switch** governs camera flash + impact frames independent of motion (photosensitivity ≠ vestibular); **≤1 concurrent full-screen ADD flash**, stacked detonations share it; no strobing/high-contrast flashes ever. (E6/E8, perf red line)
- **WCAG AA contrast on all four themes** — the token nudge (E8, call #3) is an explicit carve-out from P7's zero-diff pledge; body ≥4.5:1, large ≥3:1; no raw text-color literal drawn on the wash (dark-theme gate). Gold is a fill/bezel color, not a body-text color.
- **Touch targets ≥44pt** — invisible hit-zones enlarged app-wide; visual art unchanged. (E8)
- **Symbol identity stays shape-based, never color-only** — emoji never re-tinted (locked); specials get a non-color legibility badge; a high-contrast board mode is available. (E12, locked §4/§5)
- **Haptics are opt-out.** (E8)
- **Nothing animated or opaque ever crosses the 40–680 × 300–940 board rect.** (locked)

---

## APPENDED BUILD QUEUE (extra slices, AFTER the 9 phases — each sized for one subagent)

All commits serialize on one git tree, so parallelism = **disjoint file sets only**. `[∥group]` marks slices that can run concurrently; same-file slices are sequential. Two slices are true *foundations* and should actually land **early, alongside P0** (noted), because later slices consume them — but they're listed here as the plan's additions to the 9-phase scope.

| # | Slice | File scope (exclusive) | Depends on | Parallel? |
|---|---|---|---|---|
| **B0** | **`motion.ts` language + heartbeat clock** (E1) — create module; migrate 5 RM copies + magic durations (zero visual diff) | `src/view/motion.ts` (new); import-only touches to `ui.ts`/4 scenes | build **with P0** | foundation — land with P0 |
| **B1** | **Quality governor + dev HUD + bg-pause** (E2) | `src/view/quality.ts` (new), `src/main.ts` | — | **∥A** (standalone; land before P4) |
| **B2** | **`maya.ts` config + save v7** (E9 foundation) | `src/core/maya.ts` (new), `src/core/save.ts` | — | **∥A** (disjoint from B1) |
| **B3** | **Audio foundation** — reverb bus + bed + theme `audio{}` + ducking + key-lock + pan (E3-A1/2/3/4/8/10) | `src/audio/sfx.ts`, `src/view/theme.ts` (interface add) | P0 | **∥A** (disjoint; runs beside P1/P2–P3/P4) |
| **B4** | **Material/lighting module** — `LIGHT`, `dropShadow()`, `goldFace()`, dark-rim, tray AO (E7) | `src/view/ui.ts`, `src/view/textures.ts` | P1, P3 | after P1+P3 (touches both files) |
| **B5** | **Special-piece legibility + `heartglow` bake** (E12 art, E4 texture) | `src/view/textures.ts` | P3 | after P3 (with B4 if sequenced — same file, run B4→B5) |
| **B6** | **Steady-state perf** — RT backdrop bake + symbol atlas + emitter pool + shine-proxy (E13) | `src/view/background.ts`, `src/view/textures.ts`, `src/scenes/GameScene.ts` | P4, P3, P6 | after P4/P6 (RT-bake ideally folded *into* P4; atlas into P2/P3) |
| **B7** | **GameScene juice pass** — hitstop + impact frame + charge→release + trauma shake + fall-squash + secondary motion + deal-in + collect-fly + combo counter + riser + match-weighting (E5·E6·E10·E11) | `src/scenes/GameScene.ts` | P6, B0, B3 | sequential (single big file; after P6) |
| **B8** | **Heartbloom + leitmotif wiring** (E4) | `src/scenes/GameScene.ts`, `src/scenes/DailyBonusScene.ts` | B3, B7 | after B7 (GameScene) — Daily half ∥ if split |
| **B9** | **Scene grammar + power-on boot** (E10) — push/pop in `startScene`; Home open choreography | `src/view/ui.ts`, `src/scenes/HomeScene.ts` | P5, P6 | after P5/P6 |
| **B10** | **A11y retrofit + contrast + touch targets** (E8) — RM on all loops, `punch()` authority, token nudge, hit-zones | `src/view/background.ts`, `src/view/theme.ts`, `src/view/ui.ts`, all scenes | P4, P6 | **hard gate before P8**; broad-touch → sequential |
| **B11** | **Settings/Accessibility panel + HC board + onboarding + idle-hint** (E8·E12·E14) | `src/view/ui.ts`, `src/scenes/GameScene.ts`, `src/scenes/HomeScene.ts` | B10, P8 | after B10/P8 (panel family) |
| **B12** | **Warmth layer** — secret note, greeting, special-date, warm copy, new-best, ALL CLEAR finale (E9) | `src/scenes/HomeScene.ts`, `src/scenes/GameScene.ts`, `src/scenes/DailyBonusScene.ts` | B2, P7 | after B2 + P7 (scene files) |
| **B13** | **Proscenium + streak/spin beats + CSS letterbox** (E15·E14) | `src/view/background.ts`, `src/scenes/DailyBonusScene.ts`, `src/main.ts`/`index.html` | P4, B1 | after P4; letterbox ∥ (index.html) |
| **B14** | **Per-beat audio partners** — press-thock, whoosh, clear-tink, land(), charge(), score-tick, reel-clunk, haptic unify (E3 partner beats) | `src/audio/sfx.ts` + call-site hooks in `ui.ts`/`GameScene.ts`/`DailyBonusScene.ts` | B3, and each visual phase it partners | lands *with* each partner phase (P1/P5/P6/B7) |

**Ordering summary:** **B0 + B3** are foundations to land with P0. After P0, the disjoint parallel wave is **{P1}, {P2→P3}, {P4}, {B1}, {B2}, {B3}** (six disjoint file sets). Everything touching `GameScene.ts` (B6/B7/B8/B11/B12) serializes. **B10 is a hard gate before P8** (dark-theme legibility). B14's voices attach to whichever phase ships their partner visual. Net additions beyond the 9 phases: **15 slices (B0–B14)**, 2 of them foundations that co-land with P0.
