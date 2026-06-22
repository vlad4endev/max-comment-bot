import type { Bot } from '@maxhub/max-bot-api'
import { Keyboard } from '@maxhub/max-bot-api'

import {
  createTgChain,
  ensureAdminPanelStateLoaded,
  listTgChains,
  updateTgChain,
  type TgChainRecord,
} from '../api/adminPanelState'
import { buildConfirmChannelLinkPayload } from '../utils/channelLinkCallback'
import { findActiveTgChainForPair } from '../utils/tgChainPair'
import { channelRegistry } from './channelRegistry'
import { channelLinkDraftStore } from './channelLinkDraftStore'
import { isUserChannelAdmin } from './channelPostActions'
import {
  ensureTelegramPollingMode,
  listTelegramChatAdministrators,
} from './integrationPlatformClient'
import { ownerProfileStore, type OwnerAccountInput } from './ownerProfileStore'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import { stateManager } from './stateManager'
import {
  listTelegramMiniappChannelsForUser,
  notifyChannelLinkSucceededPrivate,
} from './telegramMiniappService'
import { telegramBotUserStore } from './telegramBotUserStore'
import { telegramChannelRegistry } from './telegramChannelRegistry'
import { logger } from '../utils/logger'

export interface ChannelLinkWire {
  id: string
  tg_title: string
  tg_username: string
  tg_channel_id: string | null
  max_chat_id: number
  max_title: string | null
  active: boolean
  forward_posts: boolean
  add_comments_button: boolean
  forwarded_today: number
  created_at: string
}

function chainToWire(chain: TgChainRecord): ChannelLinkWire {
  const tgTitle =
    chain.tg_channel_id != null
      ? (telegramChannelRegistry.getChannel(chain.tg_channel_id)?.title ??
        chain.tg_username)
      : chain.tg_username
  return {
    id: chain.id,
    tg_title: tgTitle || 'Telegram',
    tg_username: chain.tg_username,
    tg_channel_id: chain.tg_channel_id ?? null,
    max_chat_id: chain.max_chat_id,
    max_title: chain.max_title,
    active: chain.active,
    forward_posts: chain.forward_posts,
    add_comments_button: chain.add_comments_button !== false,
    forwarded_today: chain.forwarded_today,
    created_at: chain.created_at,
  }
}

function assertDraftNotExpired(draft: { expires_at: string }): void {
  const expiresMs = Date.parse(draft.expires_at)
  if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
    throw new Error('code expired')
  }
}

async function assertMaxChannelReady(bot: Bot, maxChatId: number, maxUserId: number): Promise<void> {
  const reg = channelRegistry.getChannel(maxChatId)
  if (!reg) {
    throw new Error('max channel not connected')
  }
  if (stateManager.isChannelPendingAdminRights(maxChatId)) {
    throw new Error('max channel pending admin rights')
  }
  if (!(await isUserChannelAdmin(bot, maxChatId, maxUserId))) {
    throw new Error('forbidden')
  }
}

async function assertTelegramChannelReady(
  tgToken: string,
  tgChannelId: string,
  tgUserId: number,
): Promise<{ tgUsername: string; tgTitle: string | null }> {
  const reg = telegramChannelRegistry.getChannel(tgChannelId)
  if (!reg) {
    throw new Error('telegram channel not connected')
  }
  if (!reg.bot_is_admin) {
    throw new Error('telegram bot is not admin')
  }
  const admins = await listTelegramChatAdministrators(tgToken, tgChannelId)
  if (!admins.some((a) => a.userId === tgUserId)) {
    throw new Error('forbidden')
  }
  const username =
    typeof reg.username === 'string' && reg.username.trim() !== ''
      ? reg.username.replace(/^@/, '')
      : tgChannelId
  return { tgUsername: username, tgTitle: reg.title }
}

