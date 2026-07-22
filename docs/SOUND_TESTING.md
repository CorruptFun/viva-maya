# Sound & Haptics testing tools

Procedural audio can't be verified in CI (there's no ear in the pipeline), so it's auditioned by hand.
Two dev-only tools exist for that. **Neither ships** — `tsconfig` only includes `src/`, and `vite build`
emits only `index.html`, so `dev/*` and the root `soundbench.html` are never in the production bundle.

## 1. `soundbench.html` + `dev/soundbench.ts` — the in-repo bench

Drives the **real** `sfx` engine (`src/audio/sfx.ts`) and the real haptic gating, so what you hear/feel is
exactly the game. A button for every one-shot; cascade arpeggios + the full combo arc; a land-intensity
sweep; the ambient bed; the current haptic vocabulary behind a Vibration-API badge (all mute / `hapticsOff`
gated as in-game). Panned/stepped voices take a global pan slider + cascade-step input.

```
npm run dev   # → http://localhost:5173/soundbench.html   (open the LAN IP on a phone to feel haptics)
```

It also carries an **Ambient rooms A/B** selector that swaps the live bed between `Legacy` and three evolved
builders via the `startBed({ voices })` seam (below). Use it to compare candidate beds across the four themes.

## 2. `dev/soundlab.html` — the standalone, reusable sound lab

A **single self-contained HTML file** — zero dependencies, zero build, zero assets. Double-click it (or serve
it anywhere) and it runs. It ports the same synthesis (pad, shared FDN reverb, pentatonic key-lock, noise)
into a portable auditioner with a **test tone**, an **audio-status** readout, a **listening-level** boost
(the in-game bed is deliberately subliminal, ~ −37 dB — inaudible in isolation without a lift), a live level
meter, and a UI that **re-tints to the selected theme**.

Built to audition the ambient-bed candidates, but the pattern is general. **To reuse it for any future sound
work, edit three things in the `<script>`:**

- `THEMES` — your palettes (each drives both the audio params and the page tint).
- `BUILDERS` — your synthesis functions, keyed by name (each receives `{ ctx, t, pal, dest, bedMaster, level,
  dryBus, snap, noise, add, onStop, isActive }`).
- `ROOMS` — the picker labels/descriptions.

Everything else (master + monitor gain, reverb, `snap`, noise, test tone, status, meter, theming) is reusable
as-is. A hosted copy of this tool can be published as a private Artifact for tap-to-hear auditioning on any
device (sound only — browser haptics don't fire inside a sandboxed iframe, and iOS Safari has no web
vibration at all).

## The `BedVoices` seam (`src/audio/sfx.ts`)

`startBed(opts?: { voices?: BedVoices })` delegates the bed's **sustained voices** to an injected builder,
while the shipped chain (`warmth → bedMaster → duck → mute → master`), the fade-in, and all teardown stay
fixed — so a swapped "room" can never leak the real teardown. The default, `legacyBedVoices`, reproduces the
shipped bed **exactly**; the game only ever calls `startBed()` with no args, so **the shipped bed is
unchanged**. The seam exists purely so the bench can A/B alternative beds against the real engine.

## Status: ambient-bed exploration (shelved)

Three evolved beds — **Drift** (movement only), **Layered** (+ sub-octave & air), **Living** (+ a rare
key-locked sparkle) — were drafted and auditioned. In practice they're too subtle to differ meaningfully from
Legacy at the bed's intended (near-inaudible) level, so **the game stays on `legacyBedVoices`**. The builders
are kept in `dev/soundlab.html` (and the bench) as references and as a worked example of the reuse recipe above.
