import type { TgChainRecord } from '../api/adminPanelState'

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

/** Все ключи TG-канала из связки (id, @username) для сопоставления с channel_post. */
export function collectTgChainChannelMatchKeys(chain: TgChainRecord): string[] {
  const keys = new Set<string>()
  const id = chain.tg_channel_id?.trim() ?? ''
  if (id) {
    keys.add(id)
  }
  const uname = chain.tg_username?.trim().replace(/^@/, '') ?? ''
  if (uname) {
    keys.add(`@${uname}`)
    keys.add(uname)
  }
  return [...keys]
}

export function telegramMessageMatchesTgChain(chat: TgChatRef, chain: TgChainRecord): boolean {
  const keys = collectTgChainChannelMatchKeys(chain)
  if (keys.length === 0) {
    return false
  }
  return keys.some((key) => telegramChannelMatchesTarget(chat, key))
}
