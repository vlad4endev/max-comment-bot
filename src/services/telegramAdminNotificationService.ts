import type { Bot } from '@maxhub/max-bot-api'

import { config } from '../config'
import { ensureAdminPanelStateLoaded } from '../api/adminPanelState'
import { logger } from '../utils/logger'
import { withTelegramMiniappPlatform } from '../utils/telegramMiniAppUrl'
import { channelNotifyLinkStore } from './channelNotifyLinkStore'
import { profilePairingForPlatformUser } from './channelLinkAdminTeamSync'
import { listTgChainsForMaxChannel } from './channelCommentsButtonPolicy'
import { commentStore, type Comment } from './commentStore'
import { buildAdminCommentNotificationBody, getChannelAdmins } from './notificationService'
import { integrationsStore } from './integrationsStore'
import { listTelegramChatAdministrators } from './integrationPlatformClient'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import { buildTelegramMiniappUrl } from './telegramMiniappAuth'
import { telegramChannelNotifyLinkStore } from './telegramChannelNotifyLinkStore'
import { callTelegramBotApi } from '../utils/telegramRateLimiter'

export const TG_COMMENT_CALLBACK_PREFIX = 'tgc:'

function preview80(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length <= 80) {
    return t
  }
  return `${t.slice(0, 80)}…`
}

export function resolveTelegramSourceChannelsForMaxChat(maxChatId: number): string[] {
  const targetAbs = Math.abs(maxChatId)
  const out = new Set<string>()
  for (const flow of integrationsStore.getFlows()) {
    if (!flow.enabled) {
      continue
    }
    if (flow.source.platform !== 'telegram' || flow.destination.platform !== 'max') {
      continue
    }
    const dest = Number.parseInt(flow.destination.channelId, 10)
    if (!Number.isFinite(dest) || Math.abs(dest) !== targetAbs) {
      continue
    }
    const sourceChannel = flow.source.channelId?.trim() || flow.source.channelUsername?.trim() || ''
    if (sourceChannel !== '') {
      out.add(sourceChannel)
    }
  }
  for (const chain of listTgChainsForMaxChannel(maxChatId)) {
    const tgChannelId = chain.tg_channel_id?.trim()
    if (tgChannelId) {
      out.add(tgChannelId)
    }
    const tgUsername = chain.tg_username?.trim().replace(/^@/, '')
    if (tgUsername) {
      out.add(`@${tgUsername}`)
    }
  }
  return [...out]
}

function hasTelegramLinkForMaxChat(maxChatId: number): boolean {
  if (resolveTelegramSourceChannelsForMaxChat(maxChatId).length > 0) {
    return true
  }
  return listTgChainsForMaxChannel(maxChatId).length > 0
}

function mapMaxUserToTelegramRecipient(maxUserId: number, recipients: Set<number>): void {
  const pairing = profilePairingForPlatformUser('max', maxUserId)
  if (pairing.tg_user_id != null) {
    recipients.add(pairing.tg_user_id)
  }
}

function numericTelegramChatIdVariants(raw: string): string[] {
  const trimmed = raw.trim()
  if (!/^-?\d+$/.test(trimmed)) {
    return []
  }
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(n) || n === 0) {
    return []
  }
  const abs = Math.abs(n)
  return [...new Set([trimmed, String(n), String(abs), String(-abs)])]
}

function telegramNotifyLinkLookupIds(maxChannelChatId: number): string[] {
  const ids = new Set<string>()
  for (const raw of resolveTelegramSourceChannelsForMaxChat(maxChannelChatId)) {
    const trimmed = raw.trim()
    if (!trimmed) {
      continue
    }
    ids.add(trimmed)
    for (const variant of numericTelegramChatIdVariants(trimmed)) {
      ids.add(variant)
    }
  }
  for (const chain of listTgChainsForMaxChannel(maxChannelChatId)) {
    const tgChannelId = chain.tg_channel_id?.trim()
    if (tgChannelId) {
      ids.add(tgChannelId)
      for (const variant of numericTelegramChatIdVariants(tgChannelId)) {
        ids.add(variant)
      }
    }
  }
  return [...ids]
}

/**
 * Кто получает TG-DM о комментариях MAX-канала (зеркало MAX: opt-in + админы, у кого есть Telegram).
 */
