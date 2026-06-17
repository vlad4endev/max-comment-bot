/**
 * telegramThreadReplySync.ts
 *
 * MAX miniapp → TG discussion group: пользовательские комментарии и ответы админа.
 */

import type { Bot } from '@maxhub/max-bot-api'
import axios from 'axios'

import { listTgChainsSync } from '../api/adminPanelState'
import type { Comment } from './commentStore'
import { commentStore } from './commentStore'
import { findMappingByMaxMid } from './postCommentMappingStore'
import type { Post } from './postStore'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import { isCommentSynced, markCommentSynced } from '../utils/commentSyncGuard'
import {
  MAX_ANSWERED_IN_MAX_MARKER,
  MAX_REPLY_TG_PREFIX,
  formatMaxCommentForTelegram,
  isTelegramCommentMarkedAnsweredInMax,
} from '../utils/commentSyncFilter'
import { logger } from '../utils/logger'
import {
  sendDiscussionMessageAsPeer,
  type DiscussionSendAsMode,
} from './telegramMtprotoDiscussionSender'
import type { PostCommentMappingRow } from './postCommentMappingStore'

const TG_API = 'https://api.telegram.org'

type ThreadTarget = {
  chainId: string
  token: string
  threadChatId: number
  threadMsgId: number
  channelKey: string | null
  sendAsMode: DiscussionSendAsMode
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
  const chain = listTgChainsSync().find((c) => c.id === mapping.chain_id)
  const fromChainId = chain?.tg_channel_id?.trim()
  if (fromChainId) {
    return fromChainId
  }
  const username = chain?.tg_username?.trim()
  if (username) {
    return username.startsWith('@') ? username : `@${username}`
  }
  if (typeof mapping.tg_chat_id === 'number') {
    return String(mapping.tg_chat_id)
  }
  return null
}

function resolvePostThreadTarget(messageMid: string): ThreadTarget | null {
  const mapping = findMappingByMaxMid(messageMid)
  if (!mapping?.tg_thread_chat_id || !mapping.tg_thread_msg_id) {
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

function buildMaxCommentTelegramText(comment: Comment): string {
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
      logger.warn('[telegramThreadReplySync] sendAs peer failed, fallback to bot', {
        chainId: target.chainId,
        sendAsMode: target.sendAsMode,
        channelKey: target.channelKey,
        err,
      })
    }
  }

  const botText = botFallbackText ?? text
  return sendTelegramThreadMessage(target.token, target.threadChatId, botText, replyToId)
}

async function sendTelegramThreadMessage(
  token: string,
  chatId: number,
  text: string,
  replyToMessageId: number,
): Promise<number | null> {
  const { data } = await axios.post<{
    ok: boolean
    description?: string
    result?: { message_id?: number }
  }>(
    `${TG_API}/bot${token}/sendMessage`,
    {
      chat_id: chatId,
      text,
      reply_to_message_id: replyToMessageId,
    },
    { timeout: 20_000 },
  )
  if (!data.ok) {
    throw new Error(data.description ?? 'Telegram sendMessage failed')
  }
  const messageId = data.result?.message_id
  return typeof messageId === 'number' ? messageId : null
}

async function tryEditTelegramMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
): Promise<boolean> {
  const { data } = await axios.post<{ ok: boolean; description?: string }>(
    `${TG_API}/bot${token}/editMessageText`,
    {
      chat_id: chatId,
      message_id: messageId,
      text,
    },
    { timeout: 20_000 },
  )
  if (!data.ok) {
    logger.debug('[telegramThreadReplySync] editMessageText not ok', {
      chatId,
      messageId,
      description: data.description,
    })
  }
  return data.ok === true
}

async function tryEditTelegramMessageCaption(
  token: string,
  chatId: number,
  messageId: number,
  caption: string,
): Promise<boolean> {
  const { data } = await axios.post<{ ok: boolean; description?: string }>(
    `${TG_API}/bot${token}/editMessageCaption`,
    {
      chat_id: chatId,
      message_id: messageId,
      caption,
    },
    { timeout: 20_000 },
  )
  return data.ok === true
}

