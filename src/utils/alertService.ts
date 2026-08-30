import { config, getTelegramToken } from '../config'
import { logger } from './logger'
import { telegramAxios } from './telegramAxios'

const ALERT_COOLDOWN_MS = 10 * 60 * 1000
const lastAlerts = new Map<string, number>()

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

  const text = [
    '⚠️ МаксКоммент: ' + message,
    details ? '```\n' + JSON.stringify(details, null, 2).slice(0, 500) + '\n```' : '',
  ]
    .filter(Boolean)
    .join('\n')

  try {
    const adminId = config.ADMIN_CHAT_ID
    const tgBotToken = getTelegramToken()
    if (!adminId || !tgBotToken) {
      return
    }

    await telegramAxios.post(
      `https://api.telegram.org/bot${tgBotToken}/sendMessage`,
      {
        chat_id: adminId,
        text,
        parse_mode: 'Markdown',
      },
      { timeout: 10_000 },
    )
  } catch (err: unknown) {
    logger.warn('[alertService] failed to send alert', { code, err })
  }
}