export async function collectTelegramAdminNotifyRecipientIds(
  bot: Bot,
  maxChannelChatId: number,
): Promise<number[]> {
  const recipients = new Set<number>()

  for (const maxUserId of channelNotifyLinkStore.getUserIdsForChannel(maxChannelChatId)) {
    mapMaxUserToTelegramRecipient(maxUserId, recipients)
  }

  const maxAdmins = await getChannelAdmins(bot, maxChannelChatId)
  for (const maxUserId of maxAdmins) {
    mapMaxUserToTelegramRecipient(maxUserId, recipients)
  }
  mapMaxUserToTelegramRecipient(config.ownerUserId, recipients)

  for (const chain of listTgChainsForMaxChannel(maxChannelChatId)) {
    if (chain.tg_user_id != null) {
      recipients.add(chain.tg_user_id)
    }
    if (chain.max_user_id != null) {
      mapMaxUserToTelegramRecipient(chain.max_user_id, recipients)
    }
  }

  const token = resolveTelegramBotToken()
  for (const tgChannelId of telegramNotifyLinkLookupIds(maxChannelChatId)) {
    for (const tgUserId of telegramChannelNotifyLinkStore.getUserIdsForChannel(tgChannelId)) {
      recipients.add(tgUserId)
    }
  }
  if (token) {
    const adminLookupIds = new Set(resolveTelegramSourceChannelsForMaxChat(maxChannelChatId))
    for (const chain of listTgChainsForMaxChannel(maxChannelChatId)) {
      const tgChannelId = chain.tg_channel_id?.trim()
      if (tgChannelId) {
        adminLookupIds.add(tgChannelId)
      }
    }
    for (const tgChannelId of adminLookupIds) {
      const admins = await listTelegramChatAdministrators(token, tgChannelId)
      for (const admin of admins) {
        recipients.add(admin.userId)
      }
    }
  }

  return [...recipients]
}

export function buildNewCommentNotificationMessage(input: {
  postText: string
  channelTitle: string
  username: string
  commentText: string
  commentPhotoUrls?: string[]
}): string {
  const postExcerpt = preview80(input.postText)
  const textPart = input.commentText.trim()
  const photoCount = Array.isArray(input.commentPhotoUrls) ? input.commentPhotoUrls.length : 0
  const commentPreview =
    textPart !== ''
      ? textPart
      : photoCount > 0
        ? `📷 Фото: ${photoCount}`
        : 'без текста'
  const photoSuffix = photoCount > 0 ? `\n📷 Фото: ${photoCount}` : ''
  return `📌 Новый комментарий
Пост: «${postExcerpt}»
Канал: ${input.channelTitle}
👤 ${input.username}: ${commentPreview}${photoSuffix}`
}

function isCommentAnsweredByChannel(comment: Comment): boolean {
  if (Array.isArray(comment.replies) && comment.replies.length > 0) {
    return true
  }
  return !!comment.reply
}

type TgInlineButton =
  | { text: string; web_app: { url: string } }
  | { text: string; url: string }
  | { text: string; callback_data: string }

export function buildTelegramCommentNotificationKeyboard(input: {
  postId: string
  maxChatId: number
  messageMid?: string
  telegramUserId: number
  commentId: string
  answered: boolean
  includeModeration?: boolean
}): { inline_keyboard: TgInlineButton[][] } {
  const openLabel = input.answered ? '✅ Отвечено' : '💬 Открыть комментарии'
  const miniAppUrl = buildTelegramMiniappUrl({
    postId: input.postId,
    maxChatId: input.maxChatId,
    messageMid: input.messageMid,
    telegramUserId: input.telegramUserId,
  })
  const openBtn: TgInlineButton =
    miniAppUrl != null
      ? { text: openLabel, web_app: { url: withTelegramMiniappPlatform(miniAppUrl) } }
      : { text: openLabel, url: 'https://t.me/commentvmax_bot' }

  const rows: TgInlineButton[][] = [[openBtn]]
  if (input.includeModeration !== false && !input.answered) {
    rows.push([
      { text: '💬 Ответить', callback_data: `${TG_COMMENT_CALLBACK_PREFIX}r:${input.commentId}` },
      { text: '🗑 Удалить', callback_data: `${TG_COMMENT_CALLBACK_PREFIX}d:${input.commentId}` },
    ])
  }
  return { inline_keyboard: rows }
}

