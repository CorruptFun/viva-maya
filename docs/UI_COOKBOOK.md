# UI & Polish Cookbook — Reusable Patterns

> A portable reference for building **chunky, tactile, "expensive-looking" UI** in a canvas/WebGL game
> (built against **Phaser 3.90**, but most of it generalizes to any UI). Written from the Viva Maya build;
> file/function names below point at the reference implementation in this repo (`src/view/ui.ts`,
> `src/view/textures.ts`, `src/main.ts`, `index.html`). Copy this file into any new project as a starting point.

**Prime directives that made everything look good:**
1. **Bake once, tween forever** — render every depth cue (bevel, gloss, shadow) into a texture at boot; at runtime only animate transforms (position/scale/rotation/alpha). Never synthesize gradients/bevels per frame.
2. **Fill-rate is the ceiling, not object/tween count** — on mobile GPUs the cost is *blended-fragment overdraw*. You can have hundreds of cheap tweens; what kills you is stacked translucent glows.
3. **Verify at the target device pixel ratio (DPR 2–3), not 1×** — the two worst bugs in this project were **invisible at 1×** and obvious at 2×. See §2.

---

## 1. The chunky 3D pressable button ("cap on a pedestal")

The look: a glossy beveled **cap** that sits on a darker **pedestal** and visibly **sinks into it** on press. Reference: `buildPressable()` in `ui.ts`.

**Structure (the key architectural decision):**
```
outer Container            ← returned to caller; caller owns .setDepth / breathing tweens / layout
 ├─ glow      (optional)   ← ADD blend, behind everything, for hero buttons
 ├─ baseImg   'btnbase:*'  ← the pedestal (STATIC, never moves)
 ├─ face      Container    ← the ONLY thing that moves on press
 │   ├─ faceImg 'btnface:*'← the glossy cap
 │   └─ label / icon       ← added by caller INTO face, so the glyph sinks with the cap
 └─ zone      Rectangle    ← invisible hit-area (α 0.001), FIXED, never moves
```

**Rules that make it robust:**
- **Press animates the inner `face`, never the outer container.** The caller applies its own tweens (breathing scale), `.setDepth()`, and layout to the outer container — if press moved the outer container, those would fight. Moving only `face` composes cleanly.
- **The hit-zone never moves** and is a separate rectangle. Press feedback and hit-testing are decoupled.
- **Fire the tap action on `pointerup` immediately** (before/independent of the release tween) so there's zero perceived latency. The press-down tween is cosmetic.
- **Geometry derives from height** so one function serves every size: `ext = clamp(round(h*0.12), 5, 13)` (pedestal depth), `press = round(ext*0.7)` (sink distance), `radius = h/2`.
- **Cache baked textures** by `{styleId}:{w}x{h}` in the global texture manager. Identical buttons share one texture → images batch to one draw call. Pre-warm common sizes at boot to avoid a first-paint hitch.

**Press choreography:**
| Event | Target | Props | Duration | Ease |
|---|---|---|---|---|
| pointerdown | face | y→+press, scaleY→0.95, scaleX→1.02 | 60ms | Quad.easeOut |
| pointerup/out | face | y→0, scale→1 | 200ms | Back.easeOut (~1.6) |

Reduced-motion → set the final state instantly (no tween, no squash).

---

## 2. ⚠️ Rounded-rectangle rendering gotchas (the expensive lessons)

These cost real debugging time. They apply to **any** stacked/baked rounded-rect UI, not just buttons.

### 2a. Gloss bands that poke past the cap as light "ears"
**Symptom:** two little pointed highlights at the top corners of every button/chip.
**Cause:** a top-lit gloss is often faked with stacked, top-anchored rounded-rect bands of *decreasing height*. If each band's corner radius is clamped to **its own (small) height**, the short top bands become near-square and their corners stick out **past** the cap's larger rounded corners.
**Fix:** inset each short band horizontally by how much its radius falls short of the cap radius, so it follows the cap's curve:
```ts
const rb  = safeR(r, w, bh)          // band radius, clamped to band height bh
const ins = Math.max(0, r - rb)      // how much shorter than the cap radius r
g.fillRoundedRect(x + ins, y, w - ins*2, bh, rb)
```
(Reference: `ensureFaceTexture` / `drawPillFace` in `ui.ts`.)

