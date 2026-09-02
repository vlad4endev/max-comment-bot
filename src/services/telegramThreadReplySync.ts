/**
 * telegramThreadReplySync.ts
 *
 * MAX miniapp → TG discussion group: пользовательские комментарии и ответы админа.
 */

import type { Bot } from '@maxhub/max-bot-api'

import { listTgChainsSync } from '../api/adminPanelState'
import type { Comment } from './commentStore'
import { commentStore } from './commentStore'
import { findMappingByMaxMid, resolveTelegramChannelKeyForMapping } from './postCommentMappingStore'
import { ensurePostThreadMapping, refreshPostThreadMapping } from './telegramDiscussionThreadResolver'
import type { Post } from './postStore'
import { postStore } from './postStore'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import { isCommentSynced, markCommentSynced } from '../utils/commentSyncGuard'
import {
  MAX_ANSWERED_IN_MAX_MARKER,
  MAX_REPLY_TG_PREFIX,
  formatMaxCommentForTelegram,
  isTelegramCommentMarkedAnsweredInMax,
} from '../utils/commentSyncFilter'
import {
  claimAndPropagateCommentsBooking,
  isCommentSyncBlockedByBooking,
} from './commentsBookingService'
import { logger } from '../utils/logger'
import {
  extractTelegramErrorText,
  isBotNotMemberError,
  isInvalidTelegramMessageIdError,
  isSendAsPeerInvalidError,
  isTelegramForbiddenError,
  suggestActionForTelegramSyncError,
} from '../utils/telegramSyncErrors'
import { sendAdminAlert } from '../utils/alertService'
import {
  sendDiscussionMessageAsPeer,
  type DiscussionSendAsMode,
} from './telegramMtprotoDiscussionSender'
import type { PostCommentMappingRow } from './postCommentMappingStore'
import { callTelegramBotApi } from '../utils/telegramRateLimiter'

type TgMessageTarget = {
  token: string
  chatId: number
  messageId: number
  messageThreadId?: number
}

type ThreadTarget = {
  chainId: string
  token: string
  threadChatId: number
  threadMsgId: number
  channelKey: string | null
  sendAsMode: DiscussionSendAsMode
}

const DISCUSSION_FORBIDDEN_BACKOFF_MS = 15 * 60_000
const discussionSendBlockedUntil = new Map<number, number>()

function isDiscussionChatBlocked(chatId: number): boolean {
  const until = discussionSendBlockedUntil.get(chatId)
  return until != null && Date.now() < until
}

function blockDiscussionChat(chatId: number): void {
  discussionSendBlockedUntil.set(chatId, Date.now() + DISCUSSION_FORBIDDEN_BACKOFF_MS)
}

function chainTitle(chainId: string): string {
  return listTgChainsSync().find((c) => c.id === chainId)?.max_title ?? chainId
}

async function handleDiscussionSendForbidden(
  target: ThreadTarget,
  commentId: string,
  err: unknown,
): Promise<void> {
  const errText = extractTelegramErrorText(err)
  const suggestion = suggestActionForTelegramSyncError(errText)
  if (isBotNotMemberError(errText) || isTelegramForbiddenError(errText)) {
    blockDiscussionChat(target.threadChatId)
  }
  logger.warn('[telegramThreadReplySync] send to TG thread failed', {
    commentId,
    chainId: target.chainId,
    chainTitle: chainTitle(target.chainId),
    threadChatId: target.threadChatId,
    error: errText,
    suggestion,
  })
  await sendAdminAlert(
    `tg_discussion_forbidden:${target.threadChatId}`,
    `Бот не может писать в группу обсуждений ${target.threadChatId}`,
    {
      chain: chainTitle(target.chainId),
      threadChatId: target.threadChatId,
      commentId,
      error: errText,
      action: suggestion,
    },
  )
}

function resolveDiscussionSendAs(chainId: string): DiscussionSendAsMode {
  const chain = listTgChainsSync().find((c) => c.id === chainId)
  return chain?.tg_discussion_send_as === 'chat' ? 'chat' : 'channel'
}

function resolveTelegramBotTokenForChain(chainId: string): string {
  const chain = listTgChainsSync().find((c) => c.id === chainId)
  const fromChain = chain?.bot_token?.trim()
  if (fromChain) {
    return fromChain
  }
  return resolveTelegramBotToken()
}

