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

## Run it

```sh
npm install
npm run dev      # vite
npm test         # vitest run
npm run build    # tsc && vite build
```

Tests are colocated: `src/core/*.test.ts` (board, merge, hazards, endless,
plinko rate). Run them — the game logic has real coverage.

## Layout

| path | role |
|---|---|
| `src/main.ts`, `src/config.ts` | entry + tunables |
| `src/scenes/` | Phaser scenes — Boot, Home, Game, LevelSelect, Store, DailyBonus |
| `src/core/` | game logic + its tests — board, merge, levels, endless, daily, hazards, analytics, push |
| `src/view3d/stage.ts` | the only three.js usage |
| `supabase/migrations/` | `0001_saves` → `0020_race_day_key_repair` |
| `scripts/verify-rls.sh` | RLS audit — run after any migration |
| `scripts/send-push.mjs` | push sender |
| `scripts/gen-icons.mjs` | `npm run icons` |

## Supabase

Migrations are numbered and sequential. Use the **`supabase-migrations` skill**
for schema, RLS, and migration work — it covers the two-phase rule that matters
here, since cached PWA clients keep running old code after a deploy.
Verify with `scripts/verify-rls.sh` afterward.

## Secrets

Web-push VAPID keys live at `~/.secrets/viva-maya/` — **pointer only, never
commit or paste key material.** Publishable client config belongs in
`src/config.ts`.

## Design docs

`Supabase_Architecture.md` (schema + anti-cheat handshake),
`Treasury_Architecture.md`, `Growth_and_Economy_Strategy.md`,
`Implementation_Roadmap.md`. Read the relevant one before changing economy or
security behavior.

## Deploy

GitHub Pages. PWA via `vite-plugin-pwa` (Workbox) — a deploy invalidates
precached assets, so verify offline behavior after shipping. **Public repo.**
