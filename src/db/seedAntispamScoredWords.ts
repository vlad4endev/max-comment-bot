import { STOP_WORDS_BY_SCORE } from '../antispam/stopWords'
import { logger } from '../utils/logger'
import { getAntispamDb, getAntispamDbMeta, setAntispamDbMeta } from './antispamDatabase'
import { reloadAntispamStore } from '../services/antispamStore'

export const ANTISPAM_SCORE_TIERS = [100, 80, 10, 9, 8, 7, 6, 5, 4, 3, 0] as const

export type ScoredWordsByScore = Record<number, string[]>

/** Словарь по умолчанию (n8n v16) — для первичного заполнения и сброса. */
export function defaultScoredWordsByScore(): ScoredWordsByScore {
  const out: ScoredWordsByScore = {}
  for (const tier of ANTISPAM_SCORE_TIERS) {
    out[tier] = [...(STOP_WORDS_BY_SCORE[tier] ?? [])]
  }
  return out
}

function flattenScoredWords(dict: ScoredWordsByScore): Array<{ word: string; score: number }> {
  const wordToScore = new Map<string, number>()
  for (const tier of ANTISPAM_SCORE_TIERS) {
    for (const raw of dict[tier] ?? []) {
      const word = String(raw).trim().toLowerCase()
      if (!word) {
        continue
      }
      wordToScore.set(word, Math.max(wordToScore.get(word) ?? tier, tier))
    }
  }
  return [...wordToScore.entries()].map(([word, score]) => ({ word, score }))
}

export function scoredWordsRowsToDict(
  rows: Array<{ word: string; score: number }>,
): ScoredWordsByScore {
  const out: ScoredWordsByScore = {}
  for (const tier of ANTISPAM_SCORE_TIERS) {
    out[tier] = []
  }
  for (const row of rows) {
    const word = row.word.trim().toLowerCase()
    if (!word) {
      continue
    }
    const score = ANTISPAM_SCORE_TIERS.includes(row.score as (typeof ANTISPAM_SCORE_TIERS)[number])
      ? row.score
      : 5
    if (!out[score]) {
      out[score] = []
    }
    out[score].push(word)
  }
  for (const tier of ANTISPAM_SCORE_TIERS) {
    out[tier] = [...new Set(out[tier] ?? [])].sort((a, b) => a.localeCompare(b, 'ru'))
  }
  return out
}

export function persistScoredWords(dict: ScoredWordsByScore): void {
  const db = getAntispamDb()
  const rows = flattenScoredWords(dict)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM antispam_scored_words').run()
    const insert = db.prepare('INSERT INTO antispam_scored_words (word, score) VALUES (?, ?)')
    for (const row of rows) {
      insert.run(row.word, row.score)
    }
  })
  tx()
}

export function loadScoredWordsFromDb(): ScoredWordsByScore {
  const rows = getAntispamDb()
    .prepare('SELECT word, score FROM antispam_scored_words ORDER BY score DESC, word ASC')
    .all() as Array<{ word: string; score: number }>
  return scoredWordsRowsToDict(rows)
}

/** Первичное заполнение antispam_scored_words из встроенной базы. */
export function seedAntispamScoredWordsIfEmpty(): void {
  getAntispamDb()
  if (getAntispamDbMeta('scored_words_seeded') === '1') {
    return
  }
  const count = (
    getAntispamDb().prepare('SELECT COUNT(*) AS n FROM antispam_scored_words').get() as { n: number }
  ).n
  if (count > 0) {
    setAntispamDbMeta('scored_words_seeded', '1')
    return
  }
  persistScoredWords(defaultScoredWordsByScore())
  setAntispamDbMeta('scored_words_seeded', '1')
  reloadAntispamStore()
  logger.info('seedAntispamScoredWordsIfEmpty: loaded default scored word base')
}

export function resetScoredWordsToDefault(): ScoredWordsByScore {
  const dict = defaultScoredWordsByScore()
  persistScoredWords(dict)
  reloadAntispamStore()
  return dict
}
