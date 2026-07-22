// ─────────────────────────────────────────────────────────────────────────────
// Promo / reward CODES (existing-user side; referrals cover new users via links).
// A signed-in player types a code you handed out; redeem_promo (0005) validates it
// server-side — the client never sees the code table, so codes can't be enumerated
// and single-use is enforced in Postgres — and returns the reward, which lands in
// the local save. Dormant-safe and NEVER throws: cloud off / signed out / offline
// all degrade to a typed reason, and the game keeps running regardless.
// ─────────────────────────────────────────────────────────────────────────────

import { cloudSession, isCloudConfigured, sbClient } from './cloud'
import { grantPromoReward } from './save'
import type { BoostType, PromoReward } from './types'

const CODE_RE = /^[A-Z0-9]{4,16}$/
const BOOSTS: readonly string[] = ['wildReel', 'diceBomb', 'jackpot', 'extraMoves', 'doubleScore']

export type RedeemReason =
  | 'unconfigured' // cloud off (dormant build)
  | 'signed_out' // needs an account
  | 'offline' // network / RPC unreachable / malformed
  | 'invalid' // bad format, rejected client-side
  | 'not_found' // no such code
  | 'inactive' // retired
  | 'expired'
  | 'already' // this account already redeemed it
  | 'exhausted' // global cap reached

export interface RedeemResult {
  ok: boolean
  reason?: RedeemReason
  reward?: PromoReward // present when ok
  balance?: number // resulting chip balance when ok
}

/** Normalize a typed code to the on-wire form (trim, uppercase). */
export function normalizeCode(raw: string): string {
  return (raw || '').trim().toUpperCase()
}

/** Cheap client-side format gate (reject before hitting the network). */
export function isValidCodeFormat(raw: string): boolean {
  return CODE_RE.test(normalizeCode(raw))
}

/**
 * Redeem a promo code. Server-validated via the redeem_promo RPC; on success the reward is granted
 * to the local save and the new chip balance is returned. Never throws — every failure is a typed
 * reason (see reasonMessage).
 */
export async function redeemCode(raw: string): Promise<RedeemResult> {
  const code = normalizeCode(raw)
  if (!CODE_RE.test(code)) return { ok: false, reason: 'invalid' }
  if (!isCloudConfigured()) return { ok: false, reason: 'unconfigured' }
  try {
    if (!cloudSession()) return { ok: false, reason: 'signed_out' }
    const c = await sbClient()
    if (!c) return { ok: false, reason: 'unconfigured' }
    const { data, error } = await c.rpc('redeem_promo', { p_code: code })
    if (error || data == null || typeof data !== 'object') return { ok: false, reason: 'offline' }
    const res = data as { ok?: boolean; reason?: string; kind?: string; amount?: number; boost_type?: string | null }
    if (!res.ok) return { ok: false, reason: mapReason(res.reason) }
    const reward = parseReward(res)
    if (!reward) return { ok: false, reason: 'offline' } // malformed payload → grant nothing
    return { ok: true, reward, balance: grantPromoReward(reward) }
  } catch {
    return { ok: false, reason: 'offline' }
  }
}

function mapReason(reason: string | undefined): RedeemReason {
  switch (reason) {
    case 'not_found':
    case 'inactive':
    case 'expired':
    case 'already':
    case 'exhausted':
    case 'signed_out':
      return reason
    default:
      return 'offline'
  }
}

function parseReward(res: { kind?: string; amount?: number; boost_type?: string | null }): PromoReward | null {
  const amount = Math.max(0, Math.floor(Number(res.amount) || 0))
  if (res.kind === 'chips') return { kind: 'chips', amount }
  if (res.kind === 'hearts') return { kind: 'hearts', amount }
  if (res.kind === 'boost' && typeof res.boost_type === 'string' && BOOSTS.includes(res.boost_type)) {
    return { kind: 'boost', amount: amount || 1, boostType: res.boost_type as BoostType }
  }
  return null
}

const BOOST_NAMES: Record<BoostType, string> = {
  wildReel: 'Wild Reel',
  diceBomb: 'Dice Bomb',
  jackpot: 'Jackpot Chip',
  extraMoves: '+5 Moves',
  doubleScore: 'Double Score',
}

/** Human-readable line for a granted reward (modal headline + toast). */
export function rewardLabel(reward: PromoReward): string {
  if (reward.kind === 'chips') return `+${reward.amount.toLocaleString()} chips`
  if (reward.kind === 'hearts') return 'Full hearts'
  const n = reward.amount || 1
  const name = reward.boostType ? BOOST_NAMES[reward.boostType] : 'Boost'
  return n > 1 ? `${n}× ${name}` : name
}

/** Player-facing message for a failed redeem reason. */
export function reasonMessage(reason: RedeemReason | undefined): string {
  switch (reason) {
    case 'signed_out':
      return 'Sign in first to redeem a code.'
    case 'invalid':
      return 'That doesn’t look like a valid code.'
    case 'not_found':
      return 'No such code — check the spelling.'
    case 'inactive':
      return 'This code has been retired.'
    case 'expired':
      return 'This code has expired.'
    case 'already':
      return 'You’ve already redeemed this code.'
    case 'exhausted':
      return 'This code has been fully claimed.'
    case 'unconfigured':
      return 'Codes aren’t available right now.'
    default:
      return 'Couldn’t reach the server — try again.'
  }
}
