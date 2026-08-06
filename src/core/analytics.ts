/**
 * Product analytics — a tiny, first-party, append-only event pipe.
 *
 * WHY IT EXISTS: the two leaderboards were the only telemetry this game had, and both need a Google
 * sign-in. On 2026-07-28 that was 8 known accounts against ~10-12 believed-active players, so every
 * signed-out player was invisible and nothing about the funnel — how many opened it, where they quit,
 * whether an invite ever converted — could be answered at all. Sign-in is optional by design, so
 * anything keyed on auth.users can only ever see the minority. Hence a DEVICE id below.
 *
 * Design contract, deliberately identical to core/cloud.ts so there is one mental model for "talks to
 * the network" in this codebase:
 *   - DORMANT until configured: with no VITE_SUPABASE_* env, every export no-ops and the game runs
 *     exactly as before. Analytics is never a reason for the game to behave differently.
 *   - NEVER THROWS into the game. Every path is wrapped; a failed flush drops events on the floor.
 *     Losing a metric is free. Breaking a level is not.
 *   - FIRE AND FORGET: track() returns void synchronously and does no network work on the caller's
 *     frame. It appends to an in-memory queue; flushing is batched and off the hot path.
 *
 * WHY RAW fetch AND NOT THE SUPABASE CLIENT: two reasons. (1) The unload flush needs `keepalive`,
 * which supabase-js does not expose — and the unload flush is the one that carries "player quit here",
 * the single most valuable event in a funnel. (2) It keeps analytics working even when the lazy
 * supabase chunk hasn't loaded, so a first-session bounce (the exact player we can't currently see) is
 * still counted.
 *
 * Privacy: no PII, no fingerprinting, no third party. `device_id` is a random UUID this file mints —
 * it is not derived from anything about the device or the person. Disclosed in public/privacy.html,
 * and honours an opt-out (setAnalyticsEnabled) that persists locally.
 */

/**
 * Read lazily rather than captured into module-scope consts (which is what core/cloud.ts does).
 * Vite inlines import.meta.env at build time either way, so this costs nothing in the bundle — but
 * capturing at module load makes the module impossible to exercise from a test, because the import
 * happens before any test can stub the environment. Everything else here is only meaningful when
 * configured, so an untestable gate would mean an untested file.
 */
function env(): Record<string, string | undefined> {
  return import.meta.env as unknown as Record<string, string | undefined>
}
function supabaseUrl(): string | undefined {
  return env().VITE_SUPABASE_URL
}
function supabaseKey(): string | undefined {
  return env().VITE_SUPABASE_ANON_KEY
}

/** Injected by vite.config define — the CI commit SHA, or 'dev' locally. */
declare const __APP_VERSION__: string
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

const DEVICE_KEY = 'viva-maya:device'
const OPTOUT_KEY = 'viva-maya:analytics-off'

/**
 * Canonical event names. Kept as a const object rather than a Postgres enum or a lookup table on
 * purpose (see 0010_events.sql): under a 'prompt'-mode PWA, players sit on several bundles at once, so
 * a server that only accepts today's vocabulary would reject events from every un-updated client.
 * The server normalises shape and buckets anything unrecognised as 'unknown'.
 */
