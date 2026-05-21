import { listTgChainsSync, type TgChainRecord } from '../api/adminPanelState'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'

function maxChannelAbs(chatId: number): number {
  const canonical = resolveCanonicalChannelChatId(chatId) ?? chatId
  return Math.abs(canonical)
}

/** Active TG→MAX chains that target this MAX channel. */
export function listTgChainsForMaxChannel(chatId: number): TgChainRecord[] {
  const abs = maxChannelAbs(chatId)
  return listTgChainsSync().filter((c) => c.active !== false && Math.abs(c.max_chat_id) === abs)
}

/**
 * Whether TG→MAX **forward** may attach the «Комментарии» button (`source: tg_chain` only).
 *
 * Native MAX posts (webhook/poller/refresh) ignore this — they use the default attach flow even if
 * the same `max_chat_id` is also a chain destination with the toggle off.
 */
export function isCommentsButtonEnabledForTgChainForward(chatId: number): boolean {
  const chains = listTgChainsForMaxChannel(chatId)
  if (chains.length === 0) {
    return true
  }
  return chains.every((c) => c.add_comments_button !== false)
}
