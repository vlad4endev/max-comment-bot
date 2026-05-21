import type { Bot } from '@maxhub/max-bot-api'

import {
  createTgChain,
  ensureAdminPanelStateLoaded,
  listTgChains,
  type TgChainRecord,
} from '../api/adminPanelState'
import { channelRegistry } from './channelRegistry'
import { channelLinkDraftStore } from './channelLinkDraftStore'
import { isUserChannelAdmin } from './channelPostActions'
import { listTelegramChatAdministrators } from './integrationPlatformClient'
import { ownerProfileStore, type OwnerAccountInput } from './ownerProfileStore'
import { stateManager } from './stateManager'
import { listTelegramMiniappChannelsForUser } from './telegramMiniappService'
import { telegramChannelRegistry } from './telegramChannelRegistry'

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

function findActiveChainConflict(
  chains: TgChainRecord[],
  maxChatId: number,
  tgChannelId: string,
  tgUsername: string,
): TgChainRecord | null {
  const tgKey = tgChannelId.trim()
  const uname = tgUsername.trim().replace(/^@/, '').toLowerCase()
  return (
    chains.find(
      (c) =>
        c.active &&
        (c.max_chat_id === maxChatId ||
          (tgKey && c.tg_channel_id === tgKey) ||
          (!tgKey && uname && c.tg_username.toLowerCase() === uname)),
    ) ?? null
  )
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

  const chains = await listTgChains()
  const existing = chains.find((c) => c.active && c.max_chat_id === input.maxChatId)
  if (existing) {
    throw new Error('max channel already linked')
  }

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
  expires_at: string
  status: string
} | null {
  const draft = channelLinkDraftStore.getByCode(code)
  if (!draft) {
    return null
  }
  if (draft.status !== 'pending') {
    return { max_title: draft.max_title, expires_at: draft.expires_at, status: draft.status }
  }
  const expiresMs = Date.parse(draft.expires_at)
  if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
    return { max_title: draft.max_title, expires_at: draft.expires_at, status: 'expired' }
  }
  return { max_title: draft.max_title, expires_at: draft.expires_at, status: 'pending' }
}

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
): Promise<{ chain: ChannelLinkWire; profile_id: string }> {
  await ensureAdminPanelStateLoaded()
  const normalizedCode = String(input.code).trim().toUpperCase()
  const draft = channelLinkDraftStore.getByCode(normalizedCode)
  if (!draft) {
    throw new Error('invalid code')
  }
  if (draft.status !== 'pending') {
    throw new Error('code not available')
  }
  const expiresMs = Date.parse(draft.expires_at)
  if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
    throw new Error('code expired')
  }

  const chatId = String(input.tgChannelId).trim()
  if (!/^-?\d+$/.test(chatId)) {
    throw new Error('invalid tg channel')
  }

  const { tgUsername } = await assertTelegramChannelReady(tgToken, chatId, input.tgUserId)

  const chains = await listTgChains()
  const conflict = findActiveChainConflict(chains, draft.max_chat_id, chatId, tgUsername)
  if (conflict) {
    throw new Error('pair already linked')
  }

  ownerProfileStore.attachAccountToProfile(draft.profile_id, input.account)

  const chain = await createTgChain({
    max_chat_id: draft.max_chat_id,
    max_title: draft.max_title,
    tg_username: tgUsername,
    tg_channel_id: chatId,
    bot_token: '',
    forward_posts: input.forwardPosts !== false,
    forward_comments: false,
    add_comments_button: input.addCommentsButton !== false,
    add_signature: false,
    active: true,
    owner_profile_id: draft.profile_id,
    created_via: 'miniapp_link',
    max_user_id: draft.max_user_id,
    tg_user_id: input.tgUserId,
  })

  channelLinkDraftStore.markCompleted(normalizedCode, {
    tgChannelId: chatId,
    tgUsername,
    tgUserId: input.tgUserId,
    chainId: chain.id,
  })

  return { chain: chainToWire(chain), profile_id: draft.profile_id }
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