export const EVENTS = {
  /**
   * Once per app open. The denominator for literally every other rate on this list.
   *
   * props: {standalone, lang}. `standalone` is the ONLY cross-platform "this player is installed"
   * signal there is — Apple fires no install event, so on iOS a later open reporting standalone is
   * the ground truth, and it is what the install reward triggers on (core/install.ts).
   *
   * ⚠️ Deliberately carries NO platform / user-agent prop, even though the iOS-vs-Android split
   * would be useful: public/privacy.html promises in plain language that an event carries nothing
   * "about your phone", and this is the one event every client sends on every open. The split is
   * taken instead from `install_offer_shown`'s `mode` — same answer, scoped to the players actually
   * being offered an install, rather than broadening what is collected from everybody.
   */
  APP_OPEN: 'app_open',

  /** {level} — a level actually began (not merely browsed to on the map). */
  LEVEL_START: 'level_start',
  /** {level, stars, moves_left} */
  LEVEL_WIN: 'level_win',
  /** {level, reason: 'out_of_moves' | 'out_of_lives'} — the wall detector. */
  LEVEL_FAIL: 'level_fail',
  /** {level} — backed out mid-level, which reads very differently from losing. */
  LEVEL_QUIT: 'level_quit',
  /**
   * {level, moves} — a level in progress was picked back up after the page went away
   * (core/levelresume.ts). Deliberately NOT a second `level_start`: this is the same attempt
   * continuing, so counting it as a start would inflate the attempt count of exactly the long levels
   * that get interrupted most. Its own rate is also the measurement of how often players are losing
   * the page mid-level at all.
   */
  LEVEL_RESUME: 'level_resume',

  /** {score} */
  ENDLESS_START: 'endless_start',
  ENDLESS_END: 'endless_end',

  /**
   * {chapter, purse, retro} — a chapter's one-time trophy + purse landed. `retro: true` marks the
   * Home catch-up sweep (back-fill for chapters beaten before the feature, or a grant a crash
   * skipped); false is the live win-flow ceremony. Sum of purses per player is bounded by the
   * CHAPTER_PURSES table, so this is also the audit trail for that faucet.
   */
  CHAPTER_REWARD: 'chapter_reward',
  /** {trophies} — the showroom panel opened, carrying how many plinths were lit. */
  SHOWROOM_OPEN: 'showroom_open',

  /**
   * The sign-in funnel: how many see the offer vs take it.
   *
   * `signin_shown` counts OFFERS, not renders — once per cloud-modal open, from the signed-out
   * branch only (view/cloudmodal.ts). A player already signed in, or on a build with no cloud
   * configured, is never offered anything and must not land in the denominator.
   */
  SIGNIN_SHOWN: 'signin_shown',
  SIGNIN_STARTED: 'signin_started',
  SIGNIN_COMPLETED: 'signin_completed',

  /**
   * PWA install funnel — the memory note says installs are believed to predict retention; this
   * tests it. Fired from main.ts off the browser's own `beforeinstallprompt` / `appinstalled`.
   *
   * ⚠️ Read as a FLOOR, not a total: both events are Chromium-only, so every iOS install (a manual
   * Share → "Add to Home Screen") is invisible here, and `install_accepted` can exceed
   * `install_shown` when the install starts from the browser menu. The cross-platform "is this
   * player installed" signal is APP_OPEN's `standalone` prop below, which every client reports on
   * every open; this pair answers the narrower question of whether an offered install is taken.
   */
  INSTALL_SHOWN: 'install_shown',
  INSTALL_ACCEPTED: 'install_accepted',

  /**
   * The game's OWN install sheet (view/installsheet.ts), added 2026-08-03 — distinct from the pair
   * above, which track the *browser's* events. Keeping them separate is what preserves the older
   * funnel's meaning across this change: `install_shown` still counts "a Chromium install became
   * available", while these two count "we offered it" and "what the player did".
   *
   * `install_sheet` props: {source, mode} — mode is core/install.ts's InstallState, so the iOS
   * guide ('manual-ios') and the real one-tap prompt ('ready') stay separable. THIS is the event
   * that finally makes iOS installs measurable: `install_result` with outcome 'guided' means a
   * player read the Share → Add to Home Screen steps to the end, which is the closest signal iOS
   * permits (Apple fires no appinstalled). Confirm the install itself against APP_OPEN's
   * `standalone` prop on a LATER session — that remains the only ground truth on iOS.
   *
   * `install_result` props: {outcome, source} — 'accepted' | 'dismissed' (the real Chromium
   * choice), 'guided' (read the iOS steps), 'not_now' | 'scrim' (declined).
   */
  INSTALL_SHEET: 'install_sheet',
  INSTALL_RESULT: 'install_result',

  /**
   * The home banner actually MOUNTED. Added 2026-08-06 to close the hole that made every number
   * above unreadable: the banner self-destructs after 14s and on scene change, both SILENTLY, so
   * `install_result` only ever fired when a player pressed × or reached an outcome. "Few results"
   * was therefore equally consistent with *nobody saw it* and *everybody saw it and ignored it* —
   * two problems with opposite fixes, and no way to tell them apart. Measured on 2026-08-06: of 67
   * real players not installed, 14 had a one-tap install captured and only 4 produced any result at
   * all, which is exactly the ambiguity this resolves.
   *
   * props: {mode, source}. `mode` is the same InstallState as `install_sheet`, which is what makes
   * the iOS ('manual-ios') and Chromium ('ready') halves separable WITHOUT putting a platform prop
   * on app_open — see the note there.
   *
   * No migration needed: the RPC's `counts` block is a plain `group by name`, so a new event shows
   * up in the dashboard's raw counts on its own. The hardcoded `name in (...)` lists in 0014/0015/
   * 0021/0022 scope the LEVEL funnel specifically, not what is visible at all. Purpose-built funnel
   * CHARTS are client-side (`src/stats/model.ts`), which is where this was added to the install one.
   */
  INSTALL_OFFER_SHOWN: 'install_offer_shown',

  /**
   * The install REWARD paid out — a one-time grant on the first launch of the installed app.
   * props: {chips, boost}. Fired from the card, after the grant, so it counts money that really
   * moved rather than intentions.
   */
  INSTALL_REWARD: 'install_reward',

  /**
   * Resume health (core/resumeguard.ts), added 2026-08-03 after a Galaxy S25 player reported the
   * game frozen after switching apps and back, needing a force-quit.
   *
   * `resume_stall` fires ONLY when the game loop failed to advance a frame after a resume — never on
   * a healthy one, or it would be the noisiest row in the table and say nothing. Props carry the
   * diagnosis: `stage` ('detected' | 'recovered_by_wake' | 'reloading'), plus `contextLost`,
   * `running`, `sleeping`, `scenes` and `boardState`. Those five fields separate the three causes
   * that share this symptom — a lost GPU context, a wedged requestAnimationFrame, and a resolve loop
   * hung on a tween promise (`boardState: 'resolving'` is the tell for the last one).
   *
   * `context_lost` is the WebGL context going away and coming back, which on Android is a memory-
   * pressure eviction rather than a bug. Worth counting separately: it is the one cause the game
   * cannot repair in place, since every texture here is baked at runtime with no file to reload.
   */
  RESUME_STALL: 'resume_stall',
  CONTEXT_LOST: 'context_lost',

  /** Push opt-in funnel. */
  PUSH_SHOWN: 'push_shown',
  PUSH_ENABLED: 'push_enabled',
  PUSH_BLOCKED: 'push_blocked',

  /** {surface} — invite/share. Answers "did the referral system ever do anything". */
  SHARE_CLICKED: 'share_clicked',
  REFERRAL_CAPTURED: 'referral_captured',
  REFERRAL_REGISTERED: 'referral_registered',

  /**
   * {cascade, endless, stake} on offer → {slot, mult, payout, spins, endless} on claim.
   *
   * `plinko_played` is the only field check on the slot table, and the 2026-07-31 ×10 retune (edges
   * 4% → 6% numbered / 8% endless) is the first thing it has to answer for. `endless` rides on BOTH
   * halves because the two modes roll different weight tables now — a slot histogram pooled across
   * them describes neither board.
   *
   * ⚠️ It was declared here and charted in the dashboard funnel from the start, but nothing fired it
   * until 2026-07-31, so "Offered → Dropped" sat at a permanent 0% that was indistinguishable from
   * real abandonment. `model.test.ts` now pins every funnel step against the source text of its
   * senders, which is the check that would have caught it.
   */
  PLINKO_OFFERED: 'plinko_offered',
  PLINKO_PLAYED: 'plinko_played',

  /**
   * The Lucky Deal. {level, streak} on offer → {face, chips, flips, fast, charm} on the match.
   *
   * `streak` is the one worth watching: the Deal fires every third consecutive win, so the DISTRIBUTION
   * of streaks at which it fires answers the question the trigger was chosen to test — whether players
   * actually string wins together, or whether a loss resets almost everyone at 3 and the Deal ends up
   * a once-an-evening event instead of a rhythm. `flips` measures the pace claim (the model says ~7.5),
   * and `face` is the only field check on the luck-weighted table.
   */
  DEAL_OFFERED: 'deal_offered',
  DEAL_WON: 'deal_won',

  /**
   * §G2 the out-of-moves continue funnel: {level, price, chips, near} shown → {level, price} taken.
   * `shown` minus `taken` is the decline rate, and `near` (goal pieces still owed) is what makes the
   * pair readable — a high decline rate on near=1 means the price is wrong, while a high decline on
   * near=40 just means the offer fired on a level the player had already given up on.
   * A level that is failed far more often than it is continued is a wall; one that is continued far
   * more often than it is failed is a level whose move budget is simply short.
   */
  CONTINUE_SHOWN: 'continue_shown',
  CONTINUE_TAKEN: 'continue_taken',

  /**
   * LUCKY SLOTS — the first thing in the build a player SPENDS chips on for a chance rather than a
   * certainty, so it is the first place the economy can be wrong in a way nobody feels until later.
   *
   * `slots_opened` {chips, rows} against `slots_spun` {rows, price, lines, boosts, points, charm} is
   * the bet ladder's own report card. The design bets that players climb it — more rows costs more but
   * returns more (core/slots.ts SLOT_BETS) — and the DISTRIBUTION of `rows` is the only way to find out
   * whether they do, or whether everyone parks on the cheapest tier where the edge is steepest and the
   * hit rate is one spin in eleven. An open with no spin behind it reads just as loudly: it means the
   * cabinet was looked at and walked away from.
   */
  SLOTS_OPENED: 'slots_opened',
  SLOTS_SPUN: 'slots_spun',

  /**
   * THE MARKER (Slice 0) — the opt-in side bet on numbered levels 151+. `offered` → `taken` is the
   * appetite read (an offer nobody slides is priced wrong); `won`/`lost` with {stake} sizes the
   * ladder the way slots_spun's {rows} does, and `lost`'s {comped} watches the daily mercy valve.
   */
  MARKER_OFFERED: 'marker_offered',
  MARKER_TAKEN: 'marker_taken',
  MARKER_WON: 'marker_won',
  MARKER_LOST: 'marker_lost',

  /**
   * ACT II — THE HIGH-ROLLER FLOORS (Slice 1).
   *
   * `act2_reveal` {source} — THE PRIVATE ELEVATOR card rendered. `source` is 'finale' (chained off
   * the chapter-30 car ceremony, the intended moment) or 'home' (the catch-up door for players who
   * were already past 300 when the act shipped). The split is the whole point: 'home' counts a
   * one-time back-fill cohort and will go to zero, so pooling the two would make the act look like
   * it launched twice as well as it did.
   *
   * `floor_enter` {floor, level} — a floor's one-time door card. Deliberately NOT per level: fifty
   * `level_start` rows already say how much of a floor gets played, and an event that fired on every
   * one of them would answer the same question with fifty times the noise. What this measures is
   * ARRIVAL — how many players ever reach floor 2 at all.
   */
  ACT2_REVEAL: 'act2_reveal',
  FLOOR_ENTER: 'floor_enter',

  /**
   * THE CHASE (Slice 3) — the neighbour window on the level ladder.
   *
   * `chase_shown` {gap_above, gap_below} — a chase line rendered with live data. The two gaps are
   * the whole measurement: this feature's bet is that a player at the median rung will act on a
   * target FIVE levels away when they would not act on one eighty away, and the distribution of
   * `gap_above` is the only thing that says whether the window is cut at a useful width. A gap of
   * -1 means that side was empty (top of the ladder, or nobody behind yet), which at fifteen
   * players is a common and expected reading — pooling it with 0 would hide how often the sparse
   * fallbacks actually fire.
   *
   * `chase_overtake` {level} — the YOU PASSED beat fired on a win card. Deliberately carries no
   * name: who was passed is between the two players, and the level it happened at is what says
   * whether the chase is doing work up and down the whole ladder or only near the frontier.
   */
  CHASE_SHOWN: 'chase_shown',
  CHASE_OVERTAKE: 'chase_overtake',

  /** The update toast, which the PWA stale-build trap makes worth watching. */
  UPDATE_SHOWN: 'update_shown',
  UPDATE_APPLIED: 'update_applied',

  /**
   * {message, source?, stack?, kind?} — an uncaught exception or unhandled rejection reached the
   * top. Without this, a broken deploy is invisible until a player complains — and this game's
   * players don't file bugs, they quietly stop opening it. Capped hard (ERROR_LIMIT per session,
   * one per distinct message) so an error loop in a render frame cannot flood the pipe; the
   * dashboard splits these by app_version, which is what turns "something broke" into "THIS deploy
   * broke it".
   */
  CLIENT_ERROR: 'client_error',
} as const