function isCommentForwardEnabled(chainId: string): boolean {
  const chain = listTgChainsSync().find((c) => c.id === chainId)
  return chain?.active !== false && chain?.forward_comments === true
}

function resolveChannelKeyForMapping(mapping: PostCommentMappingRow): string | null {
  return resolveTelegramChannelKeyForMapping(mapping)
}

function resolvePostThreadTargetFromMapping(mapping: PostCommentMappingRow): ThreadTarget | null {
  if (!mapping.tg_thread_chat_id || !mapping.tg_thread_msg_id) {
    return null
  }
  if (!isCommentForwardEnabled(mapping.chain_id)) {
    return null
  }
  const token = resolveTelegramBotTokenForChain(mapping.chain_id)
  if (!token) {
    return null
  }
  return {
    chainId: mapping.chain_id,
    token,
    threadChatId: mapping.tg_thread_chat_id,
    threadMsgId: mapping.tg_thread_msg_id,
    channelKey: resolveChannelKeyForMapping(mapping),
    sendAsMode: resolveDiscussionSendAs(mapping.chain_id),
  }
}

async function resolvePostThreadTarget(messageMid: string): Promise<ThreadTarget | null> {
  await ensurePostThreadMapping(messageMid)
  const mapping = findMappingByMaxMid(messageMid)
  if (!mapping) {
    return null
  }
  return resolvePostThreadTargetFromMapping(mapping)
}

function buildMaxCommentTelegramText(comment: Comment): string {
  const stored = comment.tg_message_text?.trim()
  if (stored) {
    return stored
  }
  const text = comment.text.trim()
  const photoFallback = '📷 Фото'
  const name = comment.username.trim() || 'Пользователь'
  if (text) {
    return formatMaxCommentForTelegram(name, text)
  }
  if (Array.isArray(comment.photo_urls) && comment.photo_urls.length > 0) {
    return formatMaxCommentForTelegram(name, photoFallback)
  }
  return ''
}

function tgPayload(
  target: TgMessageTarget,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    chat_id: target.chatId,
    message_id: target.messageId,
    ...extra,
  }
  if (typeof target.messageThreadId === 'number' && target.messageThreadId > 0) {
    payload.message_thread_id = target.messageThreadId
  }
  return payload
}

async function callTelegramBot<T extends { ok: boolean; description?: string }>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  logContext: Record<string, unknown>,
): Promise<T> {
  const data = await callTelegramBotApi<T>(token, method, payload, {
    method,
    chatId: typeof payload.chat_id === 'number' || typeof payload.chat_id === 'string'
      ? payload.chat_id
      : undefined,
  })
  if (!data.ok) {
    const description = data.description ?? ''
    logger.warn(`[telegramThreadReplySync] ${method} failed`, {
      ...logContext,
      description,
      errorKind: isInvalidTelegramMessageIdError(description)
        ? 'invalid_message_id'
        : isTelegramForbiddenError(description)
          ? 'forbidden'
          : 'other',
      suggestion: suggestActionForTelegramSyncError(description),
    })
  }
  return data
}

async function deliverTelegramThreadMessage(
  target: ThreadTarget,
  text: string,
  replyToId: number,
  useMtprotoSendAs: boolean,
  botFallbackText?: string,
): Promise<number | null> {
  if (useMtprotoSendAs && (target.sendAsMode === 'chat' || target.channelKey)) {
    try {
      const tgMsgId = await sendDiscussionMessageAsPeer(
        target.sendAsMode,
        target.threadChatId,
        target.channelKey,
        text,
        replyToId,
      )
      if (tgMsgId != null) {
        return tgMsgId
      }
      logger.warn('[telegramThreadReplySync] sendAs peer unavailable, fallback to bot', {
        chainId: target.chainId,
        sendAsMode: target.sendAsMode,
        channelKey: target.channelKey,
      })
    } catch (err: unknown) {
      const errText = extractTelegramErrorText(err)
      if (isSendAsPeerInvalidError(errText) && target.sendAsMode === 'channel') {
        try {
          const tgMsgId = await sendDiscussionMessageAsPeer(
            'chat',
            target.threadChatId,
            target.channelKey,
            text,
            replyToId,
          )
          if (tgMsgId != null) {
            logger.info('[telegramThreadReplySync] sendAs channel failed, chat mode succeeded', {
              chainId: target.chainId,
            })
            return tgMsgId
          }
        } catch (chatErr: unknown) {
          logger.warn('[telegramThreadReplySync] sendAs chat fallback failed', {
            chainId: target.chainId,
            err: chatErr,
          })
        }
      }
      logger.warn('[telegramThreadReplySync] sendAs peer failed, fallback to bot', {
        chainId: target.chainId,
        sendAsMode: target.sendAsMode,
        channelKey: target.channelKey,
        err,
        errorKind: isSendAsPeerInvalidError(errText) ? 'send_as_peer_invalid' : 'other',
        suggestion: suggestActionForTelegramSyncError(errText),
      })
    }
  }

  const botText = botFallbackText ?? text
  return sendTelegramThreadMessage(
    target.token,
    target.threadChatId,
    botText,
    replyToId,
    target.threadMsgId,
  )
}

