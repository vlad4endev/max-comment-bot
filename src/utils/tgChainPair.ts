import type { TgChainRecord } from '../api/adminPanelState'

/** Та же пара MAX + TG, что и при создании цепочки в админ-панели. */
export function tgChainMatchesPair(
  chain: TgChainRecord,
  maxChatId: number,
  tgChannelId: string | undefined,
  tgUsername: string,
): boolean {
  if (chain.active === false) {
    return false
  }
  if (chain.max_chat_id !== maxChatId) {
    return false
  }
  const tgKey = (tgChannelId ?? '').trim()
  if (tgKey) {
    return (chain.tg_channel_id ?? '').trim() === tgKey
  }
  const uname = tgUsername.trim().replace(/^@/, '').toLowerCase()
  return chain.tg_username.trim().replace(/^@/, '').toLowerCase() === uname
}

export function findActiveTgChainForPair(
  chains: TgChainRecord[],
  maxChatId: number,
  tgChannelId: string,
  tgUsername: string,
): TgChainRecord | null {
  return (
    chains.find((c) => tgChainMatchesPair(c, maxChatId, tgChannelId, tgUsername)) ?? null
  )
}
