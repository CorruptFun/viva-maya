# Cloud Save — Google Sign-In Plan

The chosen auth for cloud save is **Sign in with Google** (not email one-time codes).

**Why Google over email codes:** Supabase's built-in email sender is throttled to ~2 messages/hour
("testing only"), which would break real sign-ins. Google sign-in sends **no email at all** → no rate
limit, it's **one tap** (great for a non-technical player on iPhone), and it survives a cache wipe /
new device. (Apple sign-in would be the most native on iOS but needs a paid Apple Developer account,
so we skip it for now.)

---

## What already exists (built + dormant on `main`)

The cloud **engine** is done and safe — it just needs Google swapped in for the email auth and the
project keys set:

- `src/core/cloud.ts` — Supabase client (lazy-loaded), boot reconcile (`bootstrapCloud`), pull/push,
  and a debounced sync. **Dormant** unless `VITE_SUPABASE_*` is set → today's local-only behavior.
  *(Currently exposes email-OTP `sendEmailOtp`/`verifyEmailOtp` — these get replaced by Google.)*
- `src/core/merge.ts` — pure "furthest-progressed wins" merge (unit-tested). **Keep as-is.**
- `src/core/save.ts` — `coerceSave`, `exportSave`/`importSave` backup codes, and a persist listener
  that mirrors every local save to the cloud. **Keep as-is.**
- `src/view/cloudmodal.ts` — the Settings → CLOUD & BACKUP modal. *(Email/code inputs get replaced
  by a "Sign in with Google" button; the signed-in + Download/Restore-backup blocks stay.)*
- `supabase/migrations/0001_saves.sql` — `saves` table + owner-only RLS + `updated_at` trigger.
- Lazy-load: `@supabase/supabase-js` is a separate chunk, excluded from the PWA precache, so a
  local-only build never downloads it (see `vite.config.ts`).

**Security:** the app only ever uses the **anon (public) key** — safe to ship; Row-Level Security
gates every row to its owner. The **`service_role` key is a secret and must never be in the client
or committed.**

---

## Part 1 — Owner setup (dashboard/console; ~20 min, all free)

1. **Supabase → SQL Editor:** paste + run `supabase/migrations/0001_saves.sql`.
2. **Google Cloud Console** (console.cloud.google.com):
   - Create/select a project → **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - **Authorized redirect URI:** `https://<YOUR-PROJECT-REF>.supabase.co/auth/v1/callback`
     (find `<YOUR-PROJECT-REF>` in your Supabase Project URL).
   - Copy the **Client ID** and **Client Secret**.
   - (Configure the OAuth consent screen if prompted — "External", add your email as a test user; you
     don't need Google verification for a small user base.)
3. **Supabase → Authentication → Providers → Google:** enable it, paste the **Client ID + Secret**, save.
4. **Supabase → Authentication → URL Configuration:**
   - **Site URL:** `https://corruptfun.github.io/viva-maya/`
   - **Redirect URLs (allow-list):** add `https://corruptfun.github.io/viva-maya/**` and
     `http://localhost:5173/**` (for local dev).
5. **GitHub → repo Settings → Secrets and variables → Actions → Variables:** add
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon/public key
   (The deploy workflow already passes these to the build.)

---

## Part 2 — Code changes (for the build session)

Keep the merge/sync/save layer untouched. Only the **auth entry point** changes:

- **`src/core/cloud.ts`:** replace `sendEmailOtp` / `verifyEmailOtp` with:
  ```ts
  export async function signInWithGoogle(): Promise<{ ok: boolean; error?: string }> {
    const c = await sb(); if (!c) return { ok: false, error: 'Cloud not configured' }
    const { error } = await c.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href.split('#')[0] },
    })
    return error ? { ok: false, error: error.message } : { ok: true }
  }
  ```
  The OAuth redirect returns to the app; `detectSessionInUrl: true` (already set) + the existing
  `onAuthStateChange` handler establish the session and trigger `syncNow()`. Remove the now-unused
  email helpers. (`signOutCloud`, `bootstrapCloud`, `pullCloudSave`, `pushCloudSave`, `syncNow`,
  `mergeSaves`, `cloudSession`, `onCloudChange`, `isCloudConfigured` all stay.)
- **`src/view/cloudmodal.ts`:** in the signed-out state, replace the email input + code input with a
  single **"Sign in with Google"** button → `signInWithGoogle()`. On error, show it inline. Keep the
  signed-in state (email + Sign out) and the whole Download/Restore backup block unchanged.
- **PWA note:** the OAuth flow leaves the app (to accounts.google.com) and returns. In a standalone
  installed PWA this opens a browser view and comes back — verify the returned session lands
  (`getSession()` after redirect). If the installed-PWA return is flaky, fall back to
  `options: { skipBrowserRedirect: false }` / a system-browser tab; test on a real iPhone.

## Part 3 — Test plan (end-to-end)

1. Build with the env vars set (or set repo Variables + deploy). Open Settings → CLOUD & BACKUP →
   should show **"Sign in with Google"** (not "not set up").
2. Sign in → confirm the modal flips to "Signed in as …".
3. **Cross-device:** sign in on a 2nd device with the same Google account → confirm progress follows
   (furthest-progressed wins).
4. **Cache-wipe recovery:** clear site data / reinstall → sign in again → progress restored from cloud.
5. Confirm the **Download backup file** + **Restore from a file** still work as the no-account fallback.
