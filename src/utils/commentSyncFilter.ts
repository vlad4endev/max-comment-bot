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
export function resolveThreadRootMessage(message: TgMessage): TgMessage['reply_to_message'] | null {
  let reply = message.reply_to_message
  if (!reply) {
    return null
  }
  let depth = 0
  while (reply.reply_to_message && depth < 24) {
    reply = reply.reply_to_message
    depth += 1
  }
  return reply
}

export function resolveDiscussionThreadRootMsgId(message: TgMessage): number | null {
  const root = resolveThreadRootMessage(message)
  return typeof root?.message_id === 'number' ? root.message_id : null
}

/** ID поста в TG-канале из авто-репоста в discussion group. */
export function resolveChannelMsgIdFromThreadRoot(
  root: NonNullable<TgMessage['reply_to_message']>,
): number | null {
  const fromOrigin = root.forward_origin?.message_id
  if (typeof fromOrigin === 'number' && fromOrigin > 0) {
    return fromOrigin
  }
  const fromForward = root.forward_from_message_id
  if (typeof fromForward === 'number' && fromForward > 0) {
    return fromForward
  }
  return null
}

export function resolveTgCommentAuthor(
  message: TgMessage,
  chain: TgChainRecord,
  discussionChatId: number,
): { userId: number; username: string } {
  const from = message.from
  const fromId = typeof from?.id === 'number' && from.id > 0 ? from.id : 0

  const fullName = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim()
  const rawUsername = from?.username?.trim().replace(/^@/, '')
  const atUsername = rawUsername ? `@${rawUsername}` : ''

  if (fullName) {
    return { userId: fromId || 1, username: fullName }
  }
  if (atUsername) {
    return { userId: fromId || 1, username: atUsername }
  }

  const senderChat = message.sender_chat
  if (senderChat) {
    const channelId = channelChatNumericId(chain)
    if (channelId != null && senderChat.id === channelId) {
      const channelLabel =
        senderChat.title?.trim() ||
        (senderChat.username ? `@${senderChat.username.replace(/^@/, '')}` : '') ||
        'Канал'
      return { userId: fromId || 1, username: channelLabel }
    }
    if (senderChat.id !== discussionChatId) {
      const chatLabel =
        senderChat.title?.trim() ||
        (senderChat.username ? `@${senderChat.username.replace(/^@/, '')}` : '')
      if (chatLabel) {
        return { userId: fromId || 1, username: chatLabel }
      }
    }
  }

  return { userId: fromId || 1, username: 'Аноним' }
}

/** Маркер на исходном комментарии в TG после ответа из MAX. */
export const MAX_ANSWERED_IN_MAX_MARKER = '✅ Отвечено в MAX'

export function isTelegramCommentMarkedAnsweredInMax(text: string): boolean {
  return text.includes(MAX_ANSWERED_IN_MAX_MARKER)
}

/** Префикс ответа админа из MAX в TG-треде (не синхронизировать обратно в miniapp). */
export const MAX_REPLY_TG_PREFIX = 'MAX ответ:'

/** Старый префикс — игнорируем при обратной синхронизации. */
const LEGACY_ADMIN_REPLY_TG_PREFIX = '👤 Администратор:'

export function isMaxAdminReplyInTelegram(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed.startsWith(MAX_REPLY_TG_PREFIX) || trimmed.startsWith(LEGACY_ADMIN_REPLY_TG_PREFIX)
  )
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
  if (
    !text ||
    isMaxAdminReplyInTelegram(text) ||
    isTelegramCommentMarkedAnsweredInMax(text)
  ) {
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