export type EventName = (typeof EVENTS)[keyof typeof EVENTS]

interface QueuedEvent {
  device_id: string
  session_id: string
  user_id?: string | null
  name: string
  props: Record<string, unknown>
  app_version: string
  /**
   * Idempotency key (0015/0018/0019). A flush whose response is lost re-queues its batch, so a
   * POST that actually landed can be re-sent. Minted once per event and kept across re-queues;
   * that persistence IS the dedupe. Two server-side halves catch it, on purpose:
   *   · `ingest_events()` (0019) — atomic `on conflict do nothing`, what the 'rpc' rung uses;
   *   · the guard trigger (0018) — skips a row whose id it has already stored, so the lower rungs
   *     and every OLD CACHED CLIENT still dedupe without knowing the RPC exists.
   * Never sent as an upsert: that wire shape is impossible on this table (see `wire` below).
   */
  event_id: string
}

/** Flush when the queue reaches this many — keeps a chatty session from hoarding events in memory. */
const BATCH_SIZE = 20
/** …or when this long has passed, so a quiet session still reports before the player leaves. */
const FLUSH_MS = 15_000
/** Hard cap. If the network is down for a whole session, drop the OLDEST rather than grow forever. */
const MAX_QUEUE = 200

let queue: QueuedEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let deviceId: string | null = null
let sessionId: string | null = null
let started = false
/** Set by initAnalytics from core/cloud, so events can carry attribution without importing cloud here. */
let currentUserId: (() => string | null) | null = null
let currentToken: (() => string | null) | null = null
/**
 * Which wire this session sends on. It only ever steps DOWN, once per rung, and every step re-queues
 * the batch that provoked it: a client deployed ahead of its migrations must delay events, never
 * lose them (the 0008/0009 lesson). Session-scoped on purpose — the next app open starts back at
 * 'rpc' and heals itself the moment the server catches up.
 *
 *   'rpc'    → POST /rest/v1/rpc/ingest_events (0019). Dedupes ATOMICALLY, and is the only rung
 *              that cannot lose a resend racing its own original.
 *   'direct' → POST /rest/v1/events. 0010's plain INSERT policy, on every server since. Still
 *              dedupes — the 0018 guard trigger skips an id it has already stored — but by an
 *              exists() check, so a true concurrent resend can reach 0015's unique index and 409.
 *              That is why a 4xx here steps down instead of dropping.
 *   'legacy' → the same, with event_id stripped — for a server that predates 0015's column. No
 *              dedupe is possible without an id; delivering the events still beats losing them.
 *
 * ⚠️ WHAT IS NOT HERE, AND MUST NOT COME BACK: `?on_conflict=event_id` +
 * `Prefer: resolution=ignore-duplicates`. 0015 specified that shape and it CANNOT WORK on this
 * table — `ON CONFLICT` makes PostgreSQL require SELECT rights on the target, which folds the
 * table's SELECT policies in as an extra WITH CHECK on the new row; `events` deliberately has none
 * (0010), so the check is a constant false and every send is refused 42501 → 401. The only policy
 * that satisfies it is `for select using (true)`, i.e. publishing the whole behavioural log. It
 * shipped, and because a 401 is not a 400 the old code DROPPED every batch — the dedupe bug was
 * silently a total-data-loss bug. 0019 moves the conflict handling server-side instead.
 */