async function sendTelegramThreadMessage(
  token: string,
  chatId: number,
  text: string,
  replyToMessageId: number,
  messageThreadId?: number,
): Promise<number | null> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
  }
  if (typeof messageThreadId === 'number' && messageThreadId > 0) {
    payload.message_thread_id = messageThreadId
  }
  const data = await callTelegramBot<{
    ok: boolean
    description?: string
    result?: { message_id?: number }
  }>(token, 'sendMessage', payload, { chatId, replyToMessageId, messageThreadId })
  if (!data.ok) {
    throw new Error(data.description ?? 'Telegram sendMessage failed')
  }
  const messageId = data.result?.message_id
  return typeof messageId === 'number' ? messageId : null
}

async function deliverTelegramThreadMessageWithRetry(
  messageMid: string,
  target: ThreadTarget,
  text: string,
  replyToId: number,
  useMtprotoSendAs: boolean,
  botFallbackText?: string,
): Promise<number | null> {
  try {
    return await deliverTelegramThreadMessage(target, text, replyToId, useMtprotoSendAs, botFallbackText)
  } catch (err: unknown) {
    const errText = extractTelegramErrorText(err)
    const canRefreshMapping =
      isInvalidTelegramMessageIdError(errText) || isBotNotMemberError(errText)
    if (!canRefreshMapping) {
      throw err
    }

    logger.warn('[telegramThreadReplySync] thread target rejected, refreshing mapping', {
      messageMid,
      chainId: target.chainId,
      threadChatId: target.threadChatId,
      threadMsgId: target.threadMsgId,
      replyToId,
      errText,
    })

    const refreshed = await refreshPostThreadMapping(messageMid)
    const refreshedTarget = refreshed ? resolvePostThreadTargetFromMapping(refreshed) : null
    if (!refreshedTarget) {
      throw err
    }
    if (isBotNotMemberError(errText) && refreshedTarget.threadChatId === target.threadChatId) {
      throw err
    }

    return deliverTelegramThreadMessage(
      refreshedTarget,
      text,
      isInvalidTelegramMessageIdError(errText) ? refreshedTarget.threadMsgId : replyToId,
      useMtprotoSendAs,
      botFallbackText,
    )
  }
}

async function tryEditTelegramMessageText(
  target: TgMessageTarget,
  text: string,
): Promise<boolean> {
  const data = await callTelegramBot<{ ok: boolean; description?: string }>(
    target.token,
    'editMessageText',
    tgPayload(target, { text }),
    { chatId: target.chatId, messageId: target.messageId },
  )
  return data.ok === true
}

async function tryEditTelegramMessageCaption(
  target: TgMessageTarget,
  caption: string,
): Promise<boolean> {
  const data = await callTelegramBot<{ ok: boolean; description?: string }>(
    target.token,
    'editMessageCaption',
    tgPayload(target, { caption }),
    { chatId: target.chatId, messageId: target.messageId },
  )
  return data.ok === true
}

async function tryEditTelegramMessageReplyMarkup(target: TgMessageTarget): Promise<boolean> {
  const data = await callTelegramBot<{ ok: boolean; description?: string }>(
    target.token,
    'editMessageReplyMarkup',
    tgPayload(target, {
      reply_markup: {
        inline_keyboard: [[{ text: MAX_ANSWERED_IN_MAX_MARKER, callback_data: 'max:booked' }]],
      },
    }),
    { chatId: target.chatId, messageId: target.messageId },
  )
  return data.ok === true
}

