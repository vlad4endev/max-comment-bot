import type { TgChainRecord } from '../api/adminPanelState'
import type { TgMessage } from '../forwarder/telegramReader'
import { listTelegramChatAdministrators } from '../services/integrationPlatformClient'
import { isCommentsBookingActive } from '../services/commentsBookingLock'

/** Режим сопоставления слов для переноса комментариев TG → MAX. */
export type CommentSyncMatchMode = 'contains' | 'equals' | 'word' | 'starts_with' | 'ends_with'

const COMMENT_SYNC_MATCH_MODES: CommentSyncMatchMode[] = [
  'contains',
  'equals',
  'word',
  'starts_with',
  'ends_with',
]

const KEYWORD_PREFIX_MODES: Record<string, CommentSyncMatchMode> = {
  '~': 'contains',
  '=': 'equals',
  '#': 'word',
  '^': 'starts_with',
  $: 'ends_with',
}

export function normalizeCommentSyncMatchMode(
  mode: string | undefined | null,
): CommentSyncMatchMode {
  if (mode && COMMENT_SYNC_MATCH_MODES.includes(mode as CommentSyncMatchMode)) {
    return mode as CommentSyncMatchMode
  }
  return 'contains'
}

export function normalizeCommentSyncKeywords(words: string[] | undefined): string[] {
  return (words ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface ParsedCommentSyncKeyword {
  pattern: string
  mode: CommentSyncMatchMode
}

/** Разбирает тег: префикс `= ^ $ # ~` переопределяет режим для одного слова. */
export function parseCommentSyncKeyword(
  raw: string,
  defaultMode: CommentSyncMatchMode,
): ParsedCommentSyncKeyword | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) {
    return null
  }
  const prefix = trimmed[0]
  const modeFromPrefix = prefix ? KEYWORD_PREFIX_MODES[prefix] : undefined
  if (modeFromPrefix && trimmed.length > 1) {
    const pattern = trimmed.slice(1).trim()
    return pattern ? { pattern, mode: modeFromPrefix } : null
  }
  return { pattern: trimmed, mode: defaultMode }
}

export function matchesCommentSyncPattern(
  text: string,
  pattern: string,
  mode: CommentSyncMatchMode,
): boolean {
  const hay = text.trim().toLowerCase()
  const needle = pattern.trim().toLowerCase()
  if (!hay || !needle) {
    return false
  }

  switch (mode) {
    case 'equals':
      return hay === needle
    case 'starts_with':
      return hay.startsWith(needle)
    case 'ends_with':
      return hay.endsWith(needle)
    case 'word': {
      if (hay === needle) {
        return true
      }
      const re = new RegExp(
        `(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}(?:[^\\p{L}\\p{N}_]|$)`,
        'iu',
      )
      return re.test(hay)
    }
    case 'contains':
    default:
      return hay.includes(needle)
  }
}

export function matchesCommentSyncKeyword(
  text: string,
  keywords: string[],
  defaultMode: CommentSyncMatchMode = 'contains',
): boolean {
  if (keywords.length === 0) {
    return false
  }
  const mode = normalizeCommentSyncMatchMode(defaultMode)
  return keywords.some((kw) => {
    const parsed = parseCommentSyncKeyword(kw, mode)
    return parsed ? matchesCommentSyncPattern(text, parsed.pattern, parsed.mode) : false
  })
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
  if (typeof message.message_thread_id === 'number' && message.message_thread_id > 0) {
    return message.message_thread_id
  }
  const root = resolveThreadRootMessage(message)
  return typeof root?.message_id === 'number' ? root.message_id : null
}

function pushUniqueId(ids: number[], value: number | undefined | null): void {
  if (typeof value !== 'number' || value <= 0 || ids.includes(value)) {
    return
  }
  ids.push(value)
}