type Wire = 'rpc' | 'direct' | 'legacy'
let wire: Wire = 'rpc'
/** client_error budget: at most ERROR_LIMIT per session, one per distinct message. */
const ERROR_LIMIT = 5
let errorsSent = 0
const seenErrors = new Set<string>()

function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // fall through
  }
  // Non-crypto fallback (older WebViews). Uniqueness here only needs to hold across this one
  // installation, not globally, so Math.random is sufficient.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** localStorage can throw (private mode, quota) — the same hazard save.ts already guards. */
function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeLS(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // unavailable — analytics degrades to per-session, the game is unaffected
  }
}

/**
 * The stable anonymous id. Minted once and reused forever; a cache wipe mints a new one, which
 * slightly inflates "new device" counts. That is the accepted cost of storing no fingerprint —
 * the alternative (deriving an id from device characteristics) is exactly the tracking this
 * game's privacy policy promises not to do.
 */
function getDeviceId(): string {
  if (deviceId) return deviceId
  const existing = readLS(DEVICE_KEY)
  if (existing && existing.length >= 8) {
    deviceId = existing
  } else {
    deviceId = uuid()
    writeLS(DEVICE_KEY, deviceId)
  }
  return deviceId
}

/** True unless the player opted out locally. */
export function analyticsEnabled(): boolean {
  return readLS(OPTOUT_KEY) !== '1'
}

