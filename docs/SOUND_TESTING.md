# Sound & Haptics testing tools

Procedural audio can't be verified in CI (there's no ear in the pipeline), so it's auditioned by hand.
Two **dev-only** tools exist for that. **Neither ships** — `tsconfig` includes only `src/`, and `vite build`
emits only `index.html`, so `dev/*` and the root `soundbench.html` are never in the production bundle.

## 1. `soundbench.html` + `dev/soundbench.ts` — the in-repo bench

Drives the **real** `sfx` engine (`src/audio/sfx.ts`) and the real haptic gating, so what you hear/feel is
exactly the game. A button for every one-shot; cascade arpeggios + the full combo arc; a land-intensity
sweep; the ambient bed (per theme); the current haptic vocabulary behind a Vibration-API badge (all
mute / `hapticsOff` gated as in-game). Panned/stepped voices take a global pan slider + cascade-step input.

```
npm run dev   # → http://localhost:5173/soundbench.html   (open the LAN IP on a phone to feel haptics)
```

## 2. `dev/soundlab.html` — the standalone, reusable sound lab

A **single self-contained HTML file** — zero dependencies, zero build, zero assets. Double-click it (or serve
it anywhere) and it runs. It ports the ambient-bed synthesis (pad, shared FDN reverb, pentatonic key-lock,
noise) into a portable auditioner with a **test tone**, an **audio-status** readout, a **listening-level**
boost (the in-game bed is deliberately subliminal, ~ −37 dB — inaudible in isolation without a lift), a live
level meter, and a UI that **re-tints to the selected theme**.

Built to audition ambient-bed candidates, but the pattern is general. **To reuse it for any future sound
work, edit three things in the `<script>`:**

- `THEMES` — your palettes (each drives both the audio params and the page tint).
- `BUILDERS` — your synthesis functions, keyed by name (each receives `{ ctx, t, pal, dest, bedMaster, level,
  dryBus, snap, noise, add, onStop, isActive }`).
- `ROOMS` — the picker labels/descriptions.

Everything else (master + monitor gain, reverb, `snap`, noise, test tone, status, meter, theming) is reusable
as-is. A hosted copy can be published as a private Artifact for tap-to-hear auditioning on any device (sound
only — browser haptics don't fire inside a sandboxed iframe, and iOS Safari has no web vibration at all).

## Status: ambient-bed exploration (auditioned, shelved — engine untouched)

Three evolved beds — **Drift** (movement only), **Layered** (+ sub-octave & air), **Living** (+ a rare
key-locked sparkle) — were drafted and auditioned. At the bed's intended (near-inaudible) level they're too
subtle to differ meaningfully from the shipped bed, so **the game keeps its original bed and `src/audio/sfx.ts`
was left byte-for-byte unchanged** (an earlier injection seam was reverted). The three builders are preserved
**only** in `dev/soundlab.html` as references and as a worked example of the reuse recipe above — they are not
wired into the game.
