import {
  ensureAdminPanelStateLoaded,
  listTgChains,
  updateTgChain,
  type TgChainRecord,
} from '../api/adminPanelState'
import { resolveTelegramChannelChatIdFromKey } from './integrationPlatformClient'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import { logger } from '../utils/logger'

export interface ResolvedTgChainChannelFields {
  tg_channel_id: string
  tg_username: string
}

/** Нормализует @username / -100… / t.me/… в канонический chat_id для пересылки постов. */
export async function resolveTgChainChannelFields(
  token: string,
  tgRaw: string,
): Promise<ResolvedTgChainChannelFields | null> {
  const trimmed = tgRaw.trim()
  if (!trimmed) {
    return null
  }

  const fromApi = await resolveTelegramChannelChatIdFromKey(token, trimmed)
  if (fromApi) {
    return {
      tg_channel_id: fromApi.chatId,
      tg_username: fromApi.username?.replace(/^@/, '') ?? '',
    }
  }

  const numeric = trimmed.replace(/^@/, '')
  if (/^-100\d+$/.test(numeric)) {
    return { tg_channel_id: numeric, tg_username: '' }
  }

  const asUname = trimmed.replace(/^@/, '')
  if (asUname && !/^-?\d+$/.test(asUname)) {
    return { tg_channel_id: '', tg_username: asUname }
  }

  return null
}

function chainNeedsChannelIdRepair(chain: TgChainRecord): boolean {
  const id = chain.tg_channel_id?.trim() ?? ''
  return id === '' || !/^-100\d+$/.test(id)
}

/** Починка связок из админки: tg_channel_id, пустой bot_token. */
export async function repairTgChainsForForwarding(): Promise<{
  tokenRepaired: number
  channelIdRepaired: number
}> {
  await ensureAdminPanelStateLoaded()
  const token = resolveTelegramBotToken()
  if (!token) {
    return { tokenRepaired: 0, channelIdRepaired: 0 }
  }

  const chains = await listTgChains()
  let tokenRepaired = 0
  let channelIdRepaired = 0

  for (const chain of chains) {
    const patch: Partial<TgChainRecord> = {}

    if (!chain.bot_token?.trim()) {
      patch.bot_token = token
      tokenRepaired += 1
    }

    if (chainNeedsChannelIdRepair(chain)) {
      const raw =
        chain.tg_channel_id?.trim() ||
        (chain.tg_username?.trim() ? `@${chain.tg_username.trim().replace(/^@/, '')}` : '')
      if (raw) {
        const resolved = await resolveTgChainChannelFields(token, raw)
        if (resolved?.tg_channel_id && /^-100\d+$/.test(resolved.tg_channel_id)) {
          patch.tg_channel_id = resolved.tg_channel_id
          if (resolved.tg_username) {
            patch.tg_username = resolved.tg_username
          }
          channelIdRepaired += 1
        }
      }
    }

    if (Object.keys(patch).length > 0) {
      await updateTgChain(chain.id, patch)
    }
  }

  if (tokenRepaired > 0 || channelIdRepaired > 0) {
    logger.info('repairTgChainsForForwarding: done', { tokenRepaired, channelIdRepaired })
  }

  return { tokenRepaired, channelIdRepaired }
}
