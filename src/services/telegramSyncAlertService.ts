/**
 * Троттлированные уведомления оператору о критических ошибках синхронизации Telegram.
 */

import type { Bot } from '@maxhub/max-bot-api'

import { config } from '../config'
import { logger } from '../utils/logger'

type AlertKind = 'flood_wait' | 'forbidden' | 'unauthorized'

const ALERT_COOLDOWN_MS = 15 * 60 * 1_000
const lastAlertAt = new Map<string, number>()

let botRef: Bot | null = null

export function setTelegramSyncAlertBot(bot: Bot): void {
  botRef = bot
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

async function deliverOperatorAlert(text: string): Promise<void> {
  const bot = botRef
  if (!bot) {
    logger.warn('[telegramSyncAlert] bot not set, alert skipped', { text: text.slice(0, 120) })
    return
  }
  try {
    await bot.api.sendMessageToChat(config.ADMIN_CHAT_ID, text)
  } catch (err: unknown) {
    logger.warn('[telegramSyncAlert] failed to notify operator', { err })
  }
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
    `⚠️ Telegram FLOOD_WAIT (${input.waitSeconds} с)\n` +
    `Метод: ${input.method}${chatPart}\n` +
    `${input.description}\n\n` +
    `Синхронизация комментариев приостановлена. ` +
    `Если FLOOD_WAIT повторяется, увеличьте TELEGRAM_API_MIN_INTERVAL_MS (сейчас по умолчанию 350).`
  await deliverOperatorAlert(text)
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
    `🚫 Telegram 403 Forbidden\n` +
    `Метод: ${input.method}${chatPart}\n` +
    `${input.description}\n\n` +
    `Проверьте: бот в канале и группе обсуждений, права администратора, токен.`
  await deliverOperatorAlert(text)
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
    `🔴 Telegram 401 Unauthorized\n` +
    `Метод: ${input.method}\n` +
    `${input.description}\n\n` +
    `Проверьте токен в интеграциях (TG_TOKEN) и статус бота в @BotFather. ` +
    `После обновления токена перезапустите сервис.`
  await deliverOperatorAlert(text)
}
