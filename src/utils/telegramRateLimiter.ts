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

/**
 * Каждый токен бота (и MTProto) — своя «полоса»: своя очередь, свой минимальный интервал
 * и своя пауза FLOOD_WAIT. Раньше всё было общим, и 429 у одной связки замораживал остальные.
 */
export const MTPROTO_LANE = 'mtproto'

type Lane = { tail: Promise<void>; lastCallAt: number; pauseUntil: number }

const lanes = new Map<string, Lane>()

function laneFor(scope: string): Lane {
  let lane = lanes.get(scope)
  if (!lane) {
    lane = { tail: Promise.resolve(), lastCallAt: 0, pauseUntil: 0 }
    lanes.set(scope, lane)
  }
  return lane
}

function laneLabel(scope: string): string {
  return scope === MTPROTO_LANE ? MTPROTO_LANE : `bot…${scope.slice(-6)}`
}

/** Пауза именно этой полосы (токена). Без scope — есть ли пауза хоть у одной. */
export function isTelegramApiPaused(scope?: string): boolean {
  const now = Date.now()
  if (scope !== undefined) {
    return now < (lanes.get(scope)?.pauseUntil ?? 0)
  }
  for (const lane of lanes.values()) {
    if (now < lane.pauseUntil) {
      return true
    }
  }
  return false
}

export function getTelegramApiPauseRemainingMs(scope: string): number {
  return Math.max(0, (lanes.get(scope)?.pauseUntil ?? 0) - Date.now())
}

export function pauseTelegramLane(scope: string, seconds: number): void {
  const lane = laneFor(scope)
  const until = Date.now() + (seconds + 1) * 1_000
  if (until > lane.pauseUntil) {
    lane.pauseUntil = until
    logger.warn('[telegramRateLimiter] pause extended', {
      lane: laneLabel(scope),
      waitSeconds: seconds,
      pauseUntil: new Date(lane.pauseUntil).toISOString(),
    })
  }
}

async function waitForSlot(scope: string): Promise<void> {
  const lane = laneFor(scope)
  const minInterval = getTelegramApiMinIntervalMs()
  const pauseWait = lane.pauseUntil - Date.now()
  if (pauseWait > 0) {
    await sleep(pauseWait)
  }
  const intervalWait = lane.lastCallAt + minInterval - Date.now()
  if (intervalWait > 0) {
    await sleep(intervalWait)
  }
  lane.lastCallAt = Date.now()
}

/**
 * Сериализует вызовы в рамках одной полосы с минимальным интервалом и учётом FLOOD_WAIT.
 * Разные полосы (токены) идут независимо.
 */
export function enqueueTelegramApiCall<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  const lane = laneFor(scope)
  const run = async (): Promise<T> => {
    await waitForSlot(scope)
    return fn()
  }
  const result = lane.tail.then(run, run)
  lane.tail = result.then(
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
      data = await enqueueTelegramApiCall(token, async () => {
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
      pauseTelegramLane(token, floodSeconds)
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
 * Оборачивает MTProto/другие вызовы с FLOOD_WAIT в паузу своей полосы (по умолчанию MTProto).
 */
export async function withTelegramFloodWaitBackoff<T>(
  label: string,
  run: () => Promise<T>,
  maxRetries = 3,
  scope: string = MTPROTO_LANE,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await waitForSlot(scope)
    try {
      return await run()
    } catch (err: unknown) {
      const errText = extractTelegramErrorText(err)
      const floodSeconds = parseFloodWaitSeconds(errText)
      if (floodSeconds != null && attempt < maxRetries) {
        pauseTelegramLane(scope, floodSeconds)
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
