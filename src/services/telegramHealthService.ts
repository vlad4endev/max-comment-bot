/**
 * Периодическая проверка авторизации Telegram Bot API (getMe).
 */

import axios from 'axios'

import { getTelegramToken } from '../config'
import { logger } from '../utils/logger'
import { sendAdminAlert } from '../utils/alertService'
import { telegramAxios } from '../utils/telegramAxios'
import { isTelegramUnauthorizedError } from '../utils/telegramSyncErrors'
import { integrationsStore } from './integrationsStore'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import { reportTelegramUnauthorized } from './telegramSyncAlertService'

const TG_API = 'https://api.telegram.org'

export interface TelegramHealthSnapshot {
  checked_at: string
  has_token: boolean
  api_ok: boolean
  bot_id: number | null
  bot_username: string | null
  error: string | null
}

export interface TelegramTokenSourceReport {
  active_source: 'integrations' | 'env' | 'none'
  active_token_preview: string
  env_token_preview: string
  integrations_token_preview: string
  reader_token_preview: string
  reader_uses_main: boolean
  env_differs_from_integrations: boolean
  mismatch_warning: string | null
}

let lastSnapshot: TelegramHealthSnapshot = {
  checked_at: new Date(0).toISOString(),
  has_token: false,
  api_ok: false,
  bot_id: null,
  bot_username: null,
  error: null,
}

let monitorTimer: ReturnType<typeof setInterval> | null = null

function tokenPreview(token: string): string {
  const trimmed = token.trim()
  if (!trimmed) {
    return ''
  }
  if (trimmed.length <= 4) {
    return '••••'
  }
  return `••••${trimmed.slice(-4)}`
}

function getMonitorIntervalMs(): number {
  const raw = (process.env.TELEGRAM_HEALTH_CHECK_INTERVAL_MS ?? '').trim()
  if (raw === '') {
    return 5 * 60_000
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 30_000) {
    return 5 * 60_000
  }
  return Math.min(parsed, 60 * 60_000)
}

function extractAxiosErrorText(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status
    const data = err.response?.data
    if (typeof data === 'object' && data !== null && 'description' in data) {
      const description = String((data as { description?: string }).description ?? '').trim()
      if (description) {
        return status != null ? `${status}: ${description}` : description
      }
    }
    if (status != null) {
      return `HTTP ${status}`
    }
  }
  return err instanceof Error ? err.message : String(err ?? '')
}

/** Откуда реально берётся основной TG-токен (без раскрытия полного значения). */
export function describeTelegramTokenSources(): TelegramTokenSourceReport {
  const integToken = integrationsStore.getTelegramIntegration()?.token?.trim() ?? ''
  const envToken = getTelegramToken().trim()
  const readerToken = (process.env.TG_READER_BOT_TOKEN || '').trim()
  const activeToken = resolveTelegramBotToken()
  const activeSource: TelegramTokenSourceReport['active_source'] = integToken
    ? 'integrations'
    : envToken
      ? 'env'
      : 'none'

  let mismatchWarning: string | null = null
  if (integToken && envToken && integToken !== envToken) {
    mismatchWarning =
      'В data/integrations.json и .env разные токены — используется integrations.json. Обновите токен в Админка → Интеграции.'
  }

  return {
    active_source: activeSource,
    active_token_preview: tokenPreview(activeToken),
    env_token_preview: tokenPreview(envToken),
    integrations_token_preview: tokenPreview(integToken),
    reader_token_preview: tokenPreview(readerToken),
    reader_uses_main: !readerToken,
    env_differs_from_integrations: Boolean(integToken && envToken && integToken !== envToken),
    mismatch_warning: mismatchWarning,
  }
}

export async function isTelegramTokenAuthorized(token: string): Promise<boolean> {
  const trimmed = token.trim()
  if (!trimmed) {
    return false
  }
  try {
    const { data } = await telegramAxios.get<{ ok: boolean; result?: { id?: number } }>(
      `${TG_API}/bot${trimmed}/getMe`,
      { timeout: 10_000 },
    )
    return data.ok === true && typeof data.result?.id === 'number'
  } catch {
    return false
  }
}

