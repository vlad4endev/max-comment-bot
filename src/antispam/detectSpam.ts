import { normalizeAndStemWords, normalizeObfuscation } from './normalize'
import type { ScoredWordsByScore } from '../db/seedAntispamScoredWords'
import { ANTISPAM_SCORE_TIERS } from '../db/seedAntispamScoredWords'
import {
  buildStopWordIndexes,
  checkSafePhraseReduction,
  checkStopWords,
  type StopWordIndex,
} from './stopWords'

export interface AntispamDetectConfig {
  softMode: boolean
  enabled: boolean
  spamThreshold: number
  banThreshold: number
  captchaRequiredScore: number
  emojiOveruseLimit: number
  pureEmojiMaxTextLength: number
  minDistinctCategories: number
  blockLinks: boolean
  emojiSpam: boolean
  /** Доп. стоп-слова из админки (глобальные + канала) с весом. */
  extraStopWordWeight: number
  extraStopWords: string[]
  /** База слов с баллами из antispam.db. */
  scoredWordsByScore: ScoredWordsByScore
}

export const DEFAULT_ANTISPAM_DETECT_CONFIG: AntispamDetectConfig = {
  softMode: false,
  enabled: true,
  spamThreshold: 20,
  banThreshold: 100,
  captchaRequiredScore: 15,
  emojiOveruseLimit: 20,
  pureEmojiMaxTextLength: 5,
  minDistinctCategories: 2,
  blockLinks: true,
  emojiSpam: true,
  extraStopWordWeight: 90,
  extraStopWords: [],
  scoredWordsByScore: {},
}

export type AntispamDetectAction = 'leave' | 'delete' | 'delete_and_ban' | 'captcha'

export interface AntispamDetectResult {
  action: AntispamDetectAction
  spamScore: number
  categories: string[]
}

const phonePattern = /\b\d{10,12}\b/
const linkPattern = /(?:https?:\/\/|t\.me\/\+?|www\.)/i
const adultPattern = /\b(?:секс|порно|интим)\b/i
const cryptoPattern = /\b(?:btc|eth|крипт|казино)\b/i

const emojiPattern = /[\u203C-\u3299\u{1F000}-\u{1FAFF}\uFE0F]/gu

function countEmojis(text: string): number {
  return (String(text).match(emojiPattern) ?? []).length
}

function isPureEmoji(text: string, maxTextLength: number): boolean {
  const n = countEmojis(text)
  const withoutEmoji = String(text).replace(emojiPattern, '').replace(/\s/g, '')
  return withoutEmoji.length <= maxTextLength && n >= 1
}

function spamTiersFromConfig(scoredWordsByScore: ScoredWordsByScore): Record<number, string[]> {
  const out: Record<number, string[]> = {}
  for (const tier of ANTISPAM_SCORE_TIERS) {
    if (tier === 0) {
      continue
    }
    out[tier] = [...(scoredWordsByScore[tier] ?? [])]
  }
  return out
}

function buildRuntimeStopIndex(
  scoredWordsByScore: ScoredWordsByScore,
  extraStopWords: string[],
  extraWeight: number,
): StopWordIndex {
  const extraExact = new Map<string, number>()
  for (const raw of extraStopWords) {
    const w = raw.trim().toLowerCase()
    if (!w || w.includes(' ')) {
      continue
    }
    extraExact.set(w, extraWeight)
  }
  const partial: Array<[string, number]> = []
  for (const raw of extraStopWords) {
    const w = raw.trim().toLowerCase()
    if (w.includes(' ')) {
      partial.push([w, extraWeight])
    }
  }
  const base = buildStopWordIndexes(spamTiersFromConfig(scoredWordsByScore))
  const exact = new Map<string, number>(base.exact)
  for (const [k, v] of extraExact) {
    exact.set(k, Math.max(exact.get(k) ?? 0, v))
  }
  return { exact, partial: [...base.partial, ...partial] }
}

/**
 * Скоринг и решение — порт detectSpam из antispam_v16 (n8n).
 */
export function detectSpam(text: string, config: AntispamDetectConfig): AntispamDetectResult {
  if (!config.enabled || !text.trim()) {
    return { action: 'leave', spamScore: 0, categories: [] }
  }

  const original = text.normalize('NFKC')
  const tokens = normalizeAndStemWords(original)
  let spamScore = 0
  const categories = new Set<string>()

  if (phonePattern.test(original)) {
    spamScore += 150
    categories.add('hard')
  }
  if (adultPattern.test(original)) {
    spamScore += 60
    categories.add('hard')
  }
  if (cryptoPattern.test(original)) {
    spamScore += 60
    categories.add('hard')
  }

  const hasLink = linkPattern.test(original)
  if (hasLink && config.blockLinks) {
    spamScore += 60
    categories.add('link')
  }

  const stopIndex = buildRuntimeStopIndex(
    config.scoredWordsByScore,
    config.extraStopWords,
    config.extraStopWordWeight,
  )
  const swScore = checkStopWords(tokens, stopIndex)
  if (swScore > 0) {
    spamScore += swScore
    categories.add('stop')
  }

  if (hasLink && config.blockLinks && swScore > 0) {
    spamScore += 40
    categories.add('combo')
  }

  if (config.emojiSpam) {
    const emojiCount = countEmojis(original)
    if (emojiCount > config.emojiOveruseLimit) {
      spamScore += 30
      categories.add('emoji')
    }
    if (isPureEmoji(original, config.pureEmojiMaxTextLength) && emojiCount > 8) {
      spamScore += 50
      categories.add('emoji')
    }
  }

  const norm = normalizeObfuscation(original.toLowerCase())
  if (/\b(мені|допоможу|гривн|₴|виграй|заробляй)\b/u.test(norm)) {
    spamScore += 45
    categories.add('uk')
  }

  const safePhrases = config.scoredWordsByScore[0] ?? []
  const safeReduction = checkSafePhraseReduction(tokens, safePhrases)
  if (safeReduction > 0) {
    spamScore = Math.max(0, spamScore - safeReduction)
    categories.add('safe')
  }

  let action: AntispamDetectAction = 'leave'
  if (spamScore >= config.banThreshold) {
    action = config.softMode ? 'leave' : 'delete_and_ban'
  } else if (spamScore >= config.spamThreshold) {
    if (categories.has('hard') || categories.size >= config.minDistinctCategories) {
      action = config.softMode ? 'leave' : 'delete'
    } else if (spamScore >= config.captchaRequiredScore) {
      action = 'captcha'
    }
  } else if (spamScore >= config.captchaRequiredScore) {
    action = 'captcha'
  }

  return { action, spamScore, categories: [...categories] }
}
