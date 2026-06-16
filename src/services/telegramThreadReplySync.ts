/**
 * telegramThreadReplySync.ts
 *
 * Ответ администратора в Max miniapp → сообщение в TG discussion group.
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
  isTelegramCommentMarkedAnsweredInMax,
} from '../utils/commentSyncFilter'
import { logger } from '../utils/logger'

const TG_API = 'https://api.telegram.org'

function resolveTelegramBotTokenForChain(chainId: string): string {
  const chain = listTgChainsSync().find((c) => c.id === chainId)
  const fromChain = chain?.bot_token?.trim()
  if (fromChain) {
    return fromChain
  }
  return resolveTelegramBotToken()
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
 */
export async function markTelegramCommentAnsweredInMax(
  token: string,
  chatId: number,
  tgCommentId: number,
  commentText: string,
): Promise<void> {
  const guardKey = `tg-marked-max:${tgCommentId}`
  if (isCommentSynced(guardKey)) {
    return
  }

  const baseText = commentText.trim()
  if (!baseText || isTelegramCommentMarkedAnsweredInMax(baseText)) {
    markCommentSynced(guardKey)
    return
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
      return
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
      return
    }
  } catch (err: unknown) {
    logger.warn('[telegramThreadReplySync] setMessageReaction failed', {
      tgCommentId,
      chatId,
      err,
    })
  }
}

/**
 * Отправляет последний ответ администратора в TG-тред, если есть маппинг поста.
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

  const mapping = findMappingByMaxMid(post.message_mid)
  if (!mapping?.tg_thread_chat_id || !mapping.tg_thread_msg_id) {
    logger.warn('[telegramThreadReplySync] no thread mapping for post', {
      commentId: freshComment.comment_id,
      messageMid: post.message_mid,
      chainId: mapping?.chain_id ?? null,
      tgThreadChatId: mapping?.tg_thread_chat_id ?? null,
      tgThreadMsgId: mapping?.tg_thread_msg_id ?? null,
    })
    return
  }

  const token = resolveTelegramBotTokenForChain(mapping.chain_id)
  if (!token) {
    logger.warn('[telegramThreadReplySync] no Telegram bot token for chain', {
      commentId: freshComment.comment_id,
      chainId: mapping.chain_id,
    })
    return
  }

  const threadChatId = mapping.tg_thread_chat_id

  if (freshComment.tg_comment_id) {
    await markTelegramCommentAnsweredInMax(
      token,
      threadChatId,
      freshComment.tg_comment_id,
      freshComment.text,
    )
  }

  if (freshComment.tg_thread_reply_id) {
    return
  }

  const guardKey = `max-reply:${freshComment.comment_id}:${replyText}`
  if (isCommentSynced(guardKey)) {
    return
  }

  let replyToId = mapping.tg_thread_msg_id
  if (freshComment.tg_comment_id) {
    replyToId = freshComment.tg_comment_id
  }

  try {
    const tgMsgId = await sendTelegramThreadMessage(
      token,
      threadChatId,
      `${MAX_REPLY_TG_PREFIX} ${replyText}`,
      replyToId,
    )
    if (tgMsgId == null) {
      return
    }

    markCommentSynced(`tg:${tgMsgId}`)
    markCommentSynced(guardKey)
    commentStore.setTgThreadReplyId(freshComment.comment_id, tgMsgId)

    logger.info('[telegramThreadReplySync] delivered admin reply to TG thread', {
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