/** Opt out (or back in). Opting out also discards anything already queued. */
export function setAnalyticsEnabled(on: boolean): void {
  writeLS(OPTOUT_KEY, on ? '0' : '1')
  if (!on) queue = []
}

function configured(): boolean {
  return !!supabaseUrl() && !!supabaseKey()
}

/**
 * Queue an event. Safe to call from anywhere, including a scene's update loop — it does no network
 * work and never throws.
 */
export function track(name: EventName | string, props: Record<string, unknown> = {}): void {
  try {
    if (!configured() || !analyticsEnabled()) return
    if (!sessionId) sessionId = uuid()

    queue.push({
      device_id: getDeviceId(),
      session_id: sessionId,
      // Only set when signed in. RLS pins this to auth.uid(), so a wrong value would be REJECTED
      // (0010) — null is both the honest value and the safe one.
      user_id: currentUserId?.() ?? null,
      name,
      props,
      app_version: APP_VERSION,
      event_id: uuid(),
    })

    // Drop the OLDEST on overflow: during a long offline stretch the recent events are the ones
    // that still describe what the player is doing now.
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)

    if (queue.length >= BATCH_SIZE) {
      void flush()
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        void flush()
      }, FLUSH_MS)
    }
  } catch {
    // analytics must never surface into gameplay
  }
}