export async function probeTelegramBotApi(token?: string): Promise<TelegramHealthSnapshot> {
  const trimmed = (token ?? resolveTelegramBotToken()).trim()
  const checkedAt = new Date().toISOString()

  if (!trimmed) {
    const snapshot: TelegramHealthSnapshot = {
      checked_at: checkedAt,
      has_token: false,
      api_ok: false,
      bot_id: null,
      bot_username: null,
      error: 'Токен Telegram не задан',
    }
    lastSnapshot = snapshot
    return snapshot
  }

  try {
    const { data, status } = await telegramAxios.get<{
      ok: boolean
      description?: string
      error_code?: number
      result?: { id?: number; username?: string }
    }>(`${TG_API}/bot${trimmed}/getMe`, { timeout: 15_000 })

    if (!data.ok || !data.result) {
      const description = data.description ?? `HTTP ${status}`
      const snapshot: TelegramHealthSnapshot = {
        checked_at: checkedAt,
        has_token: true,
        api_ok: false,
        bot_id: null,
        bot_username: null,
        error: description,
      }
      lastSnapshot = snapshot
      if (isTelegramUnauthorizedError(description) || data.error_code === 401) {
        void reportTelegramUnauthorized({ method: 'getMe', description })
      } else {
        void sendAdminAlert(
          'tg_api_down',
          'Telegram Bot API недоступен — перенос постов и комментариев остановлен',
          { error: description },
        )
      }
      return snapshot
    }

    const snapshot: TelegramHealthSnapshot = {
      checked_at: checkedAt,
      has_token: true,
      api_ok: true,
      bot_id: typeof data.result.id === 'number' ? data.result.id : null,
      bot_username: data.result.username?.trim() || null,
      error: null,
    }
    lastSnapshot = snapshot
    return snapshot
  } catch (err: unknown) {
    const errorText = extractAxiosErrorText(err)
    const snapshot: TelegramHealthSnapshot = {
      checked_at: checkedAt,
      has_token: true,
      api_ok: false,
      bot_id: null,
      bot_username: null,
      error: errorText,
    }
    lastSnapshot = snapshot
    if (isTelegramUnauthorizedError(errorText)) {
      void reportTelegramUnauthorized({ method: 'getMe', description: errorText })
    } else {
      void sendAdminAlert(
        'tg_api_down',
        'Telegram Bot API недоступен — перенос постов и комментариев остановлен',
        { error: errorText },
      )
    }
    return snapshot
  }
}

export function getTelegramHealthSnapshot(): TelegramHealthSnapshot {
  return { ...lastSnapshot }
}

export async function assertTelegramBotApiOnStartup(): Promise<void> {
  const sources = describeTelegramTokenSources()
  if (sources.mismatch_warning) {
    logger.warn(`[telegramHealth] ${sources.mismatch_warning}`, {
      active_source: sources.active_source,
      active_token_preview: sources.active_token_preview,
      env_token_preview: sources.env_token_preview,
      integrations_token_preview: sources.integrations_token_preview,
    })
  }

  const token = resolveTelegramBotToken()
  if (!token) {
    logger.warn(
      '[telegramHealth] TG_TOKEN не задан — синхронизация с Telegram отключена до подключения интеграции',
    )
    void sendAdminAlert(
      'tg_token_missing',
      'Токен Telegram не задан — перенос постов и комментариев из Telegram остановлен',
    )
    return
  }

  const snapshot = await probeTelegramBotApi(token)
  if (snapshot.api_ok) {
    logger.info('[telegramHealth] Telegram Bot API авторизован', {
      bot_id: snapshot.bot_id,
      bot_username: snapshot.bot_username,
      active_source: sources.active_source,
      active_token_preview: sources.active_token_preview,
    })
    return
  }

  logger.error('[telegramHealth] Telegram Bot API недоступен — проверьте токен в интеграциях', {
    error: snapshot.error,
    active_source: sources.active_source,
    active_token_preview: sources.active_token_preview,
    env_token_preview: sources.env_token_preview,
    integrations_token_preview: sources.integrations_token_preview,
    reader_token_preview: sources.reader_token_preview,
  })
  void sendAdminAlert(
    'tg_api_down',
    'Telegram Bot API недоступен — перенос постов и комментариев остановлен',
    { error: snapshot.error, active_source: sources.active_source },
  )
}

export function startTelegramHealthMonitor(): void {
  if (monitorTimer) {
    return
  }
  const intervalMs = getMonitorIntervalMs()
  monitorTimer = setInterval(() => {
    void probeTelegramBotApi().catch((err: unknown) => {
      logger.warn('[telegramHealth] periodic probe failed', err)
    })
  }, intervalMs)
  monitorTimer.unref?.()
  logger.info('[telegramHealth] мониторинг Telegram API запущен', { intervalMs })
}

export function stopTelegramHealthMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer)
    monitorTimer = null
  }
}
