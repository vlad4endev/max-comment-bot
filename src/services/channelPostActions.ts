import { Bot, Keyboard } from '@maxhub/max-bot-api'
import type { Message } from '@maxhub/max-bot-api/types'
import { v4 as uuidv4 } from 'uuid'

import { config } from '../config'
import { logger } from '../utils/logger'
import {
  attachCommentButtonToChannelPost,
  buildMiniAppUrl,
  postStore,
  type Post,
} from './postStore'

/**
 * Resolves chat id for a message (channel/group/dialog). Falls back to sender id for 1:1.
 */
export function resolveMessageChatId(message: Message, fallbackUserId: number): number {
  const rid = message.recipient.chat_id
  if (typeof rid === 'number' && Number.isFinite(rid)) {
    return rid
  }
  return fallbackUserId
}

/**
 * Channel posts usually have `recipient.chat_type === 'channel'`; otherwise confirm via getChat.
 */
export async function isLikelyChannelPost(bot: Bot, message: Message): Promise<boolean> {
  if (message.recipient.chat_type === 'channel') {
    return true
  }
  const rid = message.recipient.chat_id
  if (typeof rid !== 'number' || !Number.isFinite(rid)) {
    return false
  }
  try {
    const chat = await bot.api.getChat(rid)
    return chat.type === 'channel'
  } catch (err: unknown) {
    logger.debug('isLikelyChannelPost: getChat failed', { rid, err })
    return false
  }
}

function firstImageUrlFromMessage(message: Message): string | undefined {
  const list = message.body.attachments
  if (!list || list.length === 0) {
    return undefined
  }
  for (const att of list) {
    if (att.type === 'image' && typeof att.payload.url === 'string' && att.payload.url.length > 0) {
      return att.payload.url
    }
  }
  return undefined
}

/** True if the user is a non-bot admin or owner of the channel. */
export async function isUserChannelAdmin(
  bot: Bot,
  channelChatId: number,
  userId: number,
): Promise<boolean> {
  try {
    const { members } = await bot.api.getChatMembers(channelChatId, { user_ids: [userId] })
    const m = members[0]
    if (!m) {
      return false
    }
    return !m.is_bot && (m.is_admin || m.is_owner)
  } catch (err: unknown) {
    logger.warn('isUserChannelAdmin: API error', { channelChatId, userId, err })
    return false
  }
}

export type AttachChannelCommentsResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'no_sender'
        | 'no_mid'
        | 'skip_bot'
        | 'no_miniapp'
        | 'not_admin'
        | 'already_exists'
    }

/**
 * Creates a {@link Post}, saves it, and attaches the Mini App inline button (edit or reply fallback).
 *
 * @param options.skipAuthorAdminCheck — when the invoker was already verified (e.g. `/addbutton`).
 * @param options.channelChatIdOverride — e.g. poller passes registered channel id when recipient metadata is thin.
 */
export async function tryAttachCommentsToChannelPost(
  bot: Bot,
  message: Message,
  options: {
    botUserId?: number
    channelChatIdOverride?: number
    skipAuthorAdminCheck?: boolean
  } = {},
): Promise<AttachChannelCommentsResult> {
  const user = message.sender
  if (!user) {
    return { ok: false, reason: 'no_sender' }
  }

  const chatId =
    typeof options.channelChatIdOverride === 'number' && Number.isFinite(options.channelChatIdOverride)
      ? options.channelChatIdOverride
      : resolveMessageChatId(message, user.user_id)

  const botUid = options.botUserId ?? bot.botInfo?.user_id
  if (botUid !== undefined && user.user_id === botUid) {
    return { ok: false, reason: 'skip_bot' }
  }

  const miniBase = config.miniAppUrl
  if (!miniBase) {
    logger.debug('tryAttachCommentsToChannelPost: MINI_APP_URL not set')
    return { ok: false, reason: 'no_miniapp' }
  }

  const mid = message.body?.mid
  if (typeof mid !== 'string' || mid.trim() === '') {
    return { ok: false, reason: 'no_mid' }
  }

  if (postStore.findPostByChannelMessage(chatId, mid)) {
    return { ok: false, reason: 'already_exists' }
  }

  if (!options.skipAuthorAdminCheck) {
    const adminOk = await isUserChannelAdmin(bot, chatId, user.user_id)
    if (!adminOk) {
      logger.debug('tryAttachCommentsToChannelPost: skip (sender not channel admin)', {
        chatId,
        userId: user.user_id,
      })
      return { ok: false, reason: 'not_admin' }
    }
  }

  logger.info('tryAttachCommentsToChannelPost: attaching', {
    chatId,
    senderId: user.user_id,
    messageMid: mid,
    recipientChatType: message.recipient.chat_type,
  })

  const postId = uuidv4()
  const text = message.body.text?.trim() ?? ''
  const photoUrl = firstImageUrlFromMessage(message)
  const post: Post = {
    post_id: postId,
    chat_id: chatId,
    message_mid: mid,
    text,
    photo_url: photoUrl,
    comment_count: 0,
    timestamp: new Date().toISOString(),
  }
  postStore.savePost(post)

  const openUrl = buildMiniAppUrl(miniBase, postId, chatId)
  const kb = Keyboard.inlineKeyboard([[Keyboard.button.link('💬 Комментарии (0)', openUrl)]])
  const editText = text === '' ? '\u00a0' : text

  await attachCommentButtonToChannelPost(bot, post, editText, kb)
  return { ok: true }
}
