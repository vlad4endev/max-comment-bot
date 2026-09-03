/**
 * tgCommentSyncService.ts
 *
 * Слушает новые сообщения из TG-треда обсуждения канала
 * и записывает их как комментарии в miniapp БД Max.
 *
 * Подключается к существующему polling-циклу tgChainForwarder.
 */

import type { Bot } from '@maxhub/max-bot-api'

import type { TgChainRecord } from '../api/adminPanelState'
import type { TgMessage } from '../forwarder/telegramReader'
import type { Comment } from './commentStore'
import { commentStore } from './commentStore'
import {
  notifyUserAboutMiniappReply,
  syncAdminCommentNotification,
} from './notificationService'
import { syncTelegramAdminCommentNotification } from './telegramAdminNotificationService'
import { channelRegistry } from './channelRegistry'
import {
  ensureMappingFromForwarded,
  findMappingByTgMsgId,
  findMappingByThreadMsgId,
  isChannelPostSkippedForForward,
  linkThreadMessageToChannelPost,
  type PostCommentMappingRow,
} from './postCommentMappingStore'
import { postStore } from './postStore'
import type { Post } from './postStore'
import { claimAndPropagateCommentsBooking } from './commentsBookingService'
import {
  isTelegramAntispamBotConfigured,
  tryBlockTelegramCommentByAntispam,
} from './telegramAntispamBotService'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import { isCommentSynced, markCommentSynced } from '../utils/commentSyncGuard'
import {
  isMaxAdminReplyInTelegram,
  isMaxCommentInTelegram,
  isTgCommentFromAdmin,
  collectCommentMappingHints,
  resolveDiscussionThreadRootMsgId,
  resolveTgCommentAuthor,
  shouldSyncTgCommentToMax,
} from '../utils/commentSyncFilter'
import { logger } from '../utils/logger'

export function isDiscussionAutoForward(message: TgMessage): boolean {
  return Boolean(
    message.is_automatic_forward ||
      message.forward_origin?.type === 'channel' ||
      (message.sender_chat && message.forward_from_message_id != null),
  )
}

/**
 * Связывает авто-репост канала в discussion group с post_comment_mapping.
 */
export function handleDiscussionAutoForward(message: TgMessage, chainId: string): void {
  const channelMsgId =
    message.forward_origin?.message_id ?? message.forward_from_message_id ?? null
  if (channelMsgId == null) {
    return
  }
  linkThreadMessageToChannelPost(chainId, channelMsgId, message.chat.id, message.message_id)
  logger.info('[tgCommentSync] linked discussion post', {
    chainId,
    channelMsgId,
    threadMsgId: message.message_id,
    threadChatId: message.chat.id,
  })
}

function listExistingReplyTexts(comment: Comment): string[] {
  const thread =
    Array.isArray(comment.replies) && comment.replies.length > 0
      ? comment.replies
      : comment.reply?.text?.trim()
        ? [comment.reply]
        : []
  return thread.map((r) => r.text.trim()).filter(Boolean)
}

/**
 * Реплай в TG на комментарий, известный в MAX (из TG или из miniapp):
 * пометка «отвечено в Telegram» в MAX, без исходящего сообщения в TG.
 */
