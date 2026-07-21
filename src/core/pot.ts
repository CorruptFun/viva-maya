import { loadSave, persistSave, addChips } from './save'
import {
  POT_SEED,
  POT_PER_CLEAR,
  POT_WIN_PCT,
  POT_TARGET_MIN,
  POT_TARGET_MAX,
} from '../config'
import type { Rng } from './rng'

export type PotHeatState = 'calm' | 'glowing' | 'heating_up' | 'ready'

/**
 * Returns the escalation heat state based on current progress towards the target.
 * calm (<60%) -> glowing (>=60%) -> "HEATING UP" pulse (>=85%) -> "READY!" shimmer/shake (>=100%).
 */
export function getPotHeatState(chips: number, target: number): PotHeatState {
  if (target <= 0) return 'calm'
  const pct = chips / target
  if (pct >= 1.0) return 'ready'
  if (pct >= 0.85) return 'heating_up'
  if (pct >= 0.60) return 'glowing'
  return 'calm'
}

export interface PotState {
  potChips: number
  potTarget: number
  heatState: PotHeatState
}

/** Get current state of the pot from persistence. */
export function potState(): PotState {
  const save = loadSave()
  return {
    potChips: save.potChips,
    potTarget: save.potTarget,
    heatState: getPotHeatState(save.potChips, save.potTarget),
  }
}

/** Roll a new pot target in [POT_TARGET_MIN, POT_TARGET_MAX]. Support optional seedable RNG. */
export function rollTarget(rng?: Rng): number {
  const min = POT_TARGET_MIN
  const max = POT_TARGET_MAX
  const r = rng ? rng() : Math.random()
  return min + Math.floor(r * (max - min + 1))
}

/**
 * Add a given amount to the pot.
 * Returns the new state details.
 */
export function contribute(amount: number): PotState {
  const save = loadSave()
  save.potChips = Math.max(0, save.potChips + Math.max(0, Math.floor(amount)))
  persistSave(save)
  return {
    potChips: save.potChips,
    potTarget: save.potTarget,
    heatState: getPotHeatState(save.potChips, save.potTarget),
  }
}

/** Helper to contribute goal clear amount. */
export function contributeClear(): PotState {
  return contribute(POT_PER_CLEAR)
}

/** Helper to contribute win percentage of chip rewards. */
export function contributeWin(winChips: number): PotState {
  return contribute(Math.floor(winChips * POT_WIN_PCT))
}

/**
 * Checks if the pot chips meet or exceed the target.
 * If so, transfers the entire pot balance to save.chips, resets the pot to POT_SEED,
 * and rolls a new target.
 * Pure transaction logic, no rendering.
 */
export function checkAndPop(rng?: Rng): { popped: boolean; payout: number; newTarget: number } {
  const save = loadSave()
  if (save.potChips >= save.potTarget) {
    const payout = save.potChips
    // Add to main chip balance
    addChips(payout)

    // Re-load save to make changes on top of addChips
    const updatedSave = loadSave()
    const newTarget = rollTarget(rng)
    updatedSave.potChips = POT_SEED
    updatedSave.potTarget = newTarget
    persistSave(updatedSave)

    return { popped: true, payout, newTarget }
  }
  return { popped: false, payout: 0, newTarget: save.potTarget }
}