/**
 * Send whatever is queued.
 *
 * `keepalive` is what makes the unload path work: a normal fetch is cancelled when the page goes
 * away, which would lose precisely the last events of a session — the ones that say where the player
 * stopped. Failures re-queue rather than retry in place; the next flush (or the next app open) picks
 * them up, and a permanently offline player just tops out at MAX_QUEUE.
 */
async function flush(unloading = false): Promise<void> {
  if (!configured() || queue.length === 0) return
  const batch = queue
  queue = []
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  const token = currentToken?.() ?? null
  const key = supabaseKey() as string
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: key,
    // A signed-in player's own JWT. On the RPC path it is what auth.uid() reads to attribute the
    // rows; on the direct path it is what makes RLS admit a non-null user_id (0010).
    Authorization: `Bearer ${token ?? key}`,
  }

  let url: string
  let body: string
  if (wire === 'rpc') {
    url = `${supabaseUrl()}/rest/v1/rpc/ingest_events`
    // The batch goes up unreshaped. ingest_events takes user_id from the VERIFIED JWT and ignores
    // whatever the row claims, so the field riding along is inert (0019). The reply is a small
    // integer — how many rows were new — which nothing here needs; the flush is fire-and-forget.
    body = JSON.stringify({ p_events: batch })
  } else {
    // A PLAIN insert, deliberately — never `on_conflict`/upsert, on any rung. Dedupe here is the
    // guard trigger's (0018), where definer context can see what this client can't; it is why the
    // lower rungs still dedupe at all.
    url = `${supabaseUrl()}/rest/v1/events`
    // return=minimal: write-only table, nothing reads the result.
    headers.Prefer = 'return=minimal'
    // Pre-0015 servers reject unknown columns outright, so the legacy rung strips the ids from the
    // wire (the queue keeps them — they ride again if a later session reaches a server that has
    // ingest_events).
    body = JSON.stringify(
      wire === 'legacy' ? batch.map(({ event_id: _drop, ...rest }) => rest) : batch
    )
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      keepalive: unloading,
      // Analytics must never keep a connection alive that the game needs.
      cache: 'no-store',
    })
    if (!res.ok) {
      const requeue = () => {
        queue = batch.concat(queue).slice(-MAX_QUEUE)
      }
      if (res.status >= 500) {
        // Server trouble — keep the batch for the next flush, same rung.
        requeue()
      } else if (wire !== 'legacy') {
        // ANY 4xx steps down one rung and RE-QUEUES — never only the status we predicted.
        // Guessing is what broke this pipe: the fallback was written for the 400 a missing column
        // returns, the real failure was the 401 an impossible upsert returns, and every batch fell
        // through to the drop below. Refusal taxonomies drift (400 unknown column, 404 missing
        // function, 409 the unique index catching a trigger-dedupe race), and each lower rung is a
        // strictly more permissive wire — so a wrong guess must cost a retry, never the funnel.
        wire = wire === 'rpc' ? 'direct' : 'legacy'
        requeue()
      }
      // On the legacy rung everything strippable is already stripped: a 4xx there is a batch that
      // will never be accepted (bad shape, revoked key), and dropping it is correct.
    }
  } catch {
    queue = batch.concat(queue).slice(-MAX_QUEUE)
  }
}