async function sendMaxLinkConfirmRequest(
  bot: Bot | undefined,
  draft: {
    code: string
    max_user_id: number
    max_title: string | null
    tg_channel_id: string | null
  },
  tgTitle: string,
  tgUsername: string,
): Promise<void> {
  if (!bot) {
    return
  }
  const maxLabel = (draft.max_title && draft.max_title.trim()) || 'MAX-канал'
  const tgLabel = (tgTitle && tgTitle.trim()) || 'Telegram-канал'
  const tgHandle = tgUsername ? `@${tgUsername.replace(/^@/, '')}` : ''
  const text =
    `📱 Запрос на связку с Telegram\n\n` +
    `Для MAX-канала «${maxLabel}» указан код ${draft.code}.\n\n` +
    `Telegram: «${tgLabel}»${tgHandle ? ` (${tgHandle})` : ''}\n\n` +
    `Если это вы — нажмите «Подтвердить связку». Посты из Telegram начнут пересылаться в MAX.`
  const keyboard = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✅ Подтвердить связку', buildConfirmChannelLinkPayload(draft.code))],
  ])
  try {
    await bot.api.sendMessageToUser(draft.max_user_id, text, { attachments: [keyboard] })
    logger.info('sendMaxLinkConfirmRequest: sent', {
      maxUserId: draft.max_user_id,
      code: draft.code,
    })
  } catch (err: unknown) {
    logger.warn('sendMaxLinkConfirmRequest: send failed', {
      maxUserId: draft.max_user_id,
      code: draft.code,
      err,
    })
  }
}

async function finalizeDraftToChain(
  draft: {
    code: string
    profile_id: string
    max_chat_id: number
    max_title: string | null
    max_user_id: number
    tg_channel_id: string | null
    tg_username: string | null
    tg_user_id: number | null
    forward_posts: boolean
    add_comments_button: boolean
  },
  tgChannelId: string,
  tgUsername: string,
  tgUserId: number,
): Promise<TgChainRecord> {
  const tgToken = resolveTelegramBotToken()
  const normalizedUsername = tgUsername.trim().replace(/^@/, '')
  const chain = await createTgChain({
    max_chat_id: draft.max_chat_id,
    max_title: draft.max_title,
    tg_username: normalizedUsername,
    tg_channel_id: tgChannelId,
    bot_token: tgToken,
    forward_posts: draft.forward_posts !== false,
    forward_comments: true,
    add_comments_button: draft.add_comments_button !== false,
    add_signature: false,
    active: true,
    owner_profile_id: draft.profile_id,
    created_via: 'miniapp_link',
    max_user_id: draft.max_user_id,
    tg_user_id: tgUserId,
  })

  if (tgToken) {
    await ensureTelegramPollingMode(tgToken)
  }

  channelLinkDraftStore.markCompleted(draft.code, {
    tgChannelId,
    tgUsername,
    tgUserId,
    chainId: chain.id,
  })

  return chain
}

export async function syncOwnerProfileFromMiniapp(
  platform: 'max' | 'telegram',
  account: OwnerAccountInput,
): Promise<{ profile_id: string }> {
  const profileId = ownerProfileStore.syncAccount(account)
  return { profile_id: profileId }
}

export async function createChannelLinkDraft(
  bot: Bot,
  input: {
    maxUserId: number
    maxChatId: number
    account: OwnerAccountInput
  },
): Promise<{
  code: string
  expires_at: string
  max_title: string | null
  profile_id: string
}> {
  await ensureAdminPanelStateLoaded()
  await assertMaxChannelReady(bot, input.maxChatId, input.maxUserId)

  const reg = channelRegistry.getChannel(input.maxChatId)
  const profileId = ownerProfileStore.syncAccount(input.account)
  const draft = channelLinkDraftStore.createDraft({
    profileId,
    maxChatId: input.maxChatId,
    maxUserId: input.maxUserId,
    maxTitle: reg?.title ?? null,
  })

  return {
    code: draft.code,
    expires_at: draft.expires_at,
    max_title: draft.max_title,
    profile_id: profileId,
  }
}

