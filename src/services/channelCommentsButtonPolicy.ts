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
 * Whether the bot may attach the «Комментарии» Mini App button for this MAX channel.
 *
 * - Channel is **not** a TG chain destination → enabled (native MAX / registry only).
 * - Channel is a chain destination → follows `add_comments_button` on **every** active chain row.
 * - `/addbutton` (`source: manual`) bypasses this check in {@link tryAttachCommentsToChannelPost}.
 */
export function isCommentsButtonEnabledForMaxChannel(chatId: number): boolean {
  const chains = listTgChainsForMaxChannel(chatId)
  if (chains.length === 0) {
    return true
  }
  return chains.every((c) => c.add_comments_button !== false)
}
