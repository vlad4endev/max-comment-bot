export interface TgChatRef {
  id: number
  username?: string
}

/**
 * Строгое сопоставление апдейта с выбранным TG-каналом (@username или -100… id).
 */
export function telegramChannelMatchesTarget(
  chat: TgChatRef,
  channelKey: string,
): boolean {
  const raw = channelKey.trim()
  if (!raw) return false

  const targetId = raw.replace(/^@/, '')
  const chatKey =
    typeof chat.username === 'string' && chat.username.trim() !== ''
      ? chat.username.trim().toLowerCase()
      : String(chat.id)

  if (targetId.startsWith('-') || /^\d+$/.test(targetId)) {
    return String(chat.id) === targetId
  }

  return chatKey === targetId.toLowerCase()
}

export function normalizeTelegramChannelKey(raw: string): string {
  const t = raw.trim()
  if (!t) return t
  if (/^-?\d+$/.test(t)) return t
  return t.startsWith('@') ? t : `@${t}`
}