async function handleTgReplyToMaxComment(
  message: TgMessage,
  parentComment: Comment,
  chain: TgChainRecord,
  bot: Bot,
  maxChatId: number,
  post: Post,
  tgCommentId: number,
  isAdmin: boolean,
): Promise<void> {
  const text = (message.text || message.caption || '').trim()
  if (text && (isMaxAdminReplyInTelegram(text) || isMaxCommentInTelegram(text))) {
    markCommentSynced(`tg:${tgCommentId}`)
    return
  }

  commentStore.markAnsweredInTelegram(parentComment.comment_id)

  if (!isAdmin || !text) {
    markCommentSynced(`tg:${tgCommentId}`)
    logger.info('[tgCommentSync] marked MAX comment as answered in Telegram', {
      chainId: chain.id,
      tgCommentId,
      parentCommentId: parentComment.comment_id,
      parentSource: parentComment.source ?? null,
      isAdmin,
    })
    return
  }

  if (listExistingReplyTexts(parentComment).includes(text)) {
    markCommentSynced(`tg:${tgCommentId}`)
    return
  }

  const channelTitle =
    channelRegistry.getChannel(maxChatId)?.title?.trim() || chain.max_title?.trim() || 'Канал'

  const updated = commentStore.addReply(
    parentComment.comment_id,
    text,
    channelTitle,
    [],
    'Telegram',
    true,
  )
  if (!updated) {
    markCommentSynced(`tg:${tgCommentId}`)
    return
  }

  markCommentSynced(`tg:${tgCommentId}`)
  markCommentSynced(`max-reply:${updated.comment_id}:${text}`)

  try {
    await syncAdminCommentNotification(bot, updated, post.post_id, maxChatId)
  } catch (err: unknown) {
    logger.warn('[tgCommentSync] sync MAX admin notification failed', {
      commentId: updated.comment_id,
      err,
    })
  }
  try {
    await syncTelegramAdminCommentNotification({
      comment: updated,
      postId: post.post_id,
      channelChatId: maxChatId,
      messageMid: post.message_mid,
    })
  } catch (err: unknown) {
    logger.warn('[tgCommentSync] sync TG admin notification failed', {
      commentId: updated.comment_id,
      err,
    })
  }
  try {
    await notifyUserAboutMiniappReply(bot, {
      userId: Number(updated.user_id),
      commentId: updated.comment_id,
      postText: post.text,
      userCommentText: updated.text,
      adminReplyText: text,
      postId: post.post_id,
      channelChatId: maxChatId,
    })
  } catch (err: unknown) {
    logger.warn('[tgCommentSync] notify user about TG admin reply failed', {
      commentId: updated.comment_id,
      err,
    })
  }

  logger.info('[tgCommentSync] synced TG admin reply to MAX comment', {
    chainId: chain.id,
    tgCommentId,
    parentCommentId: parentComment.comment_id,
    parentSource: parentComment.source ?? null,
    postId: post.post_id,
  })
}

export type TgCommentHandleResult = 'ok' | 'retry' | 'skip'

/**
 * Комментарий в TG discussion group → комментарий в miniapp.
 */
