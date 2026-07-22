# Plan: fix top-of-screen layout (blank band + crammed HUD + ENTER CODE overlap)

Hand-off plan for a focused session. Two related problems, one quick + one systemic.

## Symptoms (observed on a real iPhone, live build)

1. **ENTER CODE overlaps the GIFT STORE title** in the Gift Store.
2. **Every screen has a blank band at the very top** (between the status bar / Dynamic
   Island and the first controls), yet the top HUD row itself feels **crammed**. The
   *bottom* of each screen already feels well balanced — keep that.

## Root cause

The app draws a fixed **720×1280 "design box."** On tall phones it grows the world
height to the device aspect (`worldH()`, `src/config.ts`) and then **vertically centers**
the design box in that taller world:

- `contentOffsetY() = (worldH − 1280) / 2` — the reclaimed vertical space is split
  **equally top and bottom**.
- `restScrollY() = −contentOffsetY()` — every scene sets its camera to this to center.

Consequences:

- On a ~19.5:9 iPhone the top gets ~60–75 pt of blank margin above the first control,
  mirrored at the bottom.
- `index.html`'s `#frame` intentionally **drops the top/bottom safe-area insets** (only
  left/right are applied) so the canvas runs edge-to-edge under the Dynamic Island / home
  indicator. Its comment justifies this with "design top 0–300 is empty margin" — true for
  the **board**, but NOT for the **HUD**: the back button, title, subtitle, balance (and
  now ENTER CODE) all live at design y ≈ 84–260, i.e. inside that band. So the HUD both
  floats below a blank gap AND is packed tightly.
- Because the design box's top ~260 px carries the whole HUD stack while the bottom has
  more breathing room, the top reads "crammed," the bottom reads "nice."

**Key leverage:** the centering is funneled through `contentOffsetY()` / `restScrollY()`
in `config.ts`. All 5 scenes + the backdrop + `view/ui.ts` read them (~51 call sites), so
changing the vertical anchoring in those two functions changes every screen consistently —
the systemic fix is small-surface, high-leverage, not a per-scene slog.

## Fix A — ENTER CODE overlap (isolated, ~10 min)

File: `src/scenes/StoreScene.ts`. The pill is added at `(596, 84)` — the title's row
(title is 54 px at `(360, 130)` and wide). Move it **off the title row**:

- Recommended: put it on the **balance row**, right-aligned — roughly
  `addPillButton(this, 596, 240, 180, 52, 'ENTER CODE', GHOST_PILL, …)` — or a slim
  centered pill just under the subtitle. Verify against the widest title on a 390 pt-wide
  device.
- After Fix B (top band gets breathing room) it could return to a top-corner slot with
  real clearance if that's preferred — but the balance row is clean and safe on its own.

## Fix B — top blank + crammed (systemic, centered on `config.ts`)

Goal: **anchor content a fixed comfortable distance below the top safe area, and let the
reclaimed space pool toward the bottom** (which already feels right). Parts:

1. **Expose the top safe-area inset to JS.** Add `--sat: env(safe-area-inset-top, 0px)` to
   `:root` in `index.html`, and read it on boot + in the existing resize handler
   (`src/main.ts`). Convert CSS px → design px with the FIT scale:
   `designPx = cssPx × 720 / window.innerWidth`.
2. **Bias `contentOffsetY()`** (`config.ts`) from centered → top-anchored:
   - Replace `(worldH − DESIGN_H)/2` with something like
     `clamp(safeTopDesignPx + TOP_GAP, MIN_TOP, worldH − DESIGN_H)`, so the design box sits
     a fixed comfortable distance below the Dynamic Island and the **remainder falls to the
     bottom**.
   - On short / non-tall screens (`worldH === DESIGN_H`) the offset stays 0 → behaviour
     unchanged, so tablets / landscape / letterboxed aspects DON'T regress.
   - Tune `TOP_GAP` / `MIN_TOP` from device screenshots. Note the design already has ~84 px
     of empty space above the back button, so the target is "back button sits a comfortable
     thumb-gap below the Dynamic Island," not flush against it.
   - Keep `restScrollY()` derived from `contentOffsetY()` (unchanged formula).
3. **(Optional) Relax the top HUD rhythm** once there's room — nudge title / subtitle /
   balance spacing per scene so the cluster breathes. Only if it still reads crammed after
   the anchor change; try the anchor alone first.

## Files to touch

- `index.html` — add the `--sat` custom property (top safe-area inset).
- `src/config.ts` — `contentOffsetY()` bias + a setter to receive `safeTopDesignPx`.
- `src/main.ts` — read `--sat` on boot + on resize; feed it to config.
- `src/scenes/StoreScene.ts` — relocate ENTER CODE (Fix A).
- (Verify, likely no code change) the other scenes + `view/background.ts` read the updated
  functions automatically.

## Risks / must-verify

- **Board & overlays** key off `restScrollY`/`contentOffsetY`. Top-anchoring shifts them
  up — verify the board doesn't crowd the bottom power bar (GameScene) and that win /
  lose / reshuffle overlays stay centered and fully cover.
- **Notch vs Dynamic Island vs no-notch:** `env(safe-area-inset-top)` is 0 on old / non-
  notch, ~47 notch, ~59 Dynamic Island. The clamp MUST degrade to today's look when the
  inset is 0.
- **Landscape / tablet:** the `worldH === DESIGN_H` path must stay centered / letterboxed
  (no regression). Test one landscape + one iPad aspect.
- **Update the stale `#frame` comment** in `index.html` to describe the new anchoring, and
  re-confirm the HUD clears the Dynamic Island.
- **PWA installed (standalone):** safe areas differ from in-browser Safari — test both.

## Verification matrix (screenshot each state)

Devices/aspects: iPhone Dynamic Island (393×852), notch (390×844), small non-notch
(375×667), tall Android (~412×915), iPad (768×1024), one landscape.

Per device, check: Home · Gift Store · Level Select · Daily Bonus · in-game board · a win
overlay. Confirm on each: the top gap is a consistent comfortable band (no big blank), the
HUD isn't crammed, the board + overlays are correct, and ENTER CODE is clear of the title.

Use the headless harness (Playwright + Chromium at `/opt/pw-browsers`) with the DEV knobs
(`?level=N`, `?code`, etc.) to capture the matrix; the game surfaces state via screenshots
(the browser pane's JS eval binds to a stale document — see README).
