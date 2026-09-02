import type { Bot } from '@maxhub/max-bot-api'

import { config, getTelegramToken } from '../config'
import { logger } from './logger'
import { telegramAxios } from './telegramAxios'

/** Оператор, которому шлём алерты о сбоях переноса постов и комментариев. */
export const OPERATOR_ALERT_USER_ID = 86517651

const ALERT_COOLDOWN_MS = 10 * 60 * 1000
const lastAlerts = new Map<string, number>()

let maxBotRef: Bot | null = null

export function setAdminAlertBot(bot: Bot): void {
  maxBotRef = bot
}

function operatorRecipientIds(): number[] {
  const ids = new Set<number>([OPERATOR_ALERT_USER_ID])
  if (Number.isInteger(config.ADMIN_CHAT_ID) && config.ADMIN_CHAT_ID !== 0) {
    ids.add(config.ADMIN_CHAT_ID)
  }
  return [...ids]
}

function formatAlertText(message: string, details?: Record<string, unknown>): string {
  const parts = [`🚨 МаксКоммент: ${message}`]
  if (details && Object.keys(details).length > 0) {
    parts.push(JSON.stringify(details, null, 2).slice(0, 500))
  }
  return parts.join('\n')
}

async function sendViaMax(userId: number, text: string): Promise<boolean> {
  const bot = maxBotRef
  if (!bot) {
    return false
  }
  try {
    try {
      await bot.api.sendMessageToUser(userId, text)
      return true
    } catch {
      await bot.api.sendMessageToChat(userId, text)
      return true
    }
  } catch (err: unknown) {
    logger.warn('[alertService] MAX deliver failed', { userId, err })
    return false
  }
}

async function sendViaTelegram(userId: number, text: string): Promise<boolean> {
  const tgBotToken = getTelegramToken()
  if (!tgBotToken) {
    return false
  }
  try {
    await telegramAxios.post(
      `https://api.telegram.org/bot${tgBotToken}/sendMessage`,
      { chat_id: userId, text },
      { timeout: 10_000 },
    )
    return true
  } catch (err: unknown) {
    logger.warn('[alertService] Telegram deliver failed', { userId, err })
    return false
  }
}

async function deliverToRecipient(userId: number, text: string): Promise<boolean> {
  if (await sendViaMax(userId, text)) {
    return true
  }
  return sendViaTelegram(userId, text)
}

export async function sendAdminAlert(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const now = Date.now()
  const lastSent = lastAlerts.get(code) ?? 0
  if (now - lastSent < ALERT_COOLDOWN_MS) {
    return
  }
  lastAlerts.set(code, now)

  const text = formatAlertText(message, details)
  const recipients = operatorRecipientIds()
  let delivered = false

  for (const userId of recipients) {
    if (await deliverToRecipient(userId, text)) {
      delivered = true
    }
  }

  if (!delivered) {
    logger.warn('[alertService] alert not delivered to any recipient', {
      code,
      recipients,
      hasMaxBot: maxBotRef != null,
      hasTgToken: Boolean(getTelegramToken()),
    })
  }
}
