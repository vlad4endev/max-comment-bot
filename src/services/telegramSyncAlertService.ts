/**
 * Троттлированные уведомления оператору о критических ошибках синхронизации Telegram.
 */

import type { Bot } from '@maxhub/max-bot-api'

import { logger } from '../utils/logger'
import { sendAdminAlert, setAdminAlertBot } from '../utils/alertService'

type AlertKind = 'flood_wait' | 'forbidden' | 'unauthorized'

const ALERT_COOLDOWN_MS = 15 * 60 * 1_000
const lastAlertAt = new Map<string, number>()

/** @deprecated use setAdminAlertBot — оставлен для совместимости вызова из index. */
export function setTelegramSyncAlertBot(bot: Bot): void {
  setAdminAlertBot(bot)
}

function alertKey(kind: AlertKind, chatId?: number | string): string {
  return `${kind}:${chatId ?? 'global'}`
}

function shouldNotify(kind: AlertKind, chatId?: number | string): boolean {
  const key = alertKey(kind, chatId)
  const now = Date.now()
  const last = lastAlertAt.get(key) ?? 0
  if (now - last < ALERT_COOLDOWN_MS) {
    return false
  }
  lastAlertAt.set(key, now)
  return true
}

export async function reportTelegramFloodWait(input: {
  method: string
  chatId?: number | string
  waitSeconds: number
  description: string
}): Promise<void> {
  logger.warn('[telegramSyncAlert] FLOOD_WAIT', input)
  if (!shouldNotify('flood_wait', input.chatId)) {
    return
  }
  const chatPart =
    input.chatId != null ? `\nЧат: ${String(input.chatId)}` : ''
  const text =
    `Telegram FLOOD_WAIT (${input.waitSeconds} с) — синхронизация комментариев приостановлена\n` +
    `Метод: ${input.method}${chatPart}\n` +
    `${input.description}`
  await sendAdminAlert(alertKey('flood_wait', input.chatId), text, {
    method: input.method,
    chatId: input.chatId,
    waitSeconds: input.waitSeconds,
  })
}

export async function reportTelegramForbidden(input: {
  method: string
  chatId?: number | string
  description: string
}): Promise<void> {
  logger.warn('[telegramSyncAlert] forbidden', input)
  if (!shouldNotify('forbidden', input.chatId)) {
    return
  }
  const chatPart =
    input.chatId != null ? `\nЧат: ${String(input.chatId)}` : ''
  const text =
    `Telegram 403 Forbidden — перенос постов/комментариев заблокирован\n` +
    `Метод: ${input.method}${chatPart}\n` +
    `${input.description}\n` +
    `Проверьте: бот в канале и группе обсуждений, права администратора, токен.`
  await sendAdminAlert(alertKey('forbidden', input.chatId), text, {
    method: input.method,
    chatId: input.chatId,
  })
}

export async function reportTelegramUnauthorized(input: {
  method: string
  description: string
}): Promise<void> {
  logger.error('[telegramSyncAlert] unauthorized', input)
  if (!shouldNotify('unauthorized')) {
    return
  }
  const text =
    `Telegram 401 Unauthorized — перенос постов и комментариев остановлен\n` +
    `Метод: ${input.method}\n` +
    `${input.description}\n` +
    `Проверьте токен в интеграциях (TG_TOKEN) и статус бота в @BotFather.`
  await sendAdminAlert(alertKey('unauthorized'), text, {
    method: input.method,
  })
}
