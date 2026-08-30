/**
 * Очередь и rate limiting для Telegram Bot API.
 * Сериализует исходящие запросы, соблюдает минимальный интервал и обрабатывает FLOOD_WAIT.
 */

import axios from 'axios'

import { logger } from './logger'
import { telegramAxios } from './telegramAxios'
import {
  extractTelegramErrorText,
  isTelegramForbiddenError,
  isTelegramUnauthorizedError,
  parseTelegramAxiosResponseBody,
} from './telegramSyncErrors'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface TelegramBotApiResponse {
  ok: boolean
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
  result?: unknown
}

/** Минимальный интервал между вызовами Bot API (мс). По умолчанию 350. */
export function getTelegramApiMinIntervalMs(): number {
  const raw = (process.env.TELEGRAM_API_MIN_INTERVAL_MS ?? '').trim()
  if (raw === '') {
    return 350
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 50) {
    return 350
  }
  return Math.min(parsed, 10_000)
}

/** Сколько комментариев обрабатывать за один цикл синхронизации MAX→TG. */
export function getTelegramCommentSyncBatchSize(): number {
  const raw = (process.env.TELEGRAM_COMMENT_SYNC_BATCH_SIZE ?? '').trim()
  if (raw === '') {
    return 15
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 15
  }
  return Math.min(parsed, 40)
}

/** Интервал цикла синхронизации комментариев MAX→TG (мс). */
export function getMaxCommentSyncIntervalMs(): number {
  const raw = (process.env.MAX_COMMENT_SYNC_INTERVAL_MS ?? '').trim()
  if (raw === '') {
    return 2_000
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return 2_000
  }
  return Math.min(parsed, 300_000)
}

export function parseFloodWaitSeconds(text: string, parameters?: { retry_after?: number }): number | null {
  const fromParams = parameters?.retry_after
  if (typeof fromParams === 'number' && Number.isFinite(fromParams) && fromParams > 0) {
    return Math.ceil(fromParams)
  }
  const match = /retry after (\d+)/i.exec(text)
  if (match?.[1]) {
    return Math.max(1, Number.parseInt(match[1], 10))
  }
  const floodMatch = /FLOOD_WAIT_?(\d+)/i.exec(text)
  if (floodMatch?.[1]) {
    return Math.max(1, Number.parseInt(floodMatch[1], 10))
  }
  return null
}

let chain: Promise<void> = Promise.resolve()
let lastCallAt = 0
let globalPauseUntil = 0

export function isTelegramApiPaused(): boolean {
  return Date.now() < globalPauseUntil
}

export function getTelegramApiPauseRemainingMs(): number {
  return Math.max(0, globalPauseUntil - Date.now())
}

function extendGlobalPause(seconds: number): void {
  const until = Date.now() + (seconds + 1) * 1_000
  if (until > globalPauseUntil) {
    globalPauseUntil = until
    logger.warn('[telegramRateLimiter] global pause extended', {
      waitSeconds: seconds,
      pauseUntil: new Date(globalPauseUntil).toISOString(),
    })
  }
}

async function waitForSlot(): Promise<void> {
  const minInterval = getTelegramApiMinIntervalMs()
  const now = Date.now()
  const pauseWait = globalPauseUntil - now
  if (pauseWait > 0) {
    await sleep(pauseWait)
  }
  const intervalWait = lastCallAt + minInterval - Date.now()
  if (intervalWait > 0) {
    await sleep(intervalWait)
  }
  lastCallAt = Date.now()
}

/**
 * Сериализует вызовы Telegram Bot API с минимальным интервалом и учётом FLOOD_WAIT.
 */
export function enqueueTelegramApiCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    await waitForSlot()
    return fn()
  }
  const result = chain.then(run, run)
  chain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export type TelegramApiCallContext = {
  method: string
  chatId?: number | string
  tokenHint?: string
}

/**
 * POST к Telegram Bot API с rate limiting, retry при FLOOD_WAIT и классификацией ошибок.
 */
export async function callTelegramBotApi<T extends TelegramBotApiResponse>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  context: TelegramApiCallContext = { method },
  maxFloodRetries = 3,
): Promise<T> {
  const url = `https://api.telegram.org/bot${token}/${method}`
  const rawChatId = payload.chat_id ?? context.chatId
  const chatId =
    typeof rawChatId === 'number' || typeof rawChatId === 'string' ? rawChatId : undefined

  for (let attempt = 0; attempt <= maxFloodRetries; attempt += 1) {
    let data: T
    try {
      data = await enqueueTelegramApiCall(async () => {
        const { data: response } = await telegramAxios.post<T>(url, payload, { timeout: 20_000 })
        return response
      })
    } catch (err: unknown) {
      const fromAxiosBody = parseTelegramAxiosResponseBody(err)
      if (fromAxiosBody) {
        data = fromAxiosBody as T
      } else {
        const errText = extractTelegramErrorText(err)
        if (axios.isAxiosError(err)) {
          logger.warn('[telegramRateLimiter] Telegram HTTP error', {
            method,
            chatId,
            status: err.response?.status ?? null,
            description: errText,
          })
        }
        if (isTelegramUnauthorizedError(errText)) {
          const { reportTelegramUnauthorized } = await import('../services/telegramSyncAlertService')
          void reportTelegramUnauthorized({ method, description: errText })
        }
        throw err
      }
    }

    if (data.ok) {
      return data
    }

    const description = data.description ?? ''
    if (isTelegramUnauthorizedError(description) || data.error_code === 401) {
      const { reportTelegramUnauthorized } = await import('../services/telegramSyncAlertService')
      void reportTelegramUnauthorized({ method, description })
      return data
    }
    const floodSeconds = parseFloodWaitSeconds(description, data.parameters)
    if (floodSeconds != null && attempt < maxFloodRetries) {
      extendGlobalPause(floodSeconds)
      const { reportTelegramFloodWait } = await import('../services/telegramSyncAlertService')
      void reportTelegramFloodWait({
        method,
        chatId,
        waitSeconds: floodSeconds,
        description,
      })
      if (floodSeconds >= 60) {
        return data
      }
      continue
    }

    if (isTelegramForbiddenError(description)) {
      const { reportTelegramForbidden } = await import('../services/telegramSyncAlertService')
      void reportTelegramForbidden({
        method,
        chatId,
        description,
      })
    }

    return data
  }

  throw new Error('Telegram API: unexpected flood-wait retry exhaustion')
}

/**
 * Оборачивает MTProto/другие вызовы с FLOOD_WAIT в ту же глобальную паузу.
 */
export async function withTelegramFloodWaitBackoff<T>(
  label: string,
  run: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await waitForSlot()
    try {
      lastCallAt = Date.now()
      return await run()
    } catch (err: unknown) {
      const errText = extractTelegramErrorText(err)
      const floodSeconds = parseFloodWaitSeconds(errText)
      if (floodSeconds != null && attempt < maxRetries) {
        extendGlobalPause(floodSeconds)
        const { reportTelegramFloodWait } = await import('../services/telegramSyncAlertService')
        void reportTelegramFloodWait({
          method: label,
          waitSeconds: floodSeconds,
          description: errText,
        })
        if (floodSeconds >= 60) {
          throw err
        }
        continue
      }
      throw err
    }
  }
  throw new Error(`Telegram flood-wait retry exhausted: ${label}`)
}
