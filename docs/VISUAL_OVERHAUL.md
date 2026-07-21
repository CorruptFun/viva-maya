# Viva Ton — Visual Overhaul: Full-Juicy Design & Orchestration Plan

> Authoritative design spec for the "make it ALIVE with real depth and premium gloss" overhaul.
> Zero binary assets. All depth is faked with layered graphics + `generateTexture` + tweens — there are no shaders.
> Principal-engineer assembly of five specialist sections (buttons, background, board, tokens/theme, motion, perf).

---

## Table of Contents

1. [Vision & Locked Decisions](#1-vision--locked-decisions)
2. [Design-Token Layer (`src/view/theme.ts`)](#2-design-token-layer)
3. [Subsystem Architectures](#3-subsystem-architectures)
   - [3a. Chunky 3D Button/Component System](#3a-chunky-3d-buttoncomponent-system)
   - [3b. Atmospheric Background / Depth](#3b-atmospheric-background--depth)
   - [3c. Board Depth + Glossy Tiles](#3c-board-depth--glossy-tiles)
   - [3d. Motion + Scene Transitions](#3d-motion--scene-transitions)
   - [3e. Theme System + the 4 Concepts](#3e-theme-system--the-4-concepts)
4. [Procedural-Depth Cookbook](#4-procedural-depth-cookbook)
5. [Performance Budget, Regression Checklist & Do/Don't](#5-performance-budget-regression-checklist--dodont)
6. [Phased Implementation & Orchestration Plan](#6-phased-implementation--orchestration-plan)
7. [Risks & Open Decisions for the Owner](#7-risks--open-decisions-for-the-owner)

---

## 1. Vision & Locked Decisions

Adapt the *production feel* of a Coin-Master-style slot reference — real depth, premium gloss, buttons that visibly depress, a scene that breathes — **without** its dark/garish content or pay-to-win HUD. Keep the warm "modern slot screen" brand (bg `#f6f3ec`, gold `#f2b234`/`#c9930a`, rose `#d3304f`, navy `#26304d`, cream `#fffdf8`, heart motif).

### The three LOCKED decisions

| # | Decision | What it means concretely |
|---|---|---|
| **1** | **FULL JUICY OVERHAUL** | Bold glossy 3D. Chunky beveled buttons that sink into a pedestal on press. Dramatic-but-tasteful lighting. |
| **2** | **ATMOSPHERIC WARM LIGHT** | Abstract lounge depth — top spotlight, drifting light rays, blurred bokeh, vignette, warm colored light-bleed. **Not** a literal environment scene. |
| **3** | **EMOJI ON GLOSSY TILES** | Keep the emoji symbols; seat them on dimensional glossy cream tiles in a recessed gold tray. Zero-asset stays. |

### Non-negotiables (every phase honors these)

- **Procedural / zero-asset** — no image or audio files. All art is `graphics`/`generateTexture`/`DynamicTexture`; ≤ 4 new baked textures for the whole overhaul.
- **Mobile-perf-safe** — target A9–A11 iPhones as an installed PWA. The budget is **blended-fragment overdraw (fill-rate)**, not object/tween count (§5).
- **Warm brand preserved** — no cool/dark tints on the default theme; vignette is warm-brown, never black. Cards, board cabinet, gold bezel, and result cards stay cream+gold on *every* theme.
- **Board readability** — nothing animated or opaque is added over the 8×8 grid (40–680 × 300–940). Emoji stay opaque, full-contrast, never re-tinted. Every ambient light layer lives at negative depth or is clamped to the margins.

---

## 2. Design-Token Layer

**New module: `src/view/theme.ts`.** The foundation everything else reads from. Colors were already de-facto centralized but scattered across ~68 literals in 8 files; this module makes them one source of truth and the substrate for the theme system.

### 2.1 Contract (mirror `src/audio/sfx.ts` persistence, decoupled from `save.ts`)

```ts
export type ThemeId = 'golden' | 'roseMidnight' | 'neonVegas' | 'mayaHeart'
export interface Theme { id: ThemeId; name: string; /* ~60 flat tokens, §2.2 */ }

export const css = (n: number): string => '#' + (n & 0xffffff).toString(16).padStart(6, '0')
const THEME_KEY = 'viva-ton:theme'
export const DEFAULT_THEME_ID: ThemeId = 'golden'
export const THEME_ORDER: ThemeId[] = ['golden', 'mayaHeart', 'roseMidnight', 'neonVegas']
export const THEMES: Record<ThemeId, Theme> = { /* §3e */ }

let _themeId: ThemeId = readThemeId()          // try/catch localStorage, validate against THEMES
export function getThemeId(): ThemeId { return _themeId }
export function getTheme(): Theme { return THEMES[_themeId] }
export function setTheme(id: ThemeId): void {   // writes localStorage + applyPageChrome()
  if (!(id in THEMES)) return
  _themeId = id; writeThemeId(id); applyPageChrome(THEMES[id])
}
// Canonical home for the 5 duplicated copies — re-export, delete the rest:
export function prefersReducedMotion(): boolean { /* matchMedia guard */ }
```

The store is **save-agnostic** (like `sfx`): one `localStorage` key, shape-tolerant, no save-schema migration. Unlock gating is enforced only in the picker at selection time — never inside `getTheme()`.

### 2.2 Token families

Phaser needs **numbers** for `fillStyle`/`lineStyle`/`setTint` and **CSS strings** for `Text` color. Store graphics colors as numbers, text colors as strings, bridge with `css()`.

| Family | Example tokens | Notes |
|---|---|---|
| **Atmosphere** | `washTop`, `washBottom`, `washGlowWarm`, `washGlowCool`, `rayTint`, `rayTintCool`, `bokehWarm`, `bokehCool`, `marqueeDim`, `marqueeBright`, `sparkleTint`, `moteTint`, `suitWatermark`, `scrim`, `vignetteInk` | numbers → backdrop fills/tints |
| **Brand accents** | `gold`, `goldBright`, `goldBezel`, `goldDeep`, `goldDarkest`, `rose`, `roseLight`, `roseDeep`, `navy`, `accent`, `accentAlt` | numbers |
| **Surfaces** | `cardFill`, `cardFillWarm`, `cardFillAlt`, `border`, `shadow`, `cabinetGlow`, `bloom`, `bleedWarm`, `bleedCool` | numbers — **cards stay LIGHT on every theme** |
| **Gloss** | `glossHi`, `glossLo`, `rim` | numbers — consumed by tiles & buttons; colors only, geometry lives in those specs |
| **Text (on cream)** | `ink`, `inkSoft`, `inkMuted`, `inkFaint`, `goldText`, `goldPillText`, `navyText`, `onRose`, `warn`, `ok` | CSS strings — dark on cards, stay dark on all themes |
| **Text (on backdrop)** | `onBackdropInk`, `onBackdropMuted` | CSS strings — **flip light on dark themes** (the key dark-theme legibility fix) |
| **Page chrome** | `pageBg` | body bg + `<meta theme-color>` + game `backgroundColor` |

**Why `onBackdrop*` is its own role (critical):** most text sits on cream cards and stays dark forever, but a handful is drawn directly on the wash (Home sub-headline + lives timer, LevelSelect header, DailyBonus title/footer, GameScene "TAKE A BREAK"). On the dark themes the wash goes near-black, so *only* those texts must flip light. Routing them through `onBackdropInk`/`onBackdropMuted` is the whole fix.

### 2.3 Never tokenize (structural, not brand)

`SYMBOL_COLORS` (config.ts); all `symbol`/`chip`/`spark`/`ring`/`sweep`/`bulb`/`card`/`jackpot`/`heart`/`star` art in `textures.ts`; mask fills (`fillStyle(0xffffff)` before `createBitmapMask`/`createGeometryMask` — luminance-keyed); invisible hit-zones (`0xffffff, 0.001`); and the RNG seeds `0xc0ffee`/`0x01000193` in `levels.ts`/`endless.ts` (not colors).

### 2.4 Apply model — **next-scene-load repaint**

Themes only change colors read at `create()`. Picking a theme calls `setTheme(id)` then `scene.restart()` (track the id on open; restart only if it changed). No live re-tint (every surface is imperative baked graphics with no central registry — enumerate-and-redraw is high surface area for a rarely-changed setting). **Boot textures are never re-baked** — symbols/chip/spark/etc. carry Golden-Hour warmth permanently and read fine on all four washes because they always sit on cream cards or as warm ADD-light. A theme swap needs only `scene.restart()` + `applyPageChrome()`.

```ts
export function applyPageChrome(T: Theme): void {
  try {
    document.body.style.background = T.pageBg
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', T.pageBg)
  } catch {}
}
```

---

## 3. Subsystem Architectures

### 3a. Chunky 3D Button/Component System

**File: `src/view/ui.ts`.** Redesign `addPillButton` + the round chips + `addChipPill` so every control reads as a tactile beveled **cap on a darker pedestal** that visibly **depresses into the base** on press. **API and `PillStyle` shape are preserved** — all ~30 call sites keep working untouched; one optional trailing `opts` arg is additive.

**Core structural rule:** callers apply their own outer tweens (`scale:1.05` breathing) and `.setDepth(...)`/`.setVisible(...)`/`card.add(...)` on the returned container. So **press animates an inner `face` container, never the outer container** — the hit-zone never moves and caller tweens compose cleanly.

**Two baked textures per (style, size), stacked cap-centered:**

```
outer (returned Container at x,y)
 ├─ glowRing   (only if opts.juice) — bgglow Image, ADD, behind base
 ├─ baseImage  'btnbase:{id}:{w}x{h}'  — pedestal + fake soft shadow + interior well (STATIC)
 ├─ face (Container)                    — the ONLY thing that moves on press
 │    ├─ faceImage 'btnface:{id}:{w}x{h}' — glossy cap: gradient + bevel + gloss dome + specular + rim
 │    └─ label (Text, with bottom-emboss shadow)
 └─ zone   (Rectangle w×h, α 0.001, interactive) — fixed, never moves
```

Geometry derives from height `h` (so 56→96 all look right): `ext = clamp(round(h*0.12),5,13)` pedestal depth, `press = round(ext*0.7)` sink distance, `r = h/2` (stadium — matches every call site).

**Press animation** (kill in-flight face tween first):

| Event | Target | Props | Duration | Ease | Side effect |
|---|---|---|---|---|---|
| `pointerdown` | `face` | `y:0→press`, `scaleY→0.95`, `scaleX→1.02` | 60ms | `Quad.easeOut` | — |
| `pointerup` | `face` | `y→0`, `scaleY→1`, `scaleX→1` | 200ms | `Back.easeOut` (~1.6) | `sfx.uiTap()` + `onTap()` fire **immediately** (zero-latency preserved) |
| `pointerout` | `face` | (same as up) | 200ms | `Back.easeOut` | — |

The revealed dark `well` at the cap top + the squash sell the depression; no dark scrim needed.

**Extended `PillStyle`** (all new fields optional; derived from `fill`/`border` via a `shade(color,t)` helper when omitted, so ad-hoc styles keep working): `id, top, bottom, pedestal, pedestalDeep, well, outline, rim, spec, emboss`. Art-directed token tables for GOLD/ROSE/GHOST are in the buttons spec; ship them explicitly rather than relying on derivation.

**Opt-in extras (no migration required):**
- `opts.juice: true` → hero buttons (PLAY/SPIN) get a breathing `bgglow` ring (ADD, behind base) + optional masked `sweep` idle shine. Replaces callers' manual `scale:1.05` breathing.
- `opts.disabled` + a `setDisabled(v)` method on the returned container → desaturated `:off` texture variants + gated `onTap`. Lets Daily's spin button dim during a spin.

**Round chips** (`addMuteChip`/`addHelpChip`/`addSoundChip`) get the same treatment, circular: pedestal = a circle extended down by `ext_c`, face = glossy dome with sheen + specular dot + rim. Icons (`🔊`/`🔇`/`?`/`♪`) live in the `face` container and sink with it. Stay GHOST-subtle so they don't fight the board.

**`addChipPill`** (self-sizing HUD balance read-out — **not** a press button) keeps per-instance graphics (redrawn only on payout) with a **shallow** dimensional gloss face (no press). Factor the gloss recipe into a shared `drawPillFace(g, x, y, w, h, tokens)` reused by `addStreakBadge` and future win-card lozenges.

**Perf:** textures cached in the global `TextureManager` keyed `{id}:{w}x{h}[:off]`; ~18–22 tiny pairs app-wide, shared across scenes/identical buttons. Images batch (Graphics don't), so the picker's 5 identical rows go 5 draws → 1. Pre-warm frequent signatures via `warmButtonTextures(scene)` from `createAllTextures` to avoid a first-paint hitch. Reduced-motion → instant sink, no squash/spring/shine.

### 3b. Atmospheric Background / Depth

**File: `src/view/background.ts`** (`addCasinoBackdrop(scene, variant)`), with one new texture in `textures.ts`. Fake volumetric depth with **six stacked translucent light planes** between the flat wash and the opaque cabinet, each on a different parallax rate/period so the eye reads separation.

**Depth ladder (all negative — the mechanical guarantee no light plane crosses in front of a symbol; gameplay content is depth ≥ 0):**

| Depth | Layer | Blend |
|---|---|---|
| −60 | L1 wash gradient fill (static, no tween ever) | NORMAL |
| −56 | L2 aurora breathing glows | ADD |
| −54 | L7 warm board light-bleed (game only, under cabinet) | ADD |
| −52 | L3 spotlight hotspot + floor pool | ADD |
| −50 | L3 cone blades + L4 god-rays | ADD |
| −48 / −46 | L5 mid-field / corner bokeh (parallax tiers) | ADD |
| −44 / −42 | L9 suit watermarks / falling sparkle | NORMAL / ADD |
| −34 | L6 vignette | NORMAL |
| −30 | L8 marquee chase dots | NORMAL |

**Alpha discipline** (reconciles "full juicy" with "never wash out a symbol") — two ceilings:
- **Board-adjacent** (bbox can overlap the grid): **α ≤ 0.10**.
- **Margin-confined** (top spotlight above y=300, corner bokeh, edge marquee): **α ≤ 0.20** — this is where the drama lives, because no piece competes there.

**All light is ADD; the vignette is the single NORMAL-blend darkener; nothing uses MULTIPLY/SCREEN.**

**One new texture, `raybeam`** (96×640, bright feathered top → transparent bottom, origin (0.5,0) so it pivots at the source): 3 nested vertical-alpha-gradient rects. Used for L3 cone blades and L4 god-rays. `spotcone` is an optional later fidelity bump — **ship `raybeam` only** and compose the cone from `bgglow` (hotspot) + fanned `raybeam` blades.

**Per-variant intensity** (home is heaviest; game is calmest *by construction* — every board-crossing layer is clamped to y ≤ 260 or hidden behind the cabinet):

| Layer | home | menu | game |
|---|---|---|---|
| L2 aurora | 2 (warm+cool) α≤0.11 | 2 α≤0.11 | 2 margins-only α≤0.10 |
| L3 spotlight | hotspot 0.16 + 2 blades 0.08 + pool 0.05 | hotspot 0.13 + 2 blades + pool | hotspot 0.08 + 1 clamped blade, no pool |
| L4 god-rays | 2 crossed (gold 0.09 / rose 0.06) | 1 @0.08 | 1 faint ≤0.045 clamped, **or none** |
| L5 bokeh | 4 corner + 3 mid | 4 corner + 1 mid | 4 extreme-corner α≤0.09 |
| L6 vignette | 1 static (Vt.10/Vb.16/Vs.12) | 1 static | 1 static |
| L7 board bleed | — | — | warm under-bleed 0.06↔0.10 (+ existing rose glow) |
| L8 marquee | 4 edges chase | top+bottom chase | top+bottom chase |
| L9 sparkle | emitter ~8 cap | ~6 cap | **none** |
| L9 suit drift | full | top+bottom+mid | top/bottom only |

**Vignette (L6, biggest premium-depth win, one static object):** four edge gradient bands (`fillGradientStyle` on `fillRect` — reliable per-corner alpha) in warm `vignetteInk`; overlap darkens corners more than sides. Sits *above* the light stack (contains the glow, focuses inward) but *below* marquee and all gameplay.

**L7 warm board bleed (game):** added inside `addCasinoBackdrop('game')` at depth −54, under the opaque cream card — only its edges escape the bezel as a warm halo ("the machine is powered on"). `GameScene`'s existing rose `cabinetGlow` and `flashCabinet` are **untouched**; this is the gold half of a two-tone bleed.

**Motion budget:** ~20 looping tweens on home (share one tween across paired objects — blades, bokeh tiers — and use a single-proxy tween for the ~50-dot marquee to stay lean), 1 capped emitter (menus only, stopped during wins), reduced-motion collapses to a static-but-richer-than-today composition (keeps vignette/spotlight/bleed, drops animation).

**File guidance:** restructure `addCasinoBackdrop` into per-variant recipe helpers (`washBase`, `aurora`, `spotlight`, `godRays`, `bokeh`, `vignette`, `boardBleed`, `marquee`, `sparkle`, `suits`), each reading `const T = getTheme()` / `const reduced = prefersReducedMotion()` once at top and setting its explicit negative depth. `GameScene` needs **no change** (L7 composites under the existing depth-0 glow). If theme.ts isn't landed yet, ship Golden-Hour literals inline and swap to `getTheme()` reads later (same values, mechanical find-replace).

### 3c. Board Depth + Glossy Tiles

**Files: `src/view/textures.ts` (add `makeTile`) + `src/scenes/GameScene.ts` (`buildBackdrop`).** Locked model: **RAISED glossy cream tiles seated in a RECESSED gold tray.** Both cues stack — the tray is a recessed well (opaque gold bezel + a floor *darker* than the tiles + top inner-shadow), and each of the 64 cells is a raised glossy warm-cream tile with a ~5px gutter of dark floor showing between tiles. The emoji sits ON the bright cushion (the "gem in its setting").

**Perf model:** ONE new `tile` texture (128², pure-white body so a single `setTint()` colors it), placed as **64 same-texture Images = one batched draw call, zero tweens, zero per-frame graphics** — replaces today's single-graphics checkerboard. Net new persistent cost ≈ **+1 draw call**.

**Tint-stability principle (why one white texture becomes the whole board):** shade with **black-alpha**, highlight with **white-alpha**, leave the body pure white. Then per-tile `setTint()` colors only the body while shadows stay neutral-dark and gloss stays bright-warm.

**Tokens:** `TILE_A 0xf4e7c6` (even), `TILE_B 0xf7e3de` (odd — checkerboard *whispers* for row/col tracking, doesn't stripe); `WELL_FLOOR 0xe4d8bd` (deeper than tiles so tiles pop); gold bezel `0xc9930a`/`0xf2b234`/`0xf7cf68` on-brand.

> **Rendering caveat (verified, Phaser 3.90):** `fillGradientStyle` is reliable only on `fillRect`, **not** `fillRoundedRect` (it triangulates). Every rounded shape uses **stacked flat-alpha rounded rects** (baked once — perf irrelevant); gradients only on plain rects.

**Integration:** keep `GameScene.buildBackdrop` lines 427–433 (`cabinetGlow`) as-is; replace the cream-card + old-checkerboard block (~435–455) with the tray-well graphics + the 64-Image tile-bed loop. Footprint (pad 18 → x22/y282/size676) is **unchanged**, so `buildCabinet` bulb positions and the rose-halo bleed stay aligned. An optional `renderTexture` variant bakes the loop into one static blit (can't-be-cheaper); the 64-Images path is the lower-risk drop-in.

**Pieces:** `createSprite` stays as-is — a 73.6px piece on a 75px glossy tile already reads as seated. **Do NOT add a per-piece top gloss** (fights the glyph, can't stay glued during tweens). Optional zero-runtime-cost grounding: bake a soft contact-shadow ellipse *into* the piece DynamicTexture in `makeEmoji`/`ensurePieceTexture` (travels with the sprite for free, doesn't recolor the glyph). Default if owner wants symbols 100% untouched: rely on the tile seat alone.

**Match-clear gloss pop:** in `playWave`'s existing epicenter-staggered `delayedCall` (~:963), spawn one short-lived ADD `bgglow` sprite (tint `0xffedc2`, scale-up + fade, ≤190ms, self-destroying, reduced-motion-gated) on each emptied cell so the board catches light on every clear. Reuses `bgglow`, ≈3–12 per wave.

### 3d. Motion + Scene Transitions

**Files: `src/view/ui.ts` (helpers) + all 4 content scenes.** The win sequence, cabinet marquee chase, cascade feedback, and menu breathing CTAs are **already shipped** — this subsystem adds only scene transitions, idle micro-life, and the composition rules that keep them from fighting existing juice.

**Foundations (build first, both tiny):**
1. Centralize `prefersReducedMotion()` (5 duplicate copies → one import from `theme.ts`/`ui.ts`).
2. `startScene(from, key, data?)` in `ui.ts` — the single highest-impact motion item:

```ts
export function startScene(from: Phaser.Scene, key: string, data?: object): void {
  if (!from.input.enabled) return           // input-lock doubles as anti-double-tap guard
  from.input.enabled = false
  const dur = prefersReducedMotion() ? 90 : 180
  const cam = from.cameras.main
  cam.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => from.scene.start(key, data))
  cam.fadeOut(dur, 255, 253, 248)           // warm cream #fffdf8 — NEVER black (brand)
}
```

Each scene's `create()` gets one line at the very top (before any early-return): `this.cameras.main.fadeIn(prefersReducedMotion() ? 90 : 180, 255, 253, 248)`. Replace all **20 in-app `this.scene.start(...)` sites** with `startScene(this, ...)`. **Leave `BootScene` hard** — the destination's `fadeIn` becomes the app's intro reveal for free.

**Idle micro-life (each: reduced-motion-gated, reuses existing textures/emitters):**

| # | Effect | Hook | Cost |
|---|---|---|---|
| 3a | **Board shimmer sweep** — cream gloss glides across the 8×8 every ~6s (masked `sweep`, depth 3, α 0.16 ADD); pauses off-idle | after `buildPieceLayer` | 1 sprite, 1 tween |
| 3b | **Objective-complete stamp** — ✓ punch + spark + `starDing(2)` + haptic when an objective hits 0 | `changedObjectives` loop | transient |
| 3c | **Score punch** — scale 1.15 + gold tint flash on chunky gains (≥120 pts) | `addScore()` | transient |
| 3d | **Idle hint nudge** — pulse a valid pair after ~5s idle (engine `findFirstValidMove` exists) | arm/disarm around swaps | transient |
| 3e | **Special-birth pulse** — gold ring implosion + spark when a piece morphs to a special | `wave.transformed` loop | transient, ≤2/wave |
| 3f | **Home emblem sparkle** — sparse drifting hearts from the emblem | Home after satellites | 1 emitter, cap ~2 |

**Signature extra (P4, optional):** gold reel `sweep` flourish on Home→Game / Home→Daily only (260ms fade so the streak reads in the opening window).

**Composition rules (the core of "don't over-animate"):** idle effects *yield* to the celebration (shimmer pauses off-idle, hint disarms on swap-start); never two large emitters at once; ≤1 hero breathe per screen; transient idle effects are mutually exclusive by scene state (hint only in `idle`; stamp/birth/score-punch only in `resolving`).

### 3e. Theme System + the 4 Concepts

**Define Golden Hour as the full base** (exact current values → zero visual diff on migration), then spread + override for the other three (guarantees no missing key at compile time). Cards / board cabinet / gold bezel / result cards / all card-relative text **inherit the base unchanged on every theme** — only wash, glow, ray, bokeh, marquee, sparkle, mote, watermark, scrim, accents, shadow, and the two `onBackdrop*` roles diverge.

| Theme | Feel | Unlock | Wash | Signature swing |
|---|---|---|---|---|
| **`golden` — Golden Hour** | warm default (today's look) | free | `0xfaf3ec→0xefe7d6` cream | the base; zero diff |
| **`mayaHeart` — tender valentine** | soft rose (the Ton tribute) | free | `0xfdf1f0→0xf7e6e6` | rose glows, `accent 0xd3304f`, `onBackdropInk #6a3a45` |
| **`roseMidnight` — after-hours velvet** | plum near-dark | `save.unlocked ≥ 10` | `0x241a2e→0x1a1526` | gold+rose aurora on dark, `onBackdropInk #f3e8f0`, deep `shadow 0x0d0912` |
| **`neonVegas` — the strip at night** | navy neon | `unlocked > 30` (= `endlessUnlocked`) | `0x14203a→0x0e1730` | magenta `accent 0xff3d81` + cyan `accentAlt 0x35d0e0`, **cabinet halo stays warm gold**, cards stay cream |

**Unlock model:** cosmetic, **always free** (no chip cost, ever — preserves the "nothing is bought" pillar). Two of four gated to level progress as a soft return hook (`THEME_META` + `themeUnlocked(id, save)`, the only save coupling, read-only). Ship all-free if the owner prefers (one-line change).

**Picker:** `addThemeChip(scene, x, y)` (clone `addSoundChip`, tri-color swatch icon from the active theme) + `openThemePanel(scene)` (clone `openSoundPanel` — scrim, cream card, gold bezel, per-theme rows with accurate swatch previews drawn from the *target* theme's tokens, locked rows at α 0.55 with a `lock` texture + "Reach Level N"). Tap unlocked → `setTheme(id)` + rebuild panel (gold highlight moves) → on close, `scene.restart()` if the id changed.

---

## 4. Procedural-Depth Cookbook

The cheap recipes for faking depth without shaders. **Organizing doctrine: BAKE ONCE, TWEEN FOREVER** — render every depth cue into a texture at boot via `generateTexture`/`DynamicTexture`, then animate only with transforms (position/scale/rotation/alpha) and masked sweeps. Never synthesize a gradient/blur/bevel per frame with a live `Graphics`.

| Effect | ❌ Expensive / forbidden | ✅ Cheap recipe |
|---|---|---|
| **Bevel** (button depresses) | redraw rounded-rect + shadow per press; live gradient | two baked sprites — dark **base plate** (offset +ext down = socket) + glossy **top face**; press tweens the face `y += press` + squash into the static base. 0 runtime graphics. |
| **Gloss** (static sheen) | live gradient / MULTIPLY overlay per frame | bake a lighter rounded-rect over the top ~45–50% at α 0.30–0.40, feathered by 2–3 stacked falling-alpha fills (the `makeSweep`/`bgglow` trick). Free at runtime. |
| **Gloss** (animated shine) | new per-frame mechanism | **reuse the shipped masked-`sweep`** (`addMarquee`): one `sweep` ADD sprite, bitmap-masked to the shape, one tween across it with `repeatDelay`. |
| **Inner-shadow** (recessed well) | — | baked into the texture: dark inner stroke on top/inner edge + light inner stroke on bottom/inner edge (2 `strokeRoundedRect` at ~0.15 α, 2–4px inset). |
| **Blur / bokeh** | true Gaussian/box blur (needs a shader / RT ping-pong) | the **pre-blurred `bgglow`** IS your blur — scale + tint + ADD for soft light, scale small for bokeh. For "frosted panel," lay a semi-opaque cream rounded-rect; don't blur the backdrop. Prefer **fewer, larger** glows. |
| **Vignette** | 720×1280 baked texture (3.69 MB!); MULTIPLY full-screen quad | four warm edge gradient bands (`fillGradientStyle` on `fillRect`) whose overlap darkens corners; NORMAL blend, one static graphics object. (Or one ~128×228 low-res texture stretched, ≈116 KB.) |
| **Rays** | redraw a polygon per frame | `raybeam` texture (feathered, origin at top) + ADD + warm tint α ≤ 0.10, animate a single `angle` tween (±13° yoyo). Rotation is a free transform. |
| **Glossy tile** (symbols) | a **separate tile sprite behind each piece** (doubles the board to 128 sprites) | composite the tile — shadow → base → gloss → inner-strokes → emoji — **into the existing per-symbol DynamicTexture**; 64 sprites, ~6 shared textures, batches to ~1–2 draws, exactly today's runtime cost. |

**FSE reference** (1 FSE = one full-screen of fragment work = 720×1280 ≈ 0.92 Mpx): full screen 1.00 · vignette-stretched ~0.90 (normal) · `bgglow` @900px **~0.88** · existing cabinetGlow @810px ~0.71 · corner bokeh @scale 2.6 ~0.12 · `raybeam` fat beam ~0.14.

---

## 5. Performance Budget, Regression Checklist & Do/Don't

### The one thing that matters: fill-rate, not CPU

The engine is already well-behaved on the cheap axes — everything is tween-driven, **zero `graphics.clear()` in any `update()`**, all textures ≤ 128², the board is one geometry-masked container of 64 sprites batching to ~1–2 draw calls, win particles capped at 120. The overhaul's risk is **blended-fragment overdraw** — a mobile GPU with no early-Z on translucent geometry pays the *full quad area* of every soft glow/ray/aurora/vignette every frame. **Protect the single most important perf property: the game renders at 720×1280 design resolution and is CSS-upscaled by `Scale.FIT`** — fragment work is bounded to ~0.92 Mpx regardless of retina density.

**Baseline already spent:** the game carries **~0.71 FSE of continuous ADD overdraw** (the existing `cabinetGlow`) *before* the overhaul adds a single glow.

### Hard budgets (additive to baseline)

| Resource | Menu scenes | Game scene |
|---|---|---|
| **Steady-state blended overdraw** | **≤ 3.0 FSE** | **≤ 2.0 FSE** (incl. 0.71 cabinetGlow → **≤ 1.3 FSE of new light**) |
| Large soft glows on screen (≥400px) | ≤ 4 | ≤ 3 (cabinetGlow counts) |
| God-ray quads | ≤ 2 (home) / ≤ 1 (menu) | ≤ 1 top-margin, or none |
| Live ambient particles (steady) | ≤ 12 | **0 over the board** |
| Live particles (win peak) | ≤ 120 | ≤ 120 |
| Active masks (bitmap/geometry) | ≤ 3 | ≤ 3 (pieceLayer = 1) |
| New baked textures (whole overhaul) | **≤ 4** (`raybeam`, `tile`, optional vignette; gloss baked into existing DTs = +0 keys) | |
| `graphics.clear()`/redraw in `update()`/RAF | **0** | **0** |

**Worked risk case (game, naïve read):** cabinetGlow 0.71 + aurora 2×0.88 + 1 ray 0.14 + 4 bokeh 0.48 = **~3.1 FSE**, exceeding the 2.0 budget — and much aurora fill is *wasted behind the opaque board card*. **Mitigation:** on game, drop aurora to 1 small top-margin glow or geometry-mask it to the margin bands. This is why game aurora/rays are clamped/margin-confined in §3b.

### Regression checklist (run per scene × per theme, incl. both dark themes)

1. No particle/ray/aurora/glow/tint crosses the board rect **40–680 × 300–940** during `game`; emoji never tinted.
2. Dark-theme contrast: cream cabinet + gold bezel + cream result cards unchanged; HUD text tokens verified against the **card fill**, not the dark backdrop (≥ 4.5:1).
3. FIT-scaling: at letterboxed aspect ratios no ambient element drifts into the play area; vignette/rays still frame.
4. No occlusion of rank/reward/Continue/NEXT/skip by confetti/glow/ray.
5. Overdraw ceiling: count on-screen large glows — game ≤ 3, menu ≤ 4.
6. No new `graphics.clear()`/redraw in any `update()`/RAF (grep stays clean).
7. Reduced-motion: rays/aurora static, no falling particles, no board shimmer, transitions ~90ms, marquee flat mid-alpha.
8. Thermal soak: Home open 5+ min on a real older iPhone — warm-not-hot, no jank on first interaction.
9. Golden Hour stays warm — no cool/dark tints, vignette warm not black.

### DO / DON'T

**DO:** bake every depth cue once, animate with transforms + the masked-`sweep` trick · composite the glossy tile into the per-symbol DynamicTexture · keep 720×1280 + `Scale.FIT` · prefer fewer/larger glows, group ADD light contiguously at the bottom of the z-stack · guard every new texture (`generate-once`) · honor `prefers-reduced-motion` in every effect.

**DON'T:** ① raise render resolution (top rule — no `scale.resolution`/`zoom` to physical pixels) · ② attempt runtime blur · ③ redraw gradients/bevels/shadows per frame · ④ put cool/dark tints or a black vignette on Golden Hour · ⑤ add a second sprite per board cell · ⑥ stack ADD glows into the game center behind the opaque card · ⑦ interleave ADD sprites between normal sprites in z-order / tint the emoji / add per-piece masks · ⑧ use MULTIPLY/SCREEN · ⑨ add strobing/high-contrast camera flashes.

---

## 6. Phased Implementation & Orchestration Plan

**Nine build phases**, each sized for one subagent, ordered to deliver value fast and low-risk (tokens → buttons → background → tiles/board → motion → theme picker). The **shared git tree is the concurrency constraint**: no two phases that touch the same file may run concurrently. Each phase ends at a **verification gate**: `npx tsc --noEmit` clean + `npm run build` succeeds + the listed visual check.

**File-contention map (who touches what):**

| File | Phases that write it |
|---|---|
| `src/view/theme.ts` (new) | P0 (create), P8 (add picker meta) |
| `src/view/textures.ts` | P2, P3 |
| `src/view/ui.ts` | P0 (import), P1, P5, P8 |
| `src/view/background.ts` | P4 |
| `src/scenes/GameScene.ts` | P3, P6 |
| `src/scenes/{Home,LevelSelect,DailyBonus}Scene.ts` | P6, P8 |
| `src/main.ts`, `index.html` | P0 |

### Phase table

| # | Title | Files (exclusive) | Depends on | Verification gate |
|---|---|---|---|---|
| **P0** | **Token foundation** — create `theme.ts` (THEMES, store, `css()`, `applyPageChrome`, canonical `prefersReducedMotion`); wire page chrome in `main.ts`/`index.html`; replace the 5 `prefersReducedMotion` copies with imports (`ui.ts` + 4 scenes — import-only, no color edits) | `theme.ts`, `main.ts`, `index.html`, + import-only touch to `ui.ts`/4 scenes | — | tsc+build clean; app looks **identical** (Golden = today); page bg unchanged |
| **P1** | **Chunky 3D buttons** — extend `PillStyle`, `shade()`, baked base/face textures, press-on-face, round chips, `drawPillFace`, `addChipPill` gloss, `warmButtonTextures` | `ui.ts` | P0 | buttons visibly depress on press; all screens' controls render; caller breathing tweens still compose |
| **P2** | **New backdrop texture** — `makeRaybeam` in `textures.ts` + call in `createAllTextures` | `textures.ts` | P0 | `raybeam` key exists; no visual change yet |
| **P3** | **Board depth + glossy tiles** — `makeTile` (textures.ts) + tray-well/tile-bed in `GameScene.buildBackdrop` + clear-flash in `playWave` | `textures.ts`, `GameScene.ts` | P2 | 64 glossy tiles in a recessed gold tray; bulbs still aligned; clear-flash pops |
| **P4** | **Atmospheric background** — restructure `addCasinoBackdrop` into per-variant layer helpers (aurora/spotlight/rays/bokeh/vignette/boardBleed/marquee/sparkle/suits), reading `getTheme()` | `background.ts` | P0, P2 | home breathes with depth; game margins alive, board rect clear; overdraw within budget |
| **P5** | **Motion helpers** — `startScene`, optional `breatheButton` in `ui.ts` | `ui.ts` | P1 | `startScene` fades cream; helper exported |
| **P6** | **Motion wiring** — fadeIn + convert 20 `scene.start` sites + idle micro-life (shimmer, stamp, score-punch, hint, birth, emblem) across GameScene + 3 menu scenes | `GameScene.ts`, `Home/LevelSelect/DailyBonusScene.ts` | P3, P5 | cream cross-fades everywhere; board shimmer/stamp/score-punch fire; no double-tap |
| **P7** | **Color-token migration** — route backdrop/card/text literals through tokens (background.ts already tokenized in P4; here: GameScene/menu cards + text incl. `onBackdrop*` reclassification) | `GameScene.ts`, `Home/LevelSelect/DailyBonusScene.ts` | P4, P6 | screenshot-diff empty on Golden; dark themes now legible on the backdrop-drawn text |
| **P8** | **Theme picker** — `THEME_META`/`themeUnlocked` (theme.ts), `addThemeChip`/`openThemePanel` (ui.ts), wire chip into Home | `theme.ts`, `ui.ts`, `HomeScene.ts` | P0, P1, P7 | picker opens; 4 themes switch via `scene.restart()`; locks show; dark themes keep cream cards |

### Sequencing & parallelism

```
P0 ─┬─► P1 ──────────────► P5 ──► P6 ─► P7 ─► P8
    ├─► P2 ─► P3 ──────────────────►┘        ▲
    └─► P4 ────────────────────────►─────────┘
```

- **P0 is the hard gate** — everything reads its tokens/`prefersReducedMotion`. Ship it first, alone.
- **After P0, three tracks parallelize (disjoint files):** **P1** (`ui.ts`), **P2→P3** (`textures.ts`→`GameScene.ts`), **P4** (`background.ts`). None share a file. *Caveat:* P2 and P3 both touch `textures.ts` (P2 adds `raybeam`, P3 adds `makeTile`) — run them **sequentially within the track** (P2 then P3) to avoid a concurrent `textures.ts` edit; P4 also touches `textures.ts`? No — P4 is `background.ts` only and *consumes* `raybeam`, so **P4 must wait for P2** but not P3.
- **P5** waits on P1 (both `ui.ts`). **P6** waits on P3 + P5 (touches `GameScene.ts` after P3, uses `startScene` from P5). **P7** waits on P4 + P6 (touches the same scene files as P6 — sequential, same files). **P8** waits on P7 (touches `ui.ts` after P5's track is done, `theme.ts` after P0, `HomeScene.ts` after P7).
- **Concurrency-safe parallel wave after P0:** { P1 }, { P2→P3 }, { P4 (after P2) } run at once — three disjoint file sets. Everything downstream (P5–P8) is sequential because it re-touches `ui.ts` and the scene files.

### Conflict resolutions (principal's calls)

1. **Tween budget:** the background spec's ~20 ambient tweens *exceeds* the liveliness spec's original "≤18" line. **Call: raise the ceiling.** The perf spec is authoritative that tween *count* is a non-issue (the game already runs ~84 cheap alpha tweens at 60fps); the real cap is blended overdraw (FSE). Mitigate tween count only via shared/proxy tweens where trivial, not by cutting layers.
2. **Game aurora overdraw:** background spec wants 2 auroras on game; perf spec shows that blows the 2.0 FSE budget behind the opaque card. **Call: perf wins** — game aurora is margin-confined (masked to top/bottom bands) or dropped to 1 small top glow. Encoded in the §3b game column.
3. **Vignette implementation:** background spec draws four gradient bands (graphics); perf spec offers a ~128×228 baked texture. **Call: ship the four-band graphics object** (one static draw, zero texture memory, honors "gradients only on `fillRect`"); the baked texture is an equivalent fallback if profiling ever shows the four bands cost too much.
4. **Contact shadow on pieces:** board spec offers baking a shadow into the piece DTs. **Call: optional, owner-gated** (see §7) — default is the tile-seat-only look, which is already convincing and keeps symbols 100% untouched.
5. **`GOLD_PILL`/`GHOST_PILL`/`ROSE_PILL` migration:** tokens spec proposes a `pills(T)` factory. **Call: keep the const exports** (aliased to `pills().*`) through this overhaul so P1 doesn't have to touch 30 call sites; migrate opportunistically later. P1 ships the visual button rebuild without an API churn.

---

## 7. Risks & Open Decisions for the Owner

**Risks (mitigations in-plan):**
- **Thermal on older iPhones** — the whole reason §5 exists. Mitigated by the FSE budget, margin-confined game light, and the reduced-motion path. *Must* be validated by a real 5-min soak on an A9–A11 device (checklist #8) before shipping the background phase.
- **First-paint hitch** from `generateTexture` (buttons + tiles + raybeam bake at boot) — mitigated by `warmButtonTextures` and generate-once guards; watch the Boot→Home transition.
- **Dark-theme legibility** — the `onBackdrop*` reclassification (P7) is the gate; if a backdrop-drawn text is missed it turns to mud on Rose Midnight / Neon Vegas. Checklist #2 catches it.
- **Phaser gradient quirk** — `fillGradientStyle` only reliable on `fillRect`; all rounded shapes use stacked flat-alpha fills. Baked into every spec; a regression here shows as banding on tiles/vignette.

**Open decisions for the owner:**
1. **Theme unlocks — gated or all-free?** Recommended: `golden`+`mayaHeart` free, `roseMidnight` @L10, `neonVegas` @L30 (doubles as a return hook). All-free is a one-line change. *Never* chip-priced (would break the "nothing is bought" pillar).
2. **Piece contact shadow — bake it or leave symbols 100% untouched?** Default: leave untouched (tile seat alone is convincing). Bake only if pieces read as "floating."
3. **Checkerboard — whisper (`TILE_A`/`TILE_B`) or uniform premium slab (all `TILE_A`)?** Default: whisper, for row/col tracking.
4. **Gold reel-sweep flourish (P4 motion, Home→Game/Daily)** — signature garnish, optional. Ship only if the base cream fade "feels right" first.
5. **God-ray on the game scene** — keep 1 faint clamped ray, or drop it entirely (the cabinet bulbs already carry the game's motion)? Lean toward dropping if it reads busy over the HUD.