export function getChannelLinkDraftPreview(code: string): {
  max_title: string | null
  tg_title: string | null
  expires_at: string
  status: string
} | null {
  const draft = channelLinkDraftStore.getByCode(code)
  if (!draft) {
    return null
  }
  const expiresMs = Date.parse(draft.expires_at)
  if (Number.isFinite(expiresMs) && expiresMs < Date.now() && draft.status !== 'completed') {
    return {
      max_title: draft.max_title,
      tg_title: null,
      expires_at: draft.expires_at,
      status: 'expired',
    }
  }
  const tgTitle =
    draft.tg_channel_id != null
      ? (telegramChannelRegistry.getChannel(draft.tg_channel_id)?.title ??
        draft.tg_username)
      : null
  return {
    max_title: draft.max_title,
    tg_title: tgTitle,
    expires_at: draft.expires_at,
    status: draft.status,
  }
}

/** Шаг 1 (Telegram): указать канал и код — ждёт подтверждения в MAX. */
export async function submitChannelLinkDraftFromTelegram(
  tgToken: string,
  input: {
    code: string
    tgUserId: number
    tgChannelId: string
    account: OwnerAccountInput
    forwardPosts?: boolean
    addCommentsButton?: boolean
  },
  options?: { maxBot?: Bot },
): Promise<{
  status: 'awaiting_max_confirm'
  profile_id: string
  max_title: string | null
  tg_title: string
}> {
  await ensureAdminPanelStateLoaded()
  const normalizedCode = String(input.code).trim().toUpperCase()
  const draft = channelLinkDraftStore.getByCode(normalizedCode)
  if (!draft) {
    throw new Error('invalid code')
  }
  if (draft.status === 'awaiting_max_confirm' && draft.tg_channel_id === input.tgChannelId.trim()) {
    const tgReg = telegramChannelRegistry.getChannel(draft.tg_channel_id)
    return {
      status: 'awaiting_max_confirm',
      profile_id: draft.profile_id,
      max_title: draft.max_title,
      tg_title: tgReg?.title ?? draft.tg_username ?? 'Telegram',
    }
  }
  if (draft.status !== 'pending') {
    throw new Error('code not available')
  }
  assertDraftNotExpired(draft)

  const chatId = String(input.tgChannelId).trim()
  if (!/^-?\d+$/.test(chatId)) {
    throw new Error('invalid tg channel')
  }

  const { tgUsername, tgTitle } = await assertTelegramChannelReady(tgToken, chatId, input.tgUserId)

  const chains = await listTgChains()
  const conflict = findActiveTgChainForPair(chains, draft.max_chat_id, chatId, tgUsername)
  if (conflict) {
    throw new Error('pair already linked')
  }

  ownerProfileStore.attachAccountToProfile(draft.profile_id, input.account)
  telegramBotUserStore.markStarted({ id: input.tgUserId })

  const forwardPosts = input.forwardPosts !== false
  const addCommentsButton = input.addCommentsButton !== false

  channelLinkDraftStore.markAwaitingMaxConfirm(normalizedCode, {
    tgChannelId: chatId,
    tgUsername,
    tgUserId: input.tgUserId,
    forwardPosts,
    addCommentsButton,
  })

  await sendMaxLinkConfirmRequest(options?.maxBot, draft, tgTitle ?? tgUsername, tgUsername)

  return {
    status: 'awaiting_max_confirm',
    profile_id: draft.profile_id,
    max_title: draft.max_title,
    tg_title: tgTitle ?? tgUsername,
  }
}

/** Шаг 2 (MAX): кнопка «Подтвердить связку» — создаёт цепочку TG → MAX. */
export async function finalizeChannelLinkDraftInMax(
  bot: Bot,
  code: string,
  maxUserId: number,
): Promise<{ chain: ChannelLinkWire; profile_id: string }> {
  await ensureAdminPanelStateLoaded()
  const normalizedCode = String(code).trim().toUpperCase()
  const draft = channelLinkDraftStore.getByCode(normalizedCode)
  if (!draft) {
    throw new Error('invalid code')
  }
  if (draft.status !== 'awaiting_max_confirm') {
    throw new Error('not awaiting confirm')
  }
  assertDraftNotExpired(draft)
  if (draft.max_user_id !== maxUserId) {
    throw new Error('forbidden')
  }

  const chatId = draft.tg_channel_id?.trim() ?? ''
  const tgUsername = draft.tg_username?.trim() ?? ''
  const tgUserId = draft.tg_user_id
  if (!chatId || !tgUsername || tgUserId == null) {
    throw new Error('draft incomplete')
  }

  await assertMaxChannelReady(bot, draft.max_chat_id, maxUserId)

  const chains = await listTgChains()
  const conflict = findActiveTgChainForPair(chains, draft.max_chat_id, chatId, tgUsername)
  if (conflict) {
    throw new Error('pair already linked')
  }

  const chain = await finalizeDraftToChain(draft, chatId, tgUsername, tgUserId)

  const tgReg = telegramChannelRegistry.getChannel(chatId)
  const tgTitle = tgReg?.title ?? tgUsername

  void notifyChannelLinkSucceededPrivate({
    profileId: draft.profile_id,
    maxUserId: draft.max_user_id,
    maxTitle: draft.max_title,
    tgTitle,
    confirmedByTgUserId: tgUserId,
  }).catch((err: unknown) => {
    logger.warn('finalizeChannelLinkDraftInMax: telegram notify failed', { err, code: normalizedCode })
  })

  return { chain: chainToWire(chain), profile_id: draft.profile_id }
}

