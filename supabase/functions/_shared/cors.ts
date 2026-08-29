// Shared CORS allowlist for the paid-entry Edge Functions (stripe-checkout, entitlement-status).
// The game answers on two origins (see CLAUDE.md's "two origins" note) plus local dev — a bare `*`
// would also work since these endpoints take no cookies/auth header, but an explicit allowlist means
// a copy of the API pointed at from somewhere else doesn't get a free CORS pass.
const ALLOWED_ORIGINS = new Set(['https://corruptfun.github.io', 'https://corrupt.solutions'])

export function corsHeaders(origin: string | null): HeadersInit {
  const allow =
    origin && (ALLOWED_ORIGINS.has(origin) || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))
      ? origin
      : ''
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}
