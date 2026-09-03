import type { Bot } from '@maxhub/max-bot-api'

import { logger } from '../utils/logger'
import { notifyAdminsNewMiniappComment } from './notificationService'
import { notifyTelegramAdminsNewMiniappComment } from './telegramAdminNotificationService'

export interface NewCommentAdminNotifyInput {
  commentId: string
  channelChatId: number
  postText: string
  channelTitle: string
  username: string
  commentText: string
  commentPhotoUrls?: string[]
  postId: string
  messageMid?: string
}

/**
 * DM админам канала о новом комментарии в MAX и в Telegram.
 * Один вход для Mini App, TG-треда и VK.
 */
export async function notifyAdminsAboutNewComment(
  bot: Bot,
  input: NewCommentAdminNotifyInput,
): Promise<void> {
  try {
    await notifyAdminsNewMiniappComment(bot, {
      commentId: input.commentId,
      channelChatId: input.channelChatId,
      postText: input.postText,
      channelTitle: input.channelTitle,
      username: input.username,
      commentText: input.commentText,
      commentPhotoUrls: input.commentPhotoUrls,
      postId: input.postId,
    })
  } catch (err: unknown) {
    logger.warn('notifyAdminsAboutNewComment: MAX notify failed', {
      commentId: input.commentId,
      err,
    })
  }

  try {
    await notifyTelegramAdminsNewMiniappComment(bot, {
      commentId: input.commentId,
      maxChannelChatId: input.channelChatId,
      postText: input.postText,
      channelTitle: input.channelTitle,
      username: input.username,
      commentText: input.commentText,
      commentPhotoUrls: input.commentPhotoUrls,
      postId: input.postId,
      messageMid: input.messageMid,
    })
  } catch (err: unknown) {
    logger.warn('notifyAdminsAboutNewComment: TG notify failed', {
      commentId: input.commentId,
      err,
    })
  }
}

