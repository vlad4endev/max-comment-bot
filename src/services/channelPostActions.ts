import { Bot, Keyboard } from '@maxhub/max-bot-api'
import type { Message } from '@maxhub/max-bot-api/types'
import { v4 as uuidv4 } from 'uuid'

import { logger } from '../utils/logger'
import { pushAdminActivity } from './adminActivityStore'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { disabledAdminStore } from './disabledAdminStore'
import {
  attachCommentButtonToChannelPost,
  buildMiniAppUrl,
  isMiniAppOpenUrlConfigured,
  mediaAttachmentRequestsFromMessageBody,
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

/**
 * Bot messages that are not channel posts: reply-stub with the comments keyboard, or UI rows already in DB.
 */
function isBotOwnedCommentsUiMessage(
  message: Message,
  chatId: number,
  botUid: number | undefined,
): boolean {
  const user = message.sender
  if (!user || botUid === undefined || user.user_id !== botUid) {
    return false
  }
  if (message.link?.type === 'reply') {
    return true
  }
  const mid = message.body?.mid
  if (typeof mid === 'string' && mid.trim() !== '' && postStore.findPostByCommentsUiMessage(chatId, mid)) {
    return true
  }
  const atts = message.body.attachments
  if (atts?.some((a) => a.type === 'inline_keyboard')) {
    return true
  }
  return false
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
  if (disabledAdminStore.isDisabled(userId)) {
    return false
  }
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
        | 'no_chat_id'
        | 'no_mid'
        | 'skip_bot'
        | 'no_miniapp'
        | 'not_admin'
        | 'already_exists'
        | 'attach_failed'
    }

export type CommentButtonAttachSource =
  | 'webhook'
  | 'poller'
  | 'refresh'
  | 'manual'
  | 'ensure'
  | 'tg_chain'

type AttachFailReason = Extract<AttachChannelCommentsResult, { ok: false }>['reason']

const COMMENT_BUTTON_REASON_RU: Record<AttachFailReason, string> = {
  no_chat_id: 'не удалось определить chat_id канала',
  no_mid: 'у сообщения нет mid',
  skip_bot: 'служебное сообщение бота (reply/UI), не пост канала',
  no_miniapp: 'не заданы BOT_NICKNAME или MINI_APP_URL',
  not_admin: 'автор не администратор канала (или отключён в боте)',
  already_exists: 'пост уже в базе — кнопка была привязана ранее',
  attach_failed: 'не удалось edit поста и reply с кнопкой в MAX',
}

function durationFields(since: number): { durationMs: number; duration: string } {
  const durationMs = Math.round(performance.now() - since)
  const duration = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(2)} с` : `${durationMs} мс`
  return { durationMs, duration }
}

function logCommentButton(
  level: 'info' | 'warn' | 'error',
  message: string,
  data: Record<string, unknown>,
): void {
  if (level === 'warn') logger.warn(message, data)
  else if (level === 'error') logger.error(message, data)
  else logger.info(message, data)
}

function logCommentButtonSkip(
  source: CommentButtonAttachSource | undefined,
  reason: AttachFailReason,
  ctx: Record<string, unknown>,
  since: number,
): void {
  const hint = COMMENT_BUTTON_REASON_RU[reason]
  const timing = durationFields(since)
  const level =
    reason === 'no_miniapp' || reason === 'not_admin' || reason === 'attach_failed' ? 'warn' : 'info'
  logCommentButton(level, `commentButton: не присвоена — ${hint} (${timing.duration})`, {
    source: source ?? 'unknown',
    outcome: reason,
    ...timing,
    ...ctx,
  })
}

function logCommentButtonOk(
  source: CommentButtonAttachSource | undefined,
  ctx: Record<string, unknown>,
  since: number,
): void {
  const timing = durationFields(since)
  logCommentButton('info', `commentButton: кнопка «Комментарии» присвоена (${timing.duration})`, {
    source: source ?? 'unknown',
    outcome: 'attached',
    ...timing,
    ...ctx,
  })
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
    source?: CommentButtonAttachSource
  } = {},
): Promise<AttachChannelCommentsResult> {
  const attachStartedAt = performance.now()
  const source = options.source
  const user = message.sender ?? undefined
  const override = options.channelChatIdOverride
  const overrideOk =
    typeof override === 'number' && Number.isFinite(override) ? override : undefined
  const rid = message.recipient?.chat_id
  const recipientChatId = typeof rid === 'number' && Number.isFinite(rid) ? rid : undefined
  const rawChatId = overrideOk ?? recipientChatId ?? null
  if (rawChatId === null) {
    const result = { ok: false as const, reason: 'no_chat_id' as const }
    logCommentButtonSkip(source, result.reason, { recipientChatType: message.recipient?.chat_type }, attachStartedAt)
    return result
  }
  const chatId = resolveCanonicalChannelChatId(rawChatId) ?? rawChatId

  if (!isMiniAppOpenUrlConfigured()) {
    const result = { ok: false as const, reason: 'no_miniapp' as const }
    logCommentButtonSkip(source, result.reason, { chatId }, attachStartedAt)
    return result
  }

  const mid = message.body?.mid
  if (typeof mid !== 'string' || mid.trim() === '') {
    const result = { ok: false as const, reason: 'no_mid' as const }
    logCommentButtonSkip(source, result.reason, { chatId }, attachStartedAt)
    return result
  }

  logCommentButton('info', 'commentButton: проверка поста', {
    source: source ?? 'unknown',
    chatId,
    messageMid: mid,
    senderId: user?.user_id,
    recipientChatType: message.recipient.chat_type,
  })

  const existingPost = postStore.findPostByChannelMessage(chatId, mid)
  if (existingPost) {
    /** Периодический поллер не трогает MAX API для постов с кнопкой — иначе очередь каналов растягивается на минуты. */
    if (source === 'poller') {
      const result = { ok: false as const, reason: 'already_exists' as const }
      logCommentButtonSkip(
        source,
        result.reason,
        {
          chatId,
          messageMid: mid,
          postId: existingPost.post_id,
          pollerSkipApi: true,
        },
        attachStartedAt,
      )
      return result
    }

    const captionStartedAt = performance.now()
    const captionOk = await postStore.updateButtonCaption(bot, existingPost)
    const captionTiming = durationFields(captionStartedAt)
    if (captionOk) {
      logCommentButton('info', `commentButton: пост уже с кнопкой — обновлена подпись (${captionTiming.duration})`, {
        source: source ?? 'unknown',
        chatId,
        messageMid: mid,
        postId: existingPost.post_id,
        captionUpdateMs: captionTiming.durationMs,
      })
      const result = { ok: false as const, reason: 'already_exists' as const }
      logCommentButtonSkip(
        source,
        result.reason,
        {
          chatId,
          messageMid: mid,
          postId: existingPost.post_id,
          captionRefreshed: true,
          captionUpdateMs: captionTiming.durationMs,
        },
        attachStartedAt,
      )
      return result
    }

    logCommentButton('warn', 'commentButton: пост в базе, кнопка не видна — повторное присвоение', {
      source: source ?? 'unknown',
      chatId,
      messageMid: mid,
      postId: existingPost.post_id,
    })
    const openUrl = buildMiniAppUrl(existingPost.post_id, chatId, undefined, mid)
    const kb = Keyboard.inlineKeyboard([
      [Keyboard.button.link(`💬 Комментарии (${existingPost.comment_count})`, openUrl)],
    ])
    const editText = existingPost.text.trim() === '' ? '\u00a0' : existingPost.text
    const reattached = await attachCommentButtonToChannelPost(bot, existingPost, editText, kb, {
      source: source ?? 'unknown',
      phase: 'reattach',
    })
    if (reattached) {
      logCommentButtonOk(
        source,
        {
          chatId,
          messageMid: mid,
          postId: existingPost.post_id,
          reattached: true,
        },
        attachStartedAt,
      )
      return { ok: true }
    }
    const fail = { ok: false as const, reason: 'attach_failed' as const }
    logCommentButtonSkip(
      source,
      fail.reason,
      {
        chatId,
        messageMid: mid,
        postId: existingPost.post_id,
        reattachAttempt: true,
      },
      attachStartedAt,
    )
    return fail
  }

  const botUid = options.botUserId ?? bot.botInfo?.user_id
  if (isBotOwnedCommentsUiMessage(message, chatId, botUid)) {
    const result = { ok: false as const, reason: 'skip_bot' as const }
    logCommentButtonSkip(
      source,
      result.reason,
      {
        chatId,
        messageMid: mid,
        linkType: message.link?.type,
      },
      attachStartedAt,
    )
    return result
  }

  const needsAdminCheck = Boolean(user) && !options.skipAuthorAdminCheck
  if (needsAdminCheck && user) {
    const adminStartedAt = performance.now()
    const adminOk = await isUserChannelAdmin(bot, chatId, user.user_id)
    const adminTiming = durationFields(adminStartedAt)
    if (!adminOk) {
      const result = { ok: false as const, reason: 'not_admin' as const }
      logCommentButtonSkip(
        source,
        result.reason,
        {
          chatId,
          messageMid: mid,
          senderId: user.user_id,
          adminCheckMs: adminTiming.durationMs,
        },
        attachStartedAt,
      )
      return result
    }
  }

  logCommentButton('info', 'commentButton: присваиваем кнопку новому посту', {
    source: source ?? 'unknown',
    chatId,
    messageMid: mid,
    senderId: user?.user_id,
  })

  const postId = uuidv4()
  const text = message.body.text?.trim() ?? ''
  const photoUrl = firstImageUrlFromMessage(message)
  const media_attachments = mediaAttachmentRequestsFromMessageBody(message.body.attachments)
  const channelPostUrl =
    typeof message.url === 'string' && message.url.trim() !== '' ? message.url.trim() : undefined
  const post: Post = {
    post_id: postId,
    chat_id: chatId,
    message_mid: mid,
    sender_name: user?.name ?? 'Канал',
    text,
    photo_url: photoUrl,
    channel_post_url: channelPostUrl,
    media_attachments,
    comment_count: 0,
    timestamp: new Date().toISOString(),
  }
  const openUrl = buildMiniAppUrl(postId, chatId, undefined, mid)
  const kb = Keyboard.inlineKeyboard([[Keyboard.button.link('💬 Комментарии (0)', openUrl)]])
  const editText = text === '' ? '\u00a0' : text

  const attached = await attachCommentButtonToChannelPost(bot, post, editText, kb, {
    source: source ?? 'unknown',
    phase: 'new',
  })
  if (!attached) {
    const result = { ok: false as const, reason: 'attach_failed' as const }
    logCommentButtonSkip(source, result.reason, { chatId, messageMid: mid, postId }, attachStartedAt)
    return result
  }

  postStore.savePost(post)
  pushAdminActivity('new_post_button', {
    chat_id: chatId,
    post_id: postId,
    message_mid: mid,
  })
  logCommentButtonOk(source, { chatId, messageMid: mid, postId }, attachStartedAt)
  return { ok: true }
}

/**
 * Loads a channel message from MAX and registers it in {@link postStore} if missing.
 * Used when Mini App opens with `message_mid` but the post row was lost (DB reset, migration).
 */
export async function ensurePostFromChannelMessage(
  bot: Bot,
  chatId: number,
  messageMid: string,
): Promise<Post | null> {
  const canonicalChatId = resolveCanonicalChannelChatId(chatId) ?? chatId
  const existing = postStore.findPostByChannelMessage(canonicalChatId, messageMid)
  if (existing) {
    return existing
  }
  let message: Message | undefined
  try {
    message = await bot.api.getMessage(messageMid)
  } catch {
    try {
      const { messages } = await bot.api.getMessages(canonicalChatId, {
        message_ids: [messageMid],
      })
      message = messages[0]
    } catch (err: unknown) {
      logger.warn('ensurePostFromChannelMessage: could not load message', {
        chatId: canonicalChatId,
        messageMid,
        err,
      })
      return null
    }
  }
  if (!message?.body?.mid) {
    return null
  }
  const r = await tryAttachCommentsToChannelPost(bot, message, {
    channelChatIdOverride: canonicalChatId,
    skipAuthorAdminCheck: true,
    source: 'ensure',
  })
  if (r.ok || r.reason === 'already_exists') {
    return postStore.findPostByChannelMessage(canonicalChatId, messageMid)
  }
  if (r.reason === 'attach_failed') {
    logger.warn('ensurePostFromChannelMessage: button attach failed', {
      chatId: canonicalChatId,
      messageMid,
    })
  }
  return null
}