async function trySetTelegramMessageReaction(
  target: TgMessageTarget,
  emoji: string,
): Promise<boolean> {
  const data = await callTelegramBot<{ ok: boolean; description?: string }>(
    target.token,
    'setMessageReaction',
    tgPayload(target, {
      reaction: [{ type: 'emoji', emoji }],
    }),
    { chatId: target.chatId, messageId: target.messageId, emoji },
  )
  return data.ok === true
}

async function trySendBookedMarkerReply(
  token: string,
  chatId: number,
  replyToMessageId: number,
  messageThreadId?: number,
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: MAX_ANSWERED_IN_MAX_MARKER,
    reply_to_message_id: replyToMessageId,
  }
  if (typeof messageThreadId === 'number' && messageThreadId > 0) {
    payload.message_thread_id = messageThreadId
  }
  const data = await callTelegramBot<{ ok: boolean; description?: string }>(
    token,
    'sendMessage',
    payload,
    { chatId, replyToMessageId, messageThreadId },
  )
  return data.ok === true
}

async function tryEditTelegramPostBody(
  target: TgMessageTarget,
  markedText: string,
): Promise<boolean> {
  return (
    (await tryEditTelegramMessageCaption(target, markedText)) ||
    (await tryEditTelegramMessageText(target, markedText))
  )
}

/**
 * Помечает исходный комментарий в TG-треде как отвеченный в MAX.
 * @returns true если сообщение успешно помечено (edit или reaction)
 */
export async function markTelegramCommentAnsweredInMax(
  token: string,
  chatId: number,
  tgCommentId: number,
  commentText: string,
  options?: { messageThreadId?: number; commentId?: string },
): Promise<boolean> {
  if (options?.commentId) {
    const existing = commentStore.getComment(options.commentId)
    if (existing?.booked_in_max_tg) {
      return true
    }
  }

  const target: TgMessageTarget = {
    token,
    chatId,
    messageId: tgCommentId,
    messageThreadId: options?.messageThreadId,
  }

  const baseText = commentText.trim()
  if (!baseText) {
    logger.warn('[telegramThreadReplySync] empty TG message text for booked marker', {
      tgCommentId,
      chatId,
      commentId: options?.commentId ?? null,
    })
    return false
  }
  if (isTelegramCommentMarkedAnsweredInMax(baseText)) {
    if (options?.commentId) {
      commentStore.markBookedInMaxTelegram(options.commentId)
    }
    return true
  }

  const markedText = `${baseText}\n\n${MAX_ANSWERED_IN_MAX_MARKER}`

  const edited =
    (await tryEditTelegramMessageText(target, markedText)) ||
    (await tryEditTelegramMessageCaption(target, markedText))
  if (edited) {
    logger.info('[telegramThreadReplySync] marked TG comment as answered in MAX (edit)', {
      tgCommentId,
      chatId,
    })
    if (options?.commentId) {
      commentStore.markBookedInMaxTelegram(options.commentId)
    }
    return true
  }

  if (await tryEditTelegramMessageReplyMarkup(target)) {
    logger.info('[telegramThreadReplySync] marked TG comment as answered in MAX (reply markup)', {
      tgCommentId,
      chatId,
    })
    if (options?.commentId) {
      commentStore.markBookedInMaxTelegram(options.commentId)
    }
    return true
  }

  for (const emoji of ['✅', '👍', '🔒']) {
    if (await trySetTelegramMessageReaction(target, emoji)) {
      logger.info('[telegramThreadReplySync] marked TG comment as answered in MAX (reaction)', {
        tgCommentId,
        chatId,
        emoji,
      })
      if (options?.commentId) {
        commentStore.markBookedInMaxTelegram(options.commentId)
      }
      return true
    }
  }

  if (
    await trySendBookedMarkerReply(token, chatId, tgCommentId, options?.messageThreadId)
  ) {
    logger.info('[telegramThreadReplySync] marked TG comment as answered in MAX (reply marker)', {
      tgCommentId,
      chatId,
    })
    if (options?.commentId) {
      commentStore.markBookedInMaxTelegram(options.commentId)
    }
    return true
  }

  logger.warn('[telegramThreadReplySync] failed to mark TG comment as answered in MAX', {
    tgCommentId,
    chatId,
    commentId: options?.commentId ?? null,
  })
  return false
}