/** @deprecated Use submit + finalize; kept for route name compatibility. */
export async function confirmChannelLinkDraft(
  tgToken: string,
  input: {
    code: string
    tgUserId: number
    tgChannelId: string
    account: OwnerAccountInput
    forwardPosts?: boolean
    addCommentsButton?: boolean
  },
  options?: { maxBot?: Bot },
): Promise<{
  status: 'awaiting_max_confirm'
  profile_id: string
  max_title: string | null
  tg_title: string
}> {
  return submitChannelLinkDraftFromTelegram(tgToken, input, options)
}

export async function listChannelLinksForMaxUser(
  bot: Bot,
  maxUserId: number,
): Promise<ChannelLinkWire[]> {
  await ensureAdminPanelStateLoaded()
  const adminIds = new Set<number>()
  const registered = channelRegistry
    .getAllChannels()
    .filter((c) => c.type === 'channel')
    .map((c) => c.chat_id)
  for (const chatId of registered) {
    if (await isUserChannelAdmin(bot, chatId, maxUserId)) {
      adminIds.add(chatId)
    }
  }
  const chains = await listTgChains()
  return chains.filter((c) => adminIds.has(c.max_chat_id)).map(chainToWire)
}

export async function listChannelLinksForTelegramUser(
  tgToken: string,
  tgUserId: number,
): Promise<ChannelLinkWire[]> {
  await ensureAdminPanelStateLoaded()
  const { channels } = await listTelegramMiniappChannelsForUser(tgUserId)
  const adminTgIds = new Set(channels.map((c) => c.chat_id))
  const chains = await listTgChains()
  return chains
    .filter((c) => {
      const id = c.tg_channel_id?.trim()
      if (id && adminTgIds.has(id)) {
        return true
      }
      return false
    })
    .map(chainToWire)
}

/** Подставляет основной TG-токен в старые miniapp-цепочки с пустым bot_token. */
export async function repairLegacyMiniappTgChains(): Promise<number> {
  await ensureAdminPanelStateLoaded()
  const token = resolveTelegramBotToken()
  if (!token) {
    return 0
  }
  const chains = await listTgChains()
  let repaired = 0
  for (const chain of chains) {
    if (chain.created_via !== 'miniapp_link' || chain.bot_token?.trim()) {
      continue
    }
    await updateTgChain(chain.id, { bot_token: token })
    repaired += 1
  }
  if (repaired > 0) {
    logger.info('repairLegacyMiniappTgChains: bot_token restored', { repaired })
  }
  return repaired
}

export function getOwnerProfileBundle(profileId: string): {
  profile_id: string
  accounts: Array<{
    platform: string
    platform_user_id: string
    username: string | null
    first_name: string | null
    last_name: string | null
    photo_url: string | null
  }>
} {
  const accounts = ownerProfileStore.getAccountsForProfile(profileId)
  return {
    profile_id: profileId,
    accounts: accounts.map((a) => ({
      platform: a.platform,
      platform_user_id: a.platform_user_id,
      username: a.username,
      first_name: a.first_name,
      last_name: a.last_name,
      photo_url: a.photo_url,
    })),
  }
}
