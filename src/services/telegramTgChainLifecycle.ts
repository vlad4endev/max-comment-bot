import type { Bot } from '@maxhub/max-bot-api'

import {
  ensureAdminPanelStateLoaded,
  listTgChainsSync,
  updateTgChain,
  type TgChainRecord,
} from '../api/adminPanelState'
import { notifyAllAdmins } from './notificationService'
import { logger } from '../utils/logger'

let maxBotRef: Bot | null = null

export function setTelegramTgChainLifecycleBot(bot: Bot): void {
  maxBotRef = bot
}

function formatTelegramChannelLabel(title: string | null, username: string | null): string {
  const displayTitle = title?.trim() || 'Telegram-канал'
  const uname = username?.trim()
  if (uname) {
    const handle = uname.startsWith('@') ? uname : `@${uname}`
    return `«${displayTitle}» (${handle})`
  }
  return `«${displayTitle}»`
}

function findChainsForTelegramChannel(
  tgChannelChatId: string,
  tgUsername: string | null,
): TgChainRecord[] {
  const chatId = String(tgChannelChatId).trim()
  const unameKey = (tgUsername ?? '').trim().replace(/^@/, '').toLowerCase()
  return listTgChainsSync().filter((chain) => {
    const chainId = chain.tg_channel_id?.trim()
    if (chainId && chainId === chatId) {
      return true
    }
    if (!chainId && unameKey) {
      return chain.tg_username.trim().replace(/^@/, '').toLowerCase() === unameKey
    }
    return false
  })
}

function formatMaxChannelLabel(chain: TgChainRecord): string {
  return chain.max_title?.trim() ? `«${chain.max_title.trim()}»` : `канал MAX (${chain.max_chat_id})`
}

/**
 * Бот потерял права администратора в TG-канале: приостанавливаем связки и уведомляем админов MAX.
 */
export async function pauseTgChainsForTelegramChannelLostAdmin(input: {
  tgChannelChatId: string
  tgTitle: string | null
  tgUsername: string | null
}): Promise<{ pausedChainIds: string[] }> {
  await ensureAdminPanelStateLoaded()
  const chains = findChainsForTelegramChannel(input.tgChannelChatId, input.tgUsername)
  const toPause = chains.filter((c) => c.active !== false)
  if (toPause.length === 0) {
    return { pausedChainIds: [] }
  }

  const pausedAt = new Date().toISOString()
  const pausedChainIds: string[] = []
  for (const chain of toPause) {
    await updateTgChain(chain.id, { active: false, auto_paused_at: pausedAt })
    pausedChainIds.push(chain.id)
    logger.info('telegramTgChainLifecycle: chain auto-paused', {
      chainId: chain.id,
      tgChannelChatId: input.tgChannelChatId,
      maxChatId: chain.max_chat_id,
    })
  }

  const bot = maxBotRef
  if (!bot) {
    logger.warn('telegramTgChainLifecycle: MAX bot not set, skip lost-admin notify')
    return { pausedChainIds }
  }

  const tgLabel = formatTelegramChannelLabel(input.tgTitle, input.tgUsername)
  const notifiedMax = new Set<number>()
  for (const chain of toPause) {
    if (notifiedMax.has(chain.max_chat_id)) {
      continue
    }
    notifiedMax.add(chain.max_chat_id)
    const maxLabel = formatMaxChannelLabel(chain)
    const text =
      `⚠️ Связка с Telegram прервана\n\n` +
      `Канал в Telegram: ${tgLabel}\n` +
      `Связка с MAX ${maxLabel} приостановлена: бот потерял права администратора в Telegram-канале. ` +
      `Пересылка постов из Telegram в MAX временно остановлена.\n\n` +
      `Чтобы восстановить: снова назначьте @commentvmax_bot администратором в Telegram-канале ` +
      `и нажмите «Подтвердить подключение» в личке с ботом.`
    try {
      await notifyAllAdmins(bot, chain.max_chat_id, text)
    } catch (err: unknown) {
      logger.warn('telegramTgChainLifecycle: notify MAX lost link failed', {
        maxChatId: chain.max_chat_id,
        chainId: chain.id,
        err,
      })
    }
  }

  return { pausedChainIds }
}

/**
 * Права администратора в TG восстановлены: возобновляем автоприостановленные связки и уведомляем MAX.
 */
export async function restoreTgChainsForTelegramChannelAdminRestored(input: {
  tgChannelChatId: string
  tgTitle: string | null
  tgUsername: string | null
}): Promise<{ restoredChainIds: string[] }> {
  await ensureAdminPanelStateLoaded()
  const chains = findChainsForTelegramChannel(input.tgChannelChatId, input.tgUsername)
  const toRestore = chains.filter((c) => typeof c.auto_paused_at === 'string' && c.auto_paused_at.trim() !== '')
  if (toRestore.length === 0) {
    return { restoredChainIds: [] }
  }

  const restoredChainIds: string[] = []
  for (const chain of toRestore) {
    await updateTgChain(chain.id, { active: true, auto_paused_at: null })
    restoredChainIds.push(chain.id)
    logger.info('telegramTgChainLifecycle: chain auto-restored', {
      chainId: chain.id,
      tgChannelChatId: input.tgChannelChatId,
      maxChatId: chain.max_chat_id,
    })
  }

  const bot = maxBotRef
  if (!bot) {
    logger.warn('telegramTgChainLifecycle: MAX bot not set, skip restored notify')
    return { restoredChainIds }
  }

  const tgLabel = formatTelegramChannelLabel(input.tgTitle, input.tgUsername)
  const notifiedMax = new Set<number>()
  for (const chain of toRestore) {
    if (notifiedMax.has(chain.max_chat_id)) {
      continue
    }
    notifiedMax.add(chain.max_chat_id)
    const maxLabel = formatMaxChannelLabel(chain)
    const text =
      `✅ Связка с Telegram восстановлена\n\n` +
      `Канал в Telegram: ${tgLabel}\n` +
      `Связка с MAX ${maxLabel} снова активна — пересылка постов из Telegram возобновлена.`
    try {
      await notifyAllAdmins(bot, chain.max_chat_id, text)
    } catch (err: unknown) {
      logger.warn('telegramTgChainLifecycle: notify MAX restored link failed', {
        maxChatId: chain.max_chat_id,
        chainId: chain.id,
        err,
      })
    }
  }

  return { restoredChainIds }
}
