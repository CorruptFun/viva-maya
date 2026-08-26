/* eslint-disable */
/**
 * Web Push handlers, imported into the generated service worker.
 *
 * WHY A SEPARATE FILE RATHER THAN A CUSTOM SERVICE WORKER: vite-plugin-pwa runs the `generateSW`
 * strategy, so sw.js is written by Workbox and cannot be hand-edited. The alternative is switching to
 * `injectManifest`, which hands us the whole worker — including the precache wiring, the
 * navigateFallback, the denylist for about/privacy/terms, and the SKIP_WAITING plumbing that
 * main.ts's update toast drives. All of that currently works, and one of it (the stale-build trap)
 * was expensive to get right. `workbox.importScripts` adds these two listeners on top of the
 * generated worker without owning any of that, so nothing already working is put at risk.
 *
 * ⚠️ THIS FILE MUST NEVER THROW AT TOP LEVEL. It is `importScripts`-ed during service-worker
 * evaluation, so a syntax error or a thrown exception here fails the WHOLE worker install — which
 * would take offline support and the update mechanism down with it, for a feature nobody asked to
 * depend on. Hence plain ES5-ish syntax, no imports, no optional chaining, and every handler wrapped.
 *
 * Not written in TypeScript for the same reason: it ships verbatim from public/ with no build step
 * between what is reviewed here and what the browser evaluates.
 */

self.addEventListener('push', function (event) {
  var payload = {}
  try {
    // A push with no body is legal and is used by some services as a keepalive. Treat any
    // unparseable payload as empty rather than dropping the notification entirely — a silent push
    // that shows nothing looks identical to a broken subscription from the player's side.
    payload = event.data ? event.data.json() : {}
  } catch (e) {
    payload = {}
  }

  var title = payload.title || 'Viva Maya'
  var options = {
    body: payload.body || '',
    icon: 'pwa-192.png',
    badge: 'favicon-32.png',
    // `tag` + `renotify` collapse repeats: if a player somehow receives two week-ending nudges, the
    // second REPLACES the first in the tray instead of stacking. Two identical notifications is the
    // fastest way to make someone turn them off for good.
    tag: payload.tag || 'viva-maya',
    renotify: true,
    // Deliberately not `requireInteraction` — this is a game nudge, not an alarm; it should be
    // dismissible by the ordinary swipe and should time out on its own.
    data: { url: payload.url || './' },
  }

  // waitUntil keeps the worker alive until the notification is actually shown. Without it the
  // browser may kill the worker first and the push silently does nothing.
  event.waitUntil(self.registration.showNotification(title, options))
})

/**
 * Is `target` the page the game is ALREADY running? './' is the app's own address, and since the
 * sender started stamping WHICH send opened it, so is './?from=push-drop' / '-daily' / '-week'
 * (scripts/send-push.mjs `notificationUrl`; src/core/analytics.ts reads the marker once, reports it
 * as `app_open`'s `from` prop and strips it back out of the address bar). Same page, different
 * query string.
 *
 * ⚠️ THIS PREDICATE IS THE ENTIRE REASON THE MARKER IS SAFE TO SEND. The handler below navigates an
 * already-open window whenever the target is not this page — and `navigate()` is a RELOAD. Without
 * this test, the first notification carrying `?from=` would have reloaded a live game on every
 * single tap; an ENDLESS run is deliberately NOT resumable (src/core/levelresume.ts excludes it on
 * purpose — it seeds from the race board and posts a score), so that tap would have destroyed a
 * scored, timed run the player cannot get back, in exchange for an attribution that is wrong anyway
 * (see below). The condition it replaced was the literal `target !== './'`, which every future
 * marker would have walked straight past.
 *
 * `indexOf`, not `startsWith`: ES5-ish only in this file — see the header.
 */
function isSamePage(target) {
  return target === './' || target.indexOf('./?from=') === 0
}

self.addEventListener('notificationclick', function (event) {
  event.notification.close()

  var target = (event.notification.data && event.notification.data.url) || './'
  // The payload is only as well-formed as whatever wrote it, and `isSamePage` does string work on
  // this value. A number or an object here would throw inside the matchAll callback below, land the
  // tap in the catch, and then be handed to openWindow anyway. Normalise once, at the door.
  if (typeof target !== 'string') target = './'

  // ⚠️ AN OLD CACHED WORKER MEETING A NEW PAYLOAD IS HARMLESS, AND HAD TO BE. Workers update on
  // their own schedule, so for a while these payloads are delivered to workers that predate this
  // rule. Such a worker sees a target that is not './' and navigates (or opens) it — and the marker
  // itself is inert to an old BUNDLE, which never reads `from` and simply leaves it in the address
  // bar. The only cost is that one reload, for the narrow overlap of players on a stale worker who
  // tap a notification with the game already open, and it heals the next time the worker updates.
  // So no two-phase rollout is needed here; the sender may start stamping immediately.
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (windows) {
        // Prefer focusing a tab the game is ALREADY open in over opening a second one — an installed
        // PWA that spawns a duplicate window on every notification tap feels broken.
        for (var i = 0; i < windows.length; i++) {
          var client = windows[i]
          if ('focus' in client) {
            if (typeof client.navigate === 'function' && !isSamePage(target)) {
              // navigate() can reject (cross-origin, or a client that has since died); focusing
              // anyway is strictly better than dropping the tap on the floor.
              return client.navigate(target).then(
                function (c) {
                  return (c || client).focus()
                },
                function () {
                  return client.focus()
                }
              )
            }
            // Same page → FOCUS ONLY, never navigate. Losing the attribution here is the CORRECT
            // answer as well as the safe one: a player who already had the game open was not
            // brought back by the notification, and reloading in order to record an open would
            // destroy the very session being measured.
            return client.focus()
          }
        }
        // Nothing open, so nothing to lose — and this is where the attribution actually comes from:
        // a push-driven return is by definition an app that was not already running. The fresh
        // window carries the marker, and the client strips it after the one `app_open` it explains.
        return self.clients.openWindow(target)
      })
      .catch(function () {
        // Last resort: never let a tap end in an unhandled rejection.
        return self.clients.openWindow(target)
      })
  )
})
