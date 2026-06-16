/**
 * telegramThreadReplySync.ts
 *
 * Ответ администратора в Max miniapp → сообщение в TG discussion group.
 */

import type { Bot } from '@maxhub/max-bot-api'
import axios from 'axios'

import type { Comment } from './commentStore'
import { commentStore } from './commentStore'
import { findMappingByMaxMid } from './postCommentMappingStore'
import type { Post } from './postStore'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import { isCommentSynced, markCommentSynced } from '../utils/commentSyncGuard'
import { MAX_REPLY_TG_PREFIX } from '../utils/commentSyncFilter'
import { logger } from '../utils/logger'

const TG_API = 'https://api.telegram.org'

function latestAdminReplyText(comment: Comment): string | null {
  if (Array.isArray(comment.replies) && comment.replies.length > 0) {
    const last = comment.replies[comment.replies.length - 1]!
    return last.text.trim() || null
  }
  if (comment.reply?.text?.trim()) {
    return comment.reply.text.trim()
  }
  return null
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

/**
 * Отправляет последний ответ администратора в TG-тред, если есть маппинг поста.
 */
export async function syncAdminReplyToTelegramThread(
  _bot: Bot,
  comment: Comment,
  post: Post,
): Promise<void> {
  if (comment.source === 'telegram') {
    return
  }
  if (comment.tg_thread_reply_id) {
    return
  }

  const replyText = latestAdminReplyText(comment)
  if (!replyText) {
    return
  }

  const guardKey = `max-reply:${comment.comment_id}:${replyText}`
  if (isCommentSynced(guardKey)) {
    return
  }

  const mapping = findMappingByMaxMid(post.message_mid)
  if (!mapping?.tg_thread_chat_id || !mapping.tg_thread_msg_id) {
    logger.debug('[telegramThreadReplySync] no thread mapping for post', {
      commentId: comment.comment_id,
      messageMid: post.message_mid,
    })
    return
  }

  const token = resolveTelegramBotToken()
  if (!token) {
    return
  }

  let replyToId = mapping.tg_thread_msg_id
  if (comment.tg_comment_id) {
    replyToId = comment.tg_comment_id
  }

  try {
    const tgMsgId = await sendTelegramThreadMessage(
      token,
      mapping.tg_thread_chat_id,
      `${MAX_REPLY_TG_PREFIX} ${replyText}`,
      replyToId,
    )
    if (tgMsgId == null) {
      return
    }

    markCommentSynced(`tg:${tgMsgId}`)
    markCommentSynced(guardKey)
    commentStore.setTgThreadReplyId(comment.comment_id, tgMsgId)

    logger.info('[telegramThreadReplySync] delivered admin reply to TG thread', {
      commentId: comment.comment_id,
      tgMsgId,
      threadChatId: mapping.tg_thread_chat_id,
    })
  } catch (err: unknown) {
    logger.warn('[telegramThreadReplySync] sendMessage failed', {
      commentId: comment.comment_id,
      err,
    })
  }
}