/**
 * Отправляет пользовательский комментарий из MAX miniapp в TG-тред.
 */
export async function syncMaxCommentToTelegramThread(
  _bot: Bot,
  comment: Comment,
  post: Post,
): Promise<void> {
  const freshPost = postStore.getPost(post.post_id) ?? post
  if (isCommentSyncBlockedByBooking(freshPost, 'max')) {
    markCommentSynced(`max-comment-tg-blocked:${comment.comment_id}`)
    logger.debug('[telegramThreadReplySync] skip MAX→TG: post booked elsewhere', {
      commentId: comment.comment_id,
      postId: freshPost.post_id,
      bookedBy: freshPost.comments_booked_by,
    })
    return
  }

  await ensurePostThreadMapping(post.message_mid)

  const freshComment = commentStore.getComment(comment.comment_id) ?? comment
  if (freshComment.source === 'telegram' || freshComment.source === 'vk' || freshComment.tg_comment_id) {
    return
  }

  const target = await resolvePostThreadTarget(post.message_mid)
  if (!target) {
    const mapping = findMappingByMaxMid(post.message_mid)
    const logPayload = {
      commentId: freshComment.comment_id,
      messageMid: post.message_mid,
      chainId: mapping?.chain_id ?? null,
      tgThreadChatId: mapping?.tg_thread_chat_id ?? null,
      tgThreadMsgId: mapping?.tg_thread_msg_id ?? null,
    }
    if (!mapping) {
      logger.debug('[telegramThreadReplySync] skip MAX→TG: post not linked to Telegram', logPayload)
    } else {
      logger.warn('[telegramThreadReplySync] no thread mapping for MAX comment', logPayload)
    }
    return
  }

  if (isDiscussionChatBlocked(target.threadChatId)) {
    logger.debug('[telegramThreadReplySync] skip MAX→TG: discussion chat blocked', {
      commentId: freshComment.comment_id,
      chainId: target.chainId,
      threadChatId: target.threadChatId,
    })
    return
  }

  const body = buildMaxCommentTelegramText(freshComment)
  if (!body) {
    return
  }

  const guardKey = `max-comment:${freshComment.comment_id}`
  if (isCommentSynced(guardKey)) {
    return
  }

  try {
    const tgMsgId = await deliverTelegramThreadMessageWithRetry(
      post.message_mid,
      target,
      body,
      target.threadMsgId,
      false,
    )
    if (tgMsgId == null) {
      return
    }

    markCommentSynced(`tg:${tgMsgId}`)
    markCommentSynced(guardKey)
    commentStore.setTgCommentId(freshComment.comment_id, tgMsgId, body)

    await claimAndPropagateCommentsBooking(freshPost.post_id, 'max', _bot)

    logger.info('[telegramThreadReplySync] delivered MAX comment to TG thread', {
      commentId: freshComment.comment_id,
      tgMsgId,
      threadChatId: target.threadChatId,
      username: freshComment.username,
    })
  } catch (err: unknown) {
    await handleDiscussionSendForbidden(target, freshComment.comment_id, err)
  }
}

/**
 * Отправляет ответ администратора из MAX в TG-тред только если комментарий
 * не привязан к TG (fallback). Для MAX→TG комментариев — только правка маркера.
 */