async function trySetTelegramMessageReaction(
  token: string,
  chatId: number,
  messageId: number,
): Promise<boolean> {
  const { data } = await axios.post<{ ok: boolean; description?: string }>(
    `${TG_API}/bot${token}/setMessageReaction`,
    {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '✅' }],
    },
    { timeout: 20_000 },
  )
  return data.ok === true
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
): Promise<boolean> {
  const guardKey = `tg-marked-max:${tgCommentId}`
  if (isCommentSynced(guardKey)) {
    return true
  }

  const baseText = commentText.trim()
  if (!baseText || isTelegramCommentMarkedAnsweredInMax(baseText)) {
    markCommentSynced(guardKey)
    return true
  }

  const markedText = `${baseText}\n\n${MAX_ANSWERED_IN_MAX_MARKER}`

  try {
    const edited =
      (await tryEditTelegramMessageText(token, chatId, tgCommentId, markedText)) ||
      (await tryEditTelegramMessageCaption(token, chatId, tgCommentId, markedText))
    if (edited) {
      markCommentSynced(guardKey)
      logger.info('[telegramThreadReplySync] marked TG comment as answered in MAX (edit)', {
        tgCommentId,
        chatId,
      })
      return true
    }
  } catch (err: unknown) {
    logger.debug('[telegramThreadReplySync] edit TG comment for MAX answered mark failed', {
      tgCommentId,
      err,
    })
  }

  try {
    const reacted = await trySetTelegramMessageReaction(token, chatId, tgCommentId)
    if (reacted) {
      markCommentSynced(guardKey)
      logger.info('[telegramThreadReplySync] marked TG comment as answered in MAX (reaction)', {
        tgCommentId,
        chatId,
      })
      return true
    }
  } catch (err: unknown) {
    logger.warn('[telegramThreadReplySync] setMessageReaction failed', {
      tgCommentId,
      chatId,
      err,
    })
  }

  logger.warn('[telegramThreadReplySync] failed to mark TG comment as answered in MAX', {
    tgCommentId,
    chatId,
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
  const freshComment = commentStore.getComment(comment.comment_id) ?? comment
  if (freshComment.source === 'telegram' || freshComment.tg_comment_id) {
    return
  }

  const target = resolvePostThreadTarget(post.message_mid)
  if (!target) {
    logger.warn('[telegramThreadReplySync] no thread mapping for MAX comment', {
      commentId: freshComment.comment_id,
      messageMid: post.message_mid,
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
    const tgMsgId = await deliverTelegramThreadMessage(
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
    commentStore.setTgCommentId(freshComment.comment_id, tgMsgId)

    logger.info('[telegramThreadReplySync] delivered MAX comment to TG thread', {
      commentId: freshComment.comment_id,
      tgMsgId,
      threadChatId: target.threadChatId,
      username: freshComment.username,
    })
  } catch (err: unknown) {
    logger.warn('[telegramThreadReplySync] send MAX comment failed', {
      commentId: freshComment.comment_id,
      threadChatId: target.threadChatId,
      err,
    })
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

  const target = resolvePostThreadTarget(post.message_mid)
  if (!target) {
    const mapping = findMappingByMaxMid(post.message_mid)
    logger.warn('[telegramThreadReplySync] no thread mapping for post', {
      commentId: freshComment.comment_id,
      messageMid: post.message_mid,
      chainId: mapping?.chain_id ?? null,
      tgThreadChatId: mapping?.tg_thread_chat_id ?? null,
      tgThreadMsgId: mapping?.tg_thread_msg_id ?? null,
    })
    return
  }

  const { token, threadChatId } = target

  // TG→MAX: ответы идут только TG→MAX, в Telegram ничего не отправляем.
  if (freshComment.source === 'telegram') {
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
    const tgMsgId = await deliverTelegramThreadMessage(
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
    logger.warn('[telegramThreadReplySync] sendMessage failed', {
      commentId: freshComment.comment_id,
      threadChatId,
      replyToId,
      err,
    })
  }
}