export async function handleTgComment(
  message: TgMessage,
  chain: TgChainRecord,
  bot: Bot,
  discussionChatId: number,
): Promise<TgCommentHandleResult> {
  if (!chain.forward_comments) {
    return 'skip'
  }

  try {
    if (!message.reply_to_message && !(typeof message.message_thread_id === 'number' && message.message_thread_id > 0)) {
      return 'skip'
    }

    const tgCommentId = message.message_id
    const threadRootMsgId = resolveDiscussionThreadRootMsgId(message)
    if (threadRootMsgId == null) {
      return 'skip'
    }

    if (isCommentSynced(`tg:${tgCommentId}`)) {
      return 'ok'
    }

    if (commentStore.findCommentByTgMessageId(tgCommentId)) {
      return 'ok'
    }

    if (!isTelegramAntispamBotConfigured()) {
      if (await tryBlockTelegramCommentByAntispam(message, chain, discussionChatId, tgCommentId)) {
        return 'skip'
      }
    }

    const hints = collectCommentMappingHints(message)
    if (hints.channelMsgIds.some((id) => isChannelPostSkippedForForward(chain.id, id))) {
      logger.info('[tgCommentSync] skip comment — channel post was not forwarded', {
        chainId: chain.id,
        tgCommentId,
        channelMsgIds: hints.channelMsgIds,
      })
      return 'skip'
    }

    let mapping: PostCommentMappingRow | null = null
    for (const threadId of hints.threadMsgIds) {
      const byThread = findMappingByThreadMsgId(chain.id, threadId)
      if (byThread?.max_mid) {
        mapping = byThread
        break
      }
    }
    if (!mapping?.max_mid) {
      for (const channelMsgId of hints.channelMsgIds) {
        const byChannel =
          findMappingByTgMsgId(chain.id, channelMsgId) ??
          ensureMappingFromForwarded(chain.id, channelMsgId)
        if (!byChannel?.max_mid) {
          continue
        }
        mapping = byChannel
        const threadMsgId = hints.threadMsgIds[0]
        if (threadMsgId) {
          linkThreadMessageToChannelPost(chain.id, channelMsgId, message.chat.id, threadMsgId)
          mapping = findMappingByTgMsgId(chain.id, channelMsgId) ?? byChannel
        }
        logger.info('[tgCommentSync] linked thread via channel msg fallback', {
          chainId: chain.id,
          channelMsgId,
          threadMsgId: threadMsgId ?? null,
        })
        break
      }
    }

    const maxChatId = resolveCanonicalChannelChatId(chain.max_chat_id) ?? chain.max_chat_id
    let post: Post | null = mapping?.max_mid
      ? postStore.findPostByChannelMessage(maxChatId, mapping.max_mid)
      : null

    const directReplyId = message.reply_to_message?.message_id ?? threadRootMsgId
    if (!post) {
      const parentComment = commentStore.findCommentByTgMessageId(directReplyId)
      if (parentComment) {
        post = postStore.getPost(parentComment.post_id)
      }
    }
    if (!post) {
      logger.debug('[tgCommentSync] no post mapping for thread', {
        chainId: chain.id,
        threadRootMsgId,
        tgCommentId,
        threadMsgIds: hints.threadMsgIds,
        channelMsgIds: hints.channelMsgIds,
      })
      return 'retry'
    }

    const tgToken = chain.bot_token?.trim() || resolveTelegramBotToken()
    if (!tgToken) {
      return 'retry'
    }

    const isAdmin = await isTgCommentFromAdmin(message, tgToken, chain, discussionChatId)

    if (directReplyId !== threadRootMsgId) {
      const parentComment = commentStore.findCommentByTgMessageId(directReplyId)
      if (parentComment) {
        await handleTgReplyToMaxComment(
          message,
          parentComment,
          chain,
          bot,
          maxChatId,
          post,
          tgCommentId,
          isAdmin,
        )
        return 'ok'
      }
    }

    const text = (message.text || message.caption || '').trim()
    if (!text) {
      return 'skip'
    }

    const shouldSync = await shouldSyncTgCommentToMax({
      message,
      chain,
      token: tgToken,
      discussionChatId,
      postCommentCount: post.comment_count,
      threadRootMsgId,
      commentsBookedBy: post.comments_booked_by ?? null,
      commentsBookedAt: post.comments_booked_at ?? null,
    })
    if (!shouldSync) {
      logger.debug('[tgCommentSync] skipped by filter', {
        chainId: chain.id,
        tgCommentId,
        postId: post.post_id,
      })
      return 'skip'
    }

    const { userId, username: authorName } = resolveTgCommentAuthor(
      message,
      chain,
      discussionChatId,
    )

    const saved = commentStore.saveTelegramThreadComment(
      {
        post_id: post.post_id,
        user_id: userId,
        username: authorName,
        text,
      },
      tgCommentId,
    )

    markCommentSynced(`max:${saved.comment_id}`)

    const claimed = await claimAndPropagateCommentsBooking(post.post_id, 'telegram', bot)
    if (claimed) {
      logger.info('[tgCommentSync] post booked by Telegram (cross-platform markers applied)', {
        chainId: chain.id,
        postId: post.post_id,
        tgCommentId,
      })
    }

    const newCount = postStore.incrementCommentCount(post.post_id)
    if (newCount !== null) {
      const updatedPost = postStore.getPost(post.post_id)
      if (updatedPost) {
        void postStore.updateButtonCaption(bot, updatedPost)
      }
    }

    logger.info('[tgCommentSync] synced TG comment to miniapp', {
      chainId: chain.id,
      tgCommentId,
      commentId: saved.comment_id,
      postId: post.post_id,
    })
    return 'ok'
  } catch (err: unknown) {
    logger.error('[tgCommentSync] unhandled error', err)
    return 'retry'
  }
}

