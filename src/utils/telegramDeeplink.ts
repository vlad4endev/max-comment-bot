/** Telegram bot deep link: `?start=jointg{chatId without minus}`. */
export function buildTelegramBotJoinUrl(telegramChatId: string, botUsername = 'commentvmax_bot'): string {
  const nick = botUsername.replace(/^@/, '').trim()
  const id = String(telegramChatId).trim().replace(/^-/, '')
  if (!/^\d+$/.test(id)) {
    throw new Error('buildTelegramBotJoinUrl: invalid telegram chat id')
  }
  return `https://t.me/${nick}?start=jointg${id}`
}

/** Parses `jointg1001234567890` → `-1001234567890`. */
export function resolveTelegramChatIdFromJoinPayload(raw: string): string | null {
  const trimmed = String(raw || '').trim()
  const m = /^jointg(\d+)$/i.exec(trimmed)
  if (!m) {
    return null
  }
  return `-${m[1]}`
}

export function isTelegramJoinStartPayload(raw: string): boolean {
  return /^jointg\d+$/i.test(String(raw || '').trim())
}

/** Inline callback: подтвердить подключение TG-канала (аналог MAX `confirm_ch_`). */
export function buildTelegramConfirmChannelPayload(telegramChatId: string): string {
  const digits = String(telegramChatId).trim().replace(/^-/, '')
  if (!/^\d+$/.test(digits)) {
    throw new Error('buildTelegramConfirmChannelPayload: invalid telegram chat id')
  }
  return `confirm_tg_ch_${digits}`
}

export function parseTelegramConfirmChannelPayload(raw: string): string | null {
  const m = /^confirm_tg_ch_(\d+)$/i.exec(String(raw || '').trim())
  if (!m) {
    return null
  }
  return `-${m[1]}`
}

export function chatIdToConnectArg(telegramChatId: string): string {
  return String(telegramChatId).trim().replace(/^-/, '')
}

export function parseTelegramConnectCommand(
  text: string,
): false | { mode: 'all' } | { mode: 'one'; channelChatId: string } | undefined {
  const t = text.trim()
  if (!/^\/connect\b/i.test(t)) {
    return false
  }
  const rest = t.replace(/^\/connect\b/i, '').trim()
  if (rest === '') {
    return { mode: 'all' }
  }
  const normalized = rest.startsWith('-') ? rest : `-${rest.replace(/\D/g, '')}`
  if (!/^-\d+$/.test(normalized)) {
    return undefined
  }
  return { mode: 'one', channelChatId: normalized }
}