/** ID поста в TG-канале из авто-репоста в discussion group. */
export function resolveChannelMsgIdFromThreadRoot(root: {
  forward_origin?: { message_id?: number }
  forward_from_message_id?: number
}): number | null {
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

/** Id треда в группе и id поста в канале — чтобы найти post_comment_mapping. */
export function collectCommentMappingHints(message: TgMessage): {
  threadMsgIds: number[]
  channelMsgIds: number[]
} {
  const threadMsgIds: number[] = []
  const channelMsgIds: number[] = []
  pushUniqueId(threadMsgIds, message.message_thread_id)
  const root = resolveThreadRootMessage(message)
  pushUniqueId(threadMsgIds, root?.message_id)
  pushUniqueId(threadMsgIds, message.reply_to_message?.message_id)
  pushUniqueId(channelMsgIds, resolveChannelMsgIdFromThreadRoot(message))
  if (message.reply_to_message) {
    pushUniqueId(channelMsgIds, resolveChannelMsgIdFromThreadRoot(message.reply_to_message))
  }
  if (root) {
    pushUniqueId(channelMsgIds, resolveChannelMsgIdFromThreadRoot(root))
  }
  return { threadMsgIds, channelMsgIds }
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

/** Комментарий из TG-треда (не создан в MAX miniapp). */
export function isTelegramOriginComment(comment: { source?: 'telegram' | 'max' }): boolean {
  return comment.source !== 'max'
}

/** Маркер на исходном комментарии в TG после ответа админа в MAX (без нового сообщения в треде). */
export const MAX_ANSWERED_IN_MAX_MARKER = '🔒 Забронирован в MAX'

/** Старый маркер — учитываем при проверке уже помеченных сообщений. */
export const LEGACY_ANSWERED_IN_MAX_MARKER = '✅ Отвечено в MAX'

/** Подпись в miniapp: на комментарий ответили в Telegram. */
export const MAX_ANSWERED_IN_TELEGRAM_LABEL = '✅ Отвечено в Telegram'

/** Служебное сообщение в TG-треде: пост забронирован первым комментарием из MAX. */
export const TG_BOOKED_IN_MAX_MARKER = '🔒 Забронировано в МАКСе'

/** Маркер на TG-посте: обсуждение забронировано в ВКонтакте. */
export const TG_BOOKED_IN_VK_MARKER = '🔒 Забронировано в ВКонтакте'

/** Маркер на VK-посте: обсуждение забронировано в MAX. */
export const VK_BOOKED_IN_MAX_MARKER = '🔒 Забронировано в MAX'

/** Маркер на VK-посте: обсуждение забронировано в Telegram. */
export const VK_BOOKED_IN_TG_MARKER = '🔒 Забронировано в Telegram'

export type CommentsBookedPlatform = 'telegram' | 'max' | 'vk'

/** MAX inline callback для неактивной кнопки «Забронировано в ТГ». */
export const MAX_BOOKED_IN_TG_CALLBACK = 'max:booked_tg'

export function formatMaxBookedInTgButtonLabel(commentCount: number): string {
  const n = Math.max(0, commentCount)
  return `🔒 Забронировано в ТГ (${n})`
}

export function formatMaxBookedInVkButtonLabel(commentCount: number): string {
  const n = Math.max(0, commentCount)
  return `🔒 Забронировано в ВК (${n})`
}

export function commentsBookedByLabel(by: CommentsBookedPlatform): string {
  if (by === 'telegram') return 'Telegram'
  if (by === 'vk') return 'ВКонтакте'
  return 'MAX'
}

export function bookingMarkerForTelegram(bookedBy: CommentsBookedPlatform): string | null {
  if (bookedBy === 'max') return TG_BOOKED_IN_MAX_MARKER
  if (bookedBy === 'vk') return TG_BOOKED_IN_VK_MARKER
  return null
}

export function bookingMarkerForVk(bookedBy: CommentsBookedPlatform): string | null {
  if (bookedBy === 'max') return VK_BOOKED_IN_MAX_MARKER
  if (bookedBy === 'telegram') return VK_BOOKED_IN_TG_MARKER
  return null
}

export function postTextHasBookingMarker(text: string, marker: string): boolean {
  return text.includes(marker)
}

export function appendBookingMarker(text: string, marker: string): string {
  const base = text.trim()
  if (!base || base.includes(marker)) {
    return base
  }
  return `${base}\n\n${marker}`
}

export function isTelegramPostMarkedBookedInMax(text: string): boolean {
  return text.includes(TG_BOOKED_IN_MAX_MARKER)
}

export function appendTgBookedInMaxMarker(text: string): string {
  return appendBookingMarker(text, TG_BOOKED_IN_MAX_MARKER)
}

export function isTelegramCommentMarkedAnsweredInMax(text: string): boolean {
  return (
    text.includes(MAX_ANSWERED_IN_MAX_MARKER) ||
    text.includes(LEGACY_ANSWERED_IN_MAX_MARKER)
  )
}

/** Префикс ответа админа из MAX в TG-треде (не синхронизировать обратно в miniapp). */
export const MAX_REPLY_TG_PREFIX = 'MAX ответ:'

/** Префикс пользовательского комментария из MAX в TG-треде. */
export const MAX_COMMENT_TG_PREFIX = 'MAX ·'

/** Старый префикс — игнорируем при обратной синхронизации. */
const LEGACY_ADMIN_REPLY_TG_PREFIX = '👤 Администратор:'

export function isMaxAdminReplyInTelegram(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed.startsWith(MAX_REPLY_TG_PREFIX) || trimmed.startsWith(LEGACY_ADMIN_REPLY_TG_PREFIX)
  )
}

export function isMaxCommentInTelegram(text: string): boolean {
  return text.trim().startsWith(MAX_COMMENT_TG_PREFIX)
}

/** Текст сообщения в TG-треде: имя автора и комментарий из MAX miniapp. */
export function formatMaxCommentForTelegram(username: string, text: string): string {
  const name = username.trim() || 'Пользователь'
  const body = text.trim()
  if (body) {
    return `${MAX_COMMENT_TG_PREFIX} ${name}: ${body}`
  }
  return `${MAX_COMMENT_TG_PREFIX} ${name}`
}

export async function shouldSyncTgCommentToMax(params: {
  message: TgMessage
  chain: TgChainRecord
  token: string
  discussionChatId: number
  postCommentCount: number
  threadRootMsgId: number
  commentsBookedBy?: 'telegram' | 'max' | 'vk' | null
  commentsBookedAt?: string | null
}): Promise<boolean> {
  const bookingActive = isCommentsBookingActive({
    comments_booked_by: params.commentsBookedBy ?? undefined,
    comments_booked_at: params.commentsBookedAt ?? undefined,
  })
  if (
    bookingActive &&
    (params.commentsBookedBy === 'max' || params.commentsBookedBy === 'vk')
  ) {
    return false
  }

  const text = (params.message.text || params.message.caption || '').trim()
  if (
    !text ||
    isMaxAdminReplyInTelegram(text) ||
    isMaxCommentInTelegram(text) ||
    isTelegramCommentMarkedAnsweredInMax(text) ||
    text.includes(TG_BOOKED_IN_MAX_MARKER) ||
    text.includes(TG_BOOKED_IN_VK_MARKER)
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

  const matchMode = normalizeCommentSyncMatchMode(params.chain.comment_sync_match_mode)
  return matchesCommentSyncKeyword(text, keywords, matchMode)
}
