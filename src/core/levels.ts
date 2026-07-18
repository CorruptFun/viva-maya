import { SYMBOLS } from './types'
import type { LevelSpec, SymbolType } from './types'
import { mulberry32, randInt } from './rng'

export const LEVEL_COUNT = 100

/**
 * Deterministic difficulty curve: level N always has the same goals/moves
 * (seeded off N), but every attempt plays on a fresh random board.
 */
export function levelSpec(level: number): LevelSpec {
  const rng = mulberry32((0xc0ffee ^ Math.imul(level, 2654435761)) >>> 0)

  // 5 symbols early keeps matches flowing; the 6th tightens the board from level 4.
  const symbolCount = level < 4 ? 5 : 6
  const objectiveCount = level < 3 ? 1 : level < 8 ? 2 : 3

  // Collect targets grow steadily; move budget shrinks, with a breather every 5th level.
  const perObjective = Math.min(45, 10 + Math.round(level * 2.2))
  const moves =
    Math.max(14, 26 - Math.floor(level / 2)) + (level % 5 === 0 ? 4 : 0) + objectiveCount * 2

  const pool: SymbolType[] = [...SYMBOLS.slice(0, symbolCount)]
  const objectives = []
  for (let i = 0; i < objectiveCount; i++) {
    const pick = randInt(rng, pool.length)
    objectives.push({ symbol: pool[pick], count: perObjective })
    pool.splice(pick, 1)
  }

  return { level, moves, symbolCount, objectives }
}