### 2b. Stacked shapes with **mismatched corner radii** (dark "horns")
**Symptom:** thin dark points at the corners — and they got **worse after we sharpened rendering** (see §2d).
**Cause:** the cap (`btnface`, height `h`) and the pedestal (`btnbase`, height `H = h+ext`) are stacked and meant to align at the top. But their radii were computed independently — the cap clamped to `h/2 − 1`, the pedestal to `h/2` — so the darker pedestal poked **~1px past** the cap at the corners.
**Rule:** *any two stacked rounded shapes that should share an edge must use the **same** corner radius.* Compute it once and pass it to both. We fixed it by clamping the pedestal radius against the **cap's** height, not its own taller height:
```ts
// pedestal is TALLER (H) but its corner radius must match the CAP (h):
g.fillRoundedRect(ox, oy, w, H, safeR(r, w, h))   // NOT safeR(r, w, H)
```

### 2c. Never use radius == exactly half the smallest side
Phaser's `fillRoundedRect`/`strokeRoundedRect` can spike at the corners when the radius equals *exactly* half a side (a perfect semicircle end) — the arc tessellation overshoots the tangent. Keep radii a hair under half:
```ts
function safeR(r: number, w: number, h: number): number {
  return Math.max(1, Math.min(r, w/2 - 1, h/2 - 1))   // the "-1" is load-bearing
}
```
Use this everywhere you draw a rounded rect. (This alone won't fix 2a/2b — those are about *consistency between shapes* — but it removes a whole class of single-shape corner artifacts.)

### 2d. **Verify at device DPR — artifacts hide at low resolution**
Both horn bugs were **invisible in a 1× preview** and obvious on a real DPR-3 phone. A 1px inconsistency gets softened into nothing by upscaling, then snaps into focus the moment you render crisply (§5). **Always sanity-check UI at DPR 2–3** (real device, or a 2× isolated test harness). When something "looks worse after we made it sharper," suspect a latent sub-pixel bug that sharpening merely *revealed*.

### 2e. Isolate to diagnose
When a baked-texture artifact is hard to reason about, **reproduce it in a 20-line standalone harness** (bake the exact texture, render it at large scale, bisect by toggling each draw call). We found the exact culprit — "base only: clean; face only: horns" — in minutes this way, after a long time guessing from the full app.

---

## 3. Faking depth without shaders (the procedural cookbook)

| Effect | ❌ Avoid | ✅ Cheap recipe |
|---|---|---|
| **Bevel / press** | redraw rounded-rect + shadow per press | two baked sprites: dark base plate (offset down = socket) + glossy top face; press tweens the face down + squash into the static base |
| **Gloss (static)** | live gradient / MULTIPLY overlay | bake a lighter rounded-rect over the top ~45% at α 0.3–0.4, feathered by 2–3 stacked falling-alpha fills |
| **Gloss (animated shine)** | new per-frame mechanism | one masked `sweep` sprite, bitmap-masked to the shape, a single tween with `repeatDelay` |
| **Inner shadow / recess** | — | bake dark inner stroke on the top/inner edge + light inner stroke on the bottom edge (2 `strokeRoundedRect` at ~0.15 α, inset 2–4px) |
| **Drop shadow** | — | 2–3 shadow copies nudged straight down at low α; route them all through one `dropShadow()` helper so every shadow agrees on light direction |
| **Blur / bokeh** | true Gaussian (needs a shader) | reuse a **pre-blurred glow sprite** — scale + tint + ADD; prefer fewer, larger glows |
| **Vignette** | full-screen baked texture (MB!) or MULTIPLY quad | four warm **edge gradient bands** whose overlap darkens corners; NORMAL blend, one static object |

**Phaser gradient quirk (important):** `fillGradientStyle` is reliable only on **`fillRect`**, *not* `fillRoundedRect` (it mis-triangulates). So: gradients only on plain rects; for rounded shapes, fake the gradient with **stacked flat-alpha rounded rects** (see §2a).

**Tint-stability trick** (one white texture → many colors): shade with **black-alpha**, highlight with **white-alpha**, leave the body pure white. Then a per-instance `setTint()` colors only the body while shadows stay neutral-dark and gloss stays bright. One 128² tile texture became a whole 64-cell board this way.

---

## 4. Material & lighting law (makes existing UI read "expensive" for free)

- **One key light.** Declare `const LIGHT = {x, y}` and route *every* baked drop-shadow through one `dropShadow()` helper. Disagreeing shadow directions are *the* tell of cheap UI.
- **Real metal, not flat plastic.** A gold surface = stacked flat-alpha rounded rects from a **bright crown** at the top to a **deep belly** at the bottom, plus **one thin specular band** at ~40% height. Reference: `goldFace()`.
- **Colored lit rim on dark themes only.** A 1–2px accent-tinted inner stroke on the top edge of cards makes neon/dark UI read expensive; no-op it on light themes.

---

## 5. High-DPI crispness (the retina fix)

**Problem:** a game authored at a fixed logical size (e.g., 720×1280) with `Scale.FIT` renders into a **backing store of that size** and CSS-upscales it to the physical screen. On a DPR 2–3 phone that's a 1.6–3× upscale of *everything* → soft/pixelated.

**Fix (keep the logical world, enlarge only the backing):** Reference: `src/main.ts`.
1. Compute `renderScale = clamp(devicePixelRatio, 1, CAP)` with `CAP = 2` (a 3× phone renders at 2× — crisp enough, bounded fill-rate). Drop to `1` on the weakest quality tier.
2. Enlarge the **canvas backing store + WebGL viewport** to `renderScale×`, but keep the **projection/logical size** at the design resolution so pointer coords and every scene's layout are unchanged — *nothing moves in world space; the GPU just rasterizes into a bigger buffer.*
3. **Text:** patch the Text factory once at boot so every `add.text` defaults to `resolution = renderScale` — crisp glyphs with **zero call-site edits** (text `width/height` stay resolution-independent, so layout is unchanged):
   ```ts
   const orig = Phaser.GameObjects.GameObjectFactory.prototype.text
   Phaser.GameObjects.GameObjectFactory.prototype.text = function (x, y, t, style) {
     const s = style ?? {}
     if (s.resolution === undefined) s.resolution = renderScale
     return orig.call(this, x, y, t, s)
   }
   ```
4. **Textures:** bake emoji/symbol/glyph textures at **2× native** (e.g. `TEX_SIZE 128 → 256`). This costs only texture memory (no per-frame fill), and sharpens anything shown large. **Compensate any code that assumed the old native size** — particle `scale`, sprites sized by `nativeSize/…` ratios, etc. (This is easy to forget; grep for the old size constant.)
5. Make it **governor-aware** so weak devices fall back to 1×.

**Verify at DPR 2–3.** (Same lesson as §2d — this is also what *exposes* latent sub-pixel UI bugs, so do §2 and §5 together.)

---

## 6. Screen fit — fill a tall phone with a fixed-aspect game

A fixed 9:16 (720×1280) game letterboxes hard on a ~19.5:9 phone. To make it feel full-screen:
- **Warm brand frame behind the canvas.** A full-viewport radial gradient on `<body>` (cream center → warmer edges) so the letterbox reads as an intentional frame, not empty bars. Add a soft drop-shadow on the canvas so it looks like a framed screen resting on the surface.
- **Lock the page:** `position:fixed; inset:0; overflow:hidden; overscroll-behavior:none; touch-action:none` — no scroll, no iOS rubber-band.
- **Safe-area insets, selectively.** Keep **left/right** insets (landscape notch protection) but **drop top/bottom** so the canvas reaches the true top/bottom edges and fills a tall phone — *safe when the design's top/bottom bands are empty margin and the FIT letterbox adds further buffer*, so real content (board/HUD) never reaches the notch or home-indicator. Reference: `index.html` `#frame`.
  - Gotcha: a `position:fixed` element's `height:100%` resolves against the viewport, *ignoring its own top/bottom* — so insets that must affect height belong on an **outer wrapper**, not on the element the scale-manager forces to `width/height:100%`.

---

## 7. Design tokens + theming

- **One token module.** Store graphics colors as **numbers** (for `fillStyle`/`setTint`) and text colors as **CSS strings** (for `Text`); bridge with a `css(n)` helper. One source of truth beats ~60 scattered hex literals.
- **Themes = base + overrides.** Define the default theme as the complete base, then `{...base, ...overrides}` for each variant (guarantees no missing key at compile time).
- **Keep cards light on every theme.** Only the backdrop wash, glows, accents, and a dedicated pair of **`onBackdrop*` text roles** diverge. Text drawn directly on the wash (not on a card) must route through `onBackdrop*` so it can flip light on dark themes — that's the whole dark-theme legibility fix.
- **Apply by repaint, not live re-tint.** Themes only change colors read at `create()`; switching a theme calls `setTheme(id)` then `scene.restart()`. Enumerate-and-re-tint is high-surface-area for a rarely-changed setting; a restart is simpler and bulletproof.

---

## 8. Motion language

- **Tokenize timing like you tokenize color.** A `motion` module with duration tokens (`D.micro…breath`), named brand eases (`E.press/pop/hero/…` — *calibrated* overshoots, not one anonymous `Back.easeOut`), and a single shared **heartbeat clock** so all "breathing" elements pulse in phase (an incoherent shimmer is the tell of ad-hoc motion).
- **Scene transitions:** a single `startScene(from, key)` helper that fades the camera to **brand cream, never black**, and starts the destination on fade-out complete; each scene's `create()` pairs it with a `fadeIn`. The input-lock during the fade **doubles as the anti-double-tap guard**.
- **Idle micro-life composition rules:** effects *yield* to celebration; ≤1 hero "breathe" per screen; transient idle effects are mutually exclusive by state (a hint only in `idle`, impact beats only in `resolving`). This is what keeps "juicy" from becoming "noisy."

---

## 9. Accessibility floor (cheap, and the ethical baseline)

- **Reduced-motion, honored everywhere** — not just in new code. An in-app override (OS query **OR** a user toggle) so people needn't change the OS setting. Every loop/shake/flash degrades to a static resting state.
- **A separate "reduce flashing" switch** (photosensitivity ≠ vestibular) and **haptics-off**. Route *all* screen shake/flash through one `punch()` authority that respects both; cap at **≤1 concurrent full-screen flash**; never strobe.
- **Touch targets ≥44pt.** Grow the **invisible hit-rectangle** to a minimum (e.g. `max(w, 84)×max(h, 84)` design-px) while leaving the visual art its authored size.
- **Contrast:** gold (and other bright accents) are **fill/bezel colors, not body-text colors** — use a darker variant for text on light cards (WCAG AA: body ≥4.5:1, large ≥3:1). One token pass fixes all themes if cards stay light everywhere.

---

## 10. Performance discipline

- **Adaptive quality governor.** A global `tier ∈ {high, med, low}` seeded from device hints + a boot timing probe, auto-demoting on sustained low fps. Every spawn/effect reads it; `low` freezes ambient animation, drops the render scale to 1× (§5), and halves particle caps. One build ships crisp on strong phones and a guaranteed-smooth fallback on weak ones.
- **Pause the loop when backgrounded** (`visibilitychange` → `game.loop.sleep()` + suspend audio). Biggest battery win; nothing renders/tweens while the tab is hidden.
- **Zero `graphics.clear()`/redraw in any `update()`/RAF.** If it's animating, it's a transform on a baked texture, not a re-draw. Keep a grep clean.

---

## Copy-paste QA checklist (run before shipping any UI change)

- [ ] Viewed at **DPR 2–3** (real device or 2× harness), not just a 1× preview.
- [ ] No two **stacked** rounded shapes have **mismatched corner radii** (§2b).
- [ ] No rounded-rect radius equals **exactly** half its smallest side (§2c).
- [ ] Short top-anchored gloss bands are **inset** so they don't poke past the cap (§2a).
- [ ] Every baked **drop-shadow** points the **same** direction (one `LIGHT`).
- [ ] Text is **crisp** at device DPR (Text-factory resolution patch present).
- [ ] Bumped a `TEX_SIZE`? Grep for the old constant and fix dependent scales (§5.4).
- [ ] Board/HUD/content **never clipped** and never under the notch after fit changes.
- [ ] Buttons fire the tap on `pointerup` with **zero latency**; press animates only the inner face.
- [ ] Every new animation has a **reduced-motion** static fallback.
- [ ] No `graphics.clear()` in any `update()`; loop pauses when backgrounded.
- [ ] Touch targets ≥ 44pt (hit-rect grown, art unchanged).

---

*Reference implementation: Viva Maya (`src/view/ui.ts`, `textures.ts`, `theme.ts`, `motion.ts`, `quality.ts`, `background.ts`, `src/main.ts`, `index.html`). See also `docs/VISUAL_OVERHAUL.md` and `docs/ULTIMATE_UIUX.md` for the full design system this cookbook distills.*


## Rounds 1–4 interaction vocabulary (2026-07)

New patterns; reuse these instead of inventing near-duplicates. All are reduced-motion
collapsible, reduceFlashing-aware where they flash, governor-scaled where they spawn.

- **Pressables** (`ui.ts buildPressable`): press = sink + cap-silhouette tap-flash;
  release = springy `backOut(OVERSHOOT.release)` rise + masked specular shine sweep;
  heroes add `juice` (glow ring + periodic sheen) or `sheen` alone.
- **Scene transitions**: `startScene` cream cross-fade now carries a directional
  `lightWipe` ('deeper' rises, 'back' settles); Home PLAY adds `launchBloom` (radial
  gold from the button, composes with the C6 shared-element focus).
- **Ambient**: `fx.addScreenGloss` (whisper vignette + heartbeat-locked light-leaks);
  `heartbeat.amp()` is the ONE clock for all idle pulsing (never a private yoyo).
- **Board feel**: depth stack (softshadow slab float, elevated HUD rail, recessed
  wells), squash-and-settle refill, level-intro card → diagonal build-in wave
  (input gate ≤~1.5s, tap-to-skip snaps to rest).
- **Reward beats**: escalating score medallions (pooled, cap 4); collect comets with
  impact tick on the goal readout; cascade edge-glow heat ramp (gold→amber→rose);
  camera breath on big clears (composes with hitstop).
- **Celebration family** (one language, three sizes): coronation (crown descent +
  confetti + count-up), friend-joined toast queue (max 2/visit), welcome toast with
  chip-fly. Always: celebrate FIRST, then claim/award — a crash re-offers.
- **Jackpot wheel**: crouch → accel blur → decel ticks → near-miss creep → detent;
  payoff = gold burst (or reduceFlashing swell) + chip fountain INTO the balance pill
  + marquee letter-punch. Skips must snap the rig to rest scale (see the round-4
  early-tap fix) — never leave a killTweensOf without restoring end state.
- **Free spins**: golden-ticket punch-out at MEGA (distinct from medallions), corner
  counter, chained cabinet spins with accelerating bulb chase.
- **Panels**: leaderboard panel = the canonical rich-panel reference (podium bakes,
  state machine incl. loading shimmer/error/empty, heartbeat own-row breathe gated
  until entrance completes).