export async function syncAdminReplyToTelegramThread(
  _bot: Bot,
  comment: Comment,
  post: Post,
): Promise<void> {
  const freshPost = postStore.getPost(post.post_id) ?? post
  if (isCommentSyncBlockedByBooking(freshPost, 'max')) {
    logger.debug('[telegramThreadReplySync] skip admin MAX→TG: post booked elsewhere', {
      commentId: comment.comment_id,
      postId: freshPost.post_id,
      bookedBy: freshPost.comments_booked_by,
    })
    return
  }

  const freshComment = commentStore.getComment(comment.comment_id) ?? comment
  const maxReply = commentStore.latestMaxAdminReply(freshComment)
  if (!maxReply) {
    return
  }

  const replyText = maxReply.text.trim()
  if (!replyText) {
    return
  }

  if (freshComment.tg_thread_reply_id) {
    return
  }

  const guardKey = `max-reply:${freshComment.comment_id}:${replyText}`
  if (isCommentSynced(guardKey)) {
    return
  }

  if (freshComment.booked_in_max_tg) {
    markCommentSynced(guardKey)
    commentStore.markTelegramThreadReplyHandled(freshComment.comment_id)
    return
  }

  const target = await resolvePostThreadTarget(post.message_mid)
  if (!target) {
    const mapping = findMappingByMaxMid(post.message_mid)
    const logPayload = {
      commentId: freshComment.comment_id,
      messageMid: post.message_mid,
      chainId: mapping?.chain_id ?? null,
      tgThreadChatId: mapping?.tg_thread_chat_id ?? null,
      tgThreadMsgId: mapping?.tg_thread_msg_id ?? null,
    }
    if (!mapping) {
      logger.debug('[telegramThreadReplySync] skip admin MAX→TG: post not linked to Telegram', logPayload)
    } else {
      logger.warn('[telegramThreadReplySync] no thread mapping for post', logPayload)
    }
    return
  }

  if (isDiscussionChatBlocked(target.threadChatId)) {
    logger.debug('[telegramThreadReplySync] skip admin MAX→TG: discussion chat blocked', {
      commentId: freshComment.comment_id,
      threadChatId: target.threadChatId,
    })
    return
  }

  const { token, threadChatId } = target

  // TG→MAX / VK→MAX: ответы идут только в miniapp, в Telegram ничего не отправляем.
  if (freshComment.source === 'telegram' || freshComment.source === 'vk') {
    markCommentSynced(guardKey)
    commentStore.markTelegramThreadReplyHandled(freshComment.comment_id)
    logger.info('[telegramThreadReplySync] skipped outbound TG reply for TG-origin comment', {
      commentId: freshComment.comment_id,
    })
    return
  }

  // MAX→TG: сначала убедимся, что комментарий уже в TG-треде.
  let commentForMark = commentStore.getComment(freshComment.comment_id) ?? freshComment
  if (!commentForMark.tg_comment_id) {
    await syncMaxCommentToTelegramThread(_bot, commentForMark, post)
    commentForMark = commentStore.getComment(freshComment.comment_id) ?? commentForMark
  }

  // MAX→TG: правим исходное сообщение, текст ответа в TG не отправляем.
  if (commentForMark.tg_comment_id) {
    const tgMessageText = buildMaxCommentTelegramText(commentForMark)
    const marked = await markTelegramCommentAnsweredInMax(
      token,
      threadChatId,
      commentForMark.tg_comment_id,
      tgMessageText,
      {
        messageThreadId: target.threadMsgId,
        commentId: commentForMark.comment_id,
      },
    )
    if (marked) {
      markCommentSynced(guardKey)
      commentStore.markTelegramThreadReplyHandled(freshComment.comment_id)
      logger.info('[telegramThreadReplySync] marked MAX comment as booked in MAX (TG edit only)', {
        commentId: freshComment.comment_id,
        tgCommentId: commentForMark.tg_comment_id,
        threadChatId,
      })
    } else {
      logger.warn('[telegramThreadReplySync] could not mark MAX comment in TG thread', {
        commentId: freshComment.comment_id,
        tgCommentId: commentForMark.tg_comment_id,
        threadChatId,
      })
    }
    return
  }

  const { threadMsgId: mappingThreadMsgId } = target
  let replyToId = mappingThreadMsgId

  try {
    const tgMsgId = await deliverTelegramThreadMessageWithRetry(
      post.message_mid,
      target,
      replyText,
      replyToId,
      true,
      `${MAX_REPLY_TG_PREFIX} ${replyText}`,
    )
    if (tgMsgId == null) {
      return
    }

    markCommentSynced(`tg:${tgMsgId}`)
    markCommentSynced(guardKey)
    commentStore.setTgThreadReplyId(freshComment.comment_id, tgMsgId)

    logger.info('[telegramThreadReplySync] delivered admin reply to TG thread (fallback)', {
      commentId: freshComment.comment_id,
      tgMsgId,
      threadChatId,
      replyToId,
    })
  } catch (err: unknown) {
    await handleDiscussionSendForbidden(target, freshComment.comment_id, err)
  }
}