async function tgSendMessage(
  token: string,
  chatId: number,
  text: string,
  replyMarkup: { inline_keyboard: TgInlineButton[][] },
): Promise<number | null> {
  const data = await callTelegramBotApi<{
    ok: boolean
    description?: string
    result?: { message_id?: number }
  }>(
    token,
    'sendMessage',
    {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    },
    { method: 'sendMessage', chatId },
  )
  if (!data.ok) {
    throw new Error(data.description ?? 'Telegram sendMessage failed')
  }
  const messageId = data.result?.message_id
  return typeof messageId === 'number' ? messageId : null
}

async function tgEditMessage(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup: { inline_keyboard: TgInlineButton[][] },
): Promise<void> {
  const data = await callTelegramBotApi<{ ok: boolean; description?: string }>(
    token,
    'editMessageText',
    {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: replyMarkup,
    },
    { method: 'editMessageText', chatId },
  )
  if (!data.ok) {
    throw new Error(data.description ?? 'Telegram editMessageText failed')
  }
}

export async function notifyTelegramAdminsNewMiniappComment(
  bot: Bot,
  input: {
    commentId: string
    maxChannelChatId: number
    postText: string
    channelTitle: string
    username: string
    commentText: string
    commentPhotoUrls?: string[]
    postId: string
    messageMid?: string
  },
): Promise<void> {
  await integrationsStore.load()
  await ensureAdminPanelStateLoaded()
  const token = resolveTelegramBotToken()
  if (!token) {
    logger.debug('notifyTelegramAdminsNewMiniappComment: TG token not configured')
    return
  }

  const message = buildNewCommentNotificationMessage(input)
  commentStore.saveNotificationText(input.commentId, message)

  const recipientIds = await collectTelegramAdminNotifyRecipientIds(bot, input.maxChannelChatId)
  if (recipientIds.length === 0) {
    logger.info('notifyTelegramAdminsNewMiniappComment: no TG recipients (need /start bot + admin/pairing)', {
      commentId: input.commentId,
      maxChannelChatId: input.maxChannelChatId,
      tgChannels: resolveTelegramSourceChannelsForMaxChat(input.maxChannelChatId),
      hasTelegramLink: hasTelegramLinkForMaxChat(input.maxChannelChatId),
    })
    return
  }

  for (const recipientId of recipientIds) {
    const keyboard = buildTelegramCommentNotificationKeyboard({
      postId: input.postId,
      maxChatId: input.maxChannelChatId,
      messageMid: input.messageMid,
      telegramUserId: recipientId,
      commentId: input.commentId,
      answered: false,
    })
    try {
      const messageId = await tgSendMessage(token, recipientId, message, keyboard)
      if (messageId != null) {
        commentStore.saveTgNotificationMid(input.commentId, recipientId, messageId)
      }
      logger.info('notifyTelegramAdminsNewMiniappComment: delivered', {
        commentId: input.commentId,
        recipientId,
      })
    } catch (err: unknown) {
      logger.warn('notifyTelegramAdminsNewMiniappComment: sendMessage failed', {
        commentId: input.commentId,
        recipientId,
        err,
      })
    }
  }
}

export async function syncTelegramAdminCommentNotification(input: {
  comment: Comment
  postId: string
  channelChatId: number
  messageMid?: string
  deleted?: boolean
}): Promise<void> {
  const token = resolveTelegramBotToken()
  if (!token) {
    return
  }
  const mids = commentStore.getTgNotificationMids(input.comment.comment_id)
  if (mids.length === 0) {
    return
  }

  const body = input.deleted
    ? '🗑 Комментарий удалён'
    : buildAdminCommentNotificationBody(input.comment)
  if (!body) {
    return
  }

  const answered = isCommentAnsweredByChannel(input.comment)
  for (const { tg_user_id, message_id } of mids) {
    const keyboard = buildTelegramCommentNotificationKeyboard({
      postId: input.postId,
      maxChatId: input.channelChatId,
      messageMid: input.messageMid,
      telegramUserId: tg_user_id,
      commentId: input.comment.comment_id,
      answered,
      includeModeration: !input.deleted && !answered,
    })
    try {
      await tgEditMessage(token, tg_user_id, message_id, body, keyboard)
    } catch (err: unknown) {
      logger.warn('syncTelegramAdminCommentNotification: editMessage failed', {
        tg_user_id,
        message_id,
        commentId: input.comment.comment_id,
        err,
      })
    }
  }
}
