# Cloud Save Setup (Supabase)

This is the owner-facing checklist for turning on **cloud saves** in Viva Maya.
It is the first, minimal slice of `Supabase_Architecture.md` — just a single
saved game per user, synced to the cloud so a player can pick up their progress
on another device. (Wallets, ledger and anti-cheat come later.)

## What this does

- Gives each signed-in player one row in a `saves` table holding their whole
  game save (as JSON).
- Lets players sign in with just their email (a 6-digit code — no password).
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

## Step 3 — Turn on email sign-in (one-time code)

Players sign in with an email one-time passcode (OTP). The client calls
`signInWithOtp` to send the code and `verifyOtp` to check it, and it also
handles the case where the player instead **clicks the magic link** in the email.

1. Go to **Authentication → Providers** (some dashboards label it
   **Sign In / Providers**) and make sure **Email** is enabled.
2. Go to **Authentication → Emails → Templates** (a.k.a. the email templates).
   The **Magic Link** / **Confirm signup** template must actually include the
   6-digit code so players can type it in. Supabase exposes it as the
   `{{ .Token }}` variable. Make sure the template body shows it, e.g.:

   ```
   Your Viva Maya login code is: {{ .Token }}
   ```

   The default template mostly shows a `{{ .ConfirmationURL }}` link (which the
   client also supports when clicked). Adding `{{ .Token }}` to the body is what
   makes the "type the code" flow work. Keeping both the link and the token in
   the template covers both sign-in styles.
3. (Optional but recommended) Under **Authentication → URL Configuration**, add
   your GitHub Pages site URL to the allowed **Redirect URLs** so clicked magic
   links come back to the deployed game.

> On Supabase's free tier the built-in email sender is rate-limited and meant
> for testing. That's fine to start; for real traffic you'd later add a custom
> SMTP provider. No code changes are needed for that.

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

> **Keep `.env.local` out of git.** Good news: this repo's `.gitignore` already
> ignores it via the existing `*.local` rule, so you don't need to do anything.
> Heads-up: a plain `.env` file (or `.env.production`) is **not** currently
> ignored — if you ever create one of those, add a line like `.env` to
> `.gitignore` first so keys don't get committed. (For this feature you only
> need `.env.local`, which is already safe.)

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
- **Never receive a login code:** re-check Step 3 — Email provider enabled and
  `{{ .Token }}` present in the email template. Free-tier email is rate-limited.
- **Signed in but saves don't load/save:** re-run `0001_saves.sql` (Step 2) and
  confirm the four RLS policies exist on `public.saves`.
