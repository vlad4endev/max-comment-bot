import type { TgChainRecord } from '../api/adminPanelState'
import type { TgMessage } from '../forwarder/telegramReader'
import { listTelegramChatAdministrators } from '../services/integrationPlatformClient'

export function normalizeCommentSyncKeywords(words: string[] | undefined): string[] {
  return (words ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean)
}

export function matchesCommentSyncKeyword(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) {
    return false
  }
  const hay = text.toLowerCase()
  return keywords.some((kw) => hay.includes(kw))
}

const adminUserCache = new Map<string, { userIds: Set<number>; expiresAt: number }>()
const ADMIN_CACHE_TTL_MS = 5 * 60_000

async function getTelegramAdminUserIds(token: string, chatId: string): Promise<Set<number>> {
  const key = `${chatId}:${token.slice(-8)}`
  const cached = adminUserCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.userIds
  }
  const admins = await listTelegramChatAdministrators(token, chatId)
  const userIds = new Set(admins.map((a) => a.userId))
  adminUserCache.set(key, { userIds, expiresAt: Date.now() + ADMIN_CACHE_TTL_MS })
  return userIds
}

function channelChatNumericId(chain: TgChainRecord): number | null {
  const raw = chain.tg_channel_id?.trim()
  if (!raw || !/^-?\d+$/.test(raw)) {
    return null
  }
  return Number(raw)
}

function isChannelSignedComment(message: TgMessage, chain: TgChainRecord): boolean {
  const channelId = channelChatNumericId(chain)
  if (channelId == null) {
    return false
  }
  return message.sender_chat?.id === channelId
}

export async function isTgCommentFromAdmin(
  message: TgMessage,
  token: string,
  chain: TgChainRecord,
  discussionChatId: number,
): Promise<boolean> {
  if (isChannelSignedComment(message, chain)) {
    return true
  }
  const userId = message.from?.id
  if (typeof userId !== 'number' || userId <= 0) {
    return false
  }
  const discussionAdmins = await getTelegramAdminUserIds(token, String(discussionChatId))
  if (discussionAdmins.has(userId)) {
    return true
  }
  const channelKey = chain.tg_channel_id?.trim()
  if (channelKey) {
    const channelAdmins = await getTelegramAdminUserIds(token, channelKey)
    if (channelAdmins.has(userId)) {
      return true
    }
  }
  return false
}

/** Поднимается по цепочке reply_to_message к корню треда (авто-репост канала). */
export function resolveDiscussionThreadRootMsgId(message: TgMessage): number | null {
  let reply = message.reply_to_message
  if (!reply) {
    return null
  }
  let depth = 0
  while (reply.reply_to_message && depth < 24) {
    reply = reply.reply_to_message
    depth += 1
  }
  return typeof reply.message_id === 'number' ? reply.message_id : null
}

export async function shouldSyncTgCommentToMax(params: {
  message: TgMessage
  chain: TgChainRecord
  token: string
  discussionChatId: number
  postCommentCount: number
  threadRootMsgId: number
}): Promise<boolean> {
  const text = (params.message.text || params.message.caption || '').trim()
  if (!text || text.startsWith('👤 Администратор:')) {
    return false
  }

  const keywords = normalizeCommentSyncKeywords(params.chain.comment_sync_keywords)
  const isAdmin = await isTgCommentFromAdmin(
    params.message,
    params.token,
    params.chain,
    params.discussionChatId,
  )

  if (isAdmin) {
    const directReplyId = params.message.reply_to_message?.message_id
    if (directReplyId == null) {
      return false
    }
    if (directReplyId !== params.threadRootMsgId) {
      return true
    }
    if (params.postCommentCount === 0) {
      return true
    }
    return false
  }

  return matchesCommentSyncKeyword(text, keywords)
}