/**
 * Report an uncaught error as a CLIENT_ERROR event — bounded hard, because error telemetry that can
 * flood is worse than none: one per distinct message per session, ERROR_LIMIT per session total,
 * every string truncated. Exported for tests; the game never calls it directly (the window
 * listeners in initAnalytics do).
 */
export function _reportClientError(message: unknown, extra: Record<string, unknown> = {}): void {
  try {
    const msg = String(message ?? 'unknown').slice(0, 200)
    if (errorsSent >= ERROR_LIMIT || seenErrors.has(msg)) return
    seenErrors.add(msg)
    errorsSent++
    track(EVENTS.CLIENT_ERROR, { message: msg, ...extra })
  } catch {
    // the error reporter must never itself become an error source
  }
}

/**
 * Wire up the session: mint a session id, log the open, and arrange for the queue to be flushed when
 * the player leaves.
 *
 * `visibilitychange`→hidden is the ONLY reliable "leaving" signal on iOS — `beforeunload` and
 * `unload` are not fired when an app is swiped away or backgrounded, which is how a phone player
 * almost always ends a session. `pagehide` covers the bfcache case on desktop. Both are registered.
 *
 * @param getUserId  reads the current signed-in user id (core/cloud), or null
 * @param getToken   reads the current access token (core/cloud), or null
 */
export function initAnalytics(
  getUserId: () => string | null,
  getToken: () => string | null
): void {
  if (started || !configured()) return
  started = true
  currentUserId = getUserId
  currentToken = getToken
  // `??=`, not `=`: an event can legitimately be tracked BEFORE this runs — the service-worker
  // update toast fires from registerSW at module scope, ahead of the cloud bootstrap this is
  // sequenced behind. Overwriting would split one real session into two.
  sessionId ??= uuid()

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void flush(true)
    })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => void flush(true))
    // A reconnect is the natural moment to drain anything the offline stretch accumulated.
    window.addEventListener('online', () => void flush())

    // Crash telemetry (0015). Uncaught exceptions and unhandled rejections are the failures no
    // player will ever report — they just stop opening the game. `source` keeps only the file's
    // basename: full URLs add bytes, not signal, when every bundle is one hashed file. The first
    // stack frames ride along for the dashboard's top-errors table.
    window.addEventListener('error', e => {
      const src = typeof e.filename === 'string' ? e.filename.split('/').pop() : undefined
      const stack = (e.error as { stack?: unknown } | null)?.stack
      _reportClientError(e.message, {
        source: src ? `${src}:${e.lineno ?? 0}`.slice(0, 120) : undefined,
        stack: typeof stack === 'string' ? stack.split('\n').slice(0, 3).join(' | ').slice(0, 300) : undefined,
      })
    })
    window.addEventListener('unhandledrejection', e => {
      const reason = e.reason as { message?: unknown; stack?: unknown } | null | undefined
      _reportClientError(reason?.message ?? reason, {
        kind: 'promise',
        stack:
          typeof reason?.stack === 'string'
            ? reason.stack.split('\n').slice(0, 3).join(' | ').slice(0, 300)
            : undefined,
      })
    })
  }

  track(EVENTS.APP_OPEN, {
    standalone:
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(display-mode: standalone)').matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true),
    lang: typeof navigator !== 'undefined' ? navigator.language : undefined,
  })
}

/** Test/diagnostic seam: what is waiting to be sent. Not part of the game's runtime surface. */
export function _queueDepth(): number {
  return queue.length
}

/** Test seam: run a flush and await it (flush is otherwise fire-and-forget internal). */
export function _flush(unloading = false): Promise<void> {
  return flush(unloading)
}

/** Test seam: drop all state so each test starts clean. */
export function _reset(): void {
  queue = []
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  deviceId = null
  sessionId = null
  started = false
  currentUserId = null
  currentToken = null
  wire = 'rpc'
  errorsSent = 0
  seenErrors.clear()
}
