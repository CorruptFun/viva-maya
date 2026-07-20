# Cloud Save Setup (Supabase)

This is the owner-facing checklist for turning on **cloud saves** in Viva Maya.
It is the first, minimal slice of `Supabase_Architecture.md` — just a single
saved game per user, synced to the cloud so a player can pick up their progress
on another device. (Wallets, ledger and anti-cheat come later.)

## What this does

- Gives each signed-in player one row in a `saves` table holding their whole
  game save (as JSON).
- Lets players sign in with **Google** (one tap — no password, no email codes).
- Keeps local and cloud progress in sync while signed in.

## The one thing to understand about safety

> **The Supabase anon / public key is PUBLIC and safe to put in the client.**
> It is designed to be shipped in browser code. What actually protects player
> data is **Row Level Security (RLS)**: the database only ever lets a signed-in
> user read or write **their own** row. The key by itself grants nothing more.

Do **not** confuse the anon key with the `service_role` key. The `service_role`
key is a secret and must **never** be put in the client or committed anywhere.
We only ever use the **anon / public** key here.

**Nothing here is required to run the game.** If these environment variables are
not set, the game simply runs **local-only** using the browser's `localStorage`,
exactly as it does today — no errors, no missing features, no cloud sync.

---

## Step 1 — Create a free Supabase project

1. Go to <https://supabase.com>, sign up / log in.
2. Click **New project**. Pick any name and a strong database password
   (you won't need the DB password for this feature — just keep it safe).
3. Choose a region close to your players and create the project.
4. Wait a minute or two for it to finish provisioning.

## Step 2 — Create the `saves` table

1. In your project, open the **SQL Editor** (left sidebar) → **New query**.
2. Open `supabase/migrations/0001_saves.sql` from this repo, copy its entire
   contents, paste into the editor, and click **Run**.
3. You should see a success message. This creates the `public.saves` table,
   turns on Row Level Security, and adds the per-user access policies.

> Prefer the CLI? With the [Supabase CLI](https://supabase.com/docs/guides/cli)
> installed and your project linked, you can instead run:
> `supabase db push` (applies everything in `supabase/migrations/`).

To confirm it worked: open **Table Editor** and you should see a `saves` table.
Open **Authentication → Policies** and you should see four policies on it
(view / insert / update / delete own save).

## Step 3 — Turn on Google sign-in

Players sign in with **Google** (one tap). The client calls
`supabase.auth.signInWithOAuth({ provider: 'google', ... })`, which redirects to
Google's consent screen and back to the app; Supabase establishes the session on
return. No email is sent, so there's no rate limit. You need a **Google OAuth
client**, then you paste its ID/secret into Supabase.

### 3a — Create a Google OAuth client (Google Cloud Console)

1. Go to <https://console.cloud.google.com>, create or pick a project.
2. **APIs & Services → OAuth consent screen:** choose **External**, fill in the
   app name + your email, and add your own Google account as a **test user** (you
   don't need Google's verification for a small, personal user base).
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID.**
4. Application type: **Web application**.
5. Under **Authorized redirect URIs**, add EXACTLY (no trailing slash):

   ```
   https://<YOUR-PROJECT-REF>.supabase.co/auth/v1/callback
   ```

   `<YOUR-PROJECT-REF>` is the first part of your Supabase Project URL (Step 4) —
   e.g. for `https://abcdefgh.supabase.co` the ref is `abcdefgh`.
6. Create it, then copy the **Client ID** and **Client secret**.

### 3b — Enable Google in Supabase

1. In Supabase, go to **Authentication → Providers → Google**.
2. Toggle it **enabled**, paste the **Client ID** and **Client secret**, and save.

### 3c — Set the site URL + redirect allow-list

Under **Authentication → URL Configuration**:

- **Site URL:** `https://corruptfun.github.io/viva-maya/`
- **Redirect URLs** (add both): `https://corruptfun.github.io/viva-maya/**`
  and `http://localhost:5173/**` (for local dev).

## Step 4 — Get your Project URL and anon key

1. Go to **Project Settings → API**.
2. Copy the **Project URL** (looks like `https://abcdefgh.supabase.co`).
3. Copy the **anon / public** key (the one clearly labelled *anon* / *public* —
   **not** `service_role`).

You'll paste these into the two environment variables in Step 5. Their exact
names — used by both local dev and the deploy — are:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Step 5 — Wire up the environment variables

There are two places these live: your local machine (for `npm run dev`) and
GitHub (for the deployed site).

### Local development

Create a file named **`.env.local`** in the project root with:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-ANON-PUBLIC-KEY
```

Then run the game as usual (`npm run dev`). Vite picks these up automatically.

> **Keep your env file out of git.** This repo's `.gitignore` ignores both
> `*.local` (so `.env.local` is safe) **and** now `.env` / `.env.*`, so whichever
> you use, your keys won't be committed. (The anon key is public anyway, but it's
> good hygiene.)

### GitHub Pages deploy

The deploy build reads these from **repository Variables** (not Secrets — the
anon key is public, and Variables are the right fit; either would technically
work, but use Variables):

1. In GitHub, go to **Settings → Secrets and variables → Actions**.
2. Open the **Variables** tab → **New repository variable**.
3. Add two variables with these exact names:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon / public key
4. Re-run the deploy (push to `main`, or trigger the workflow manually).

The deploy workflow (`.github/workflows/deploy.yml`) now passes these to the
Vite build step, so their values get inlined into the published site. If the
Variables are absent, the build still succeeds and the site runs local-only.

---

## How progress syncs

- **Signed in:** on load, the game merges your **local** save with your **cloud**
  save and the **furthest-progressed one wins**; from then on it keeps both in
  sync so any device you sign in on shows your latest progress.
- **Signed out:** the game is **local-only** — everything lives in this browser's
  `localStorage`, exactly as before. Signing in later folds that local progress
  into the cloud with the same "furthest wins" merge.

## Quick troubleshooting

- **Game works but never syncs / no sign-in prompt:** the env vars probably
  aren't set. Locally, check `.env.local` and restart `npm run dev`. On the
  deployed site, check the two repository **Variables** and re-run the deploy.
- **Google sign-in fails or won't come back:** re-check Step 3 — Google provider
  enabled in Supabase with the right Client ID/secret, the Google OAuth client's
  redirect URI is EXACTLY `https://<ref>.supabase.co/auth/v1/callback`, and your
  site URL is in the redirect allow-list. On an installed iPhone PWA the flow
  leaves to Google and returns — give it a moment to land the session.
- **Signed in but saves don't load/save:** re-run `0001_saves.sql` (Step 2) and
  confirm the four RLS policies exist on `public.saves`.
