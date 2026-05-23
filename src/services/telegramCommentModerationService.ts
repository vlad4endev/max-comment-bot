import type { Bot } from '@maxhub/max-bot-api'
import axios from 'axios'

import { getTelegramToken } from '../config'
import { logger } from '../utils/logger'
import { profilePairingForPlatformUser } from './channelLinkAdminTeamSync'
import { isUserChannelAdmin } from './channelPostActions'
import { channelRegistry } from './channelRegistry'
import { commentStore } from './commentStore'
import { listTelegramChatAdministrators } from './integrationPlatformClient'
import {
  notifyUserAboutMiniappReply,
  syncAdminCommentNotification,
} from './notificationService'
import { postStore } from './postStore'
import {
  resolveTelegramSourceChannelsForMaxChat,
  syncTelegramAdminCommentNotification,
  TG_COMMENT_CALLBACK_PREFIX,
} from './telegramAdminNotificationService'

const TG_API = 'https://api.telegram.org'

interface PendingReply {
  commentId: string
  postId: string
  maxChatId: number
  expiresAt: number
}

const pendingRepliesByUser = new Map<number, PendingReply>()
const PENDING_REPLY_TTL_MS = 15 * 60 * 1000

function parseCommentCallbackData(data: string): { action: 'reply' | 'delete' | 'delete_yes' | 'cancel'; commentId: string } | null {
  const trimmed = data.trim()
  if (!trimmed.startsWith(TG_COMMENT_CALLBACK_PREFIX)) {
    return null
  }
  const rest = trimmed.slice(TG_COMMENT_CALLBACK_PREFIX.length)
  const m = /^(r|d|dy|cn):([0-9a-f-]{36})$/i.exec(rest)
  if (!m) {
    return null
  }
  const actionMap = { r: 'reply', d: 'delete', dy: 'delete_yes', cn: 'cancel' } as const
  const action = actionMap[m[1] as keyof typeof actionMap]
  if (!action) {
    return null
  }
  return { action, commentId: m[2] }
}

async function answerCallbackQuery(token: string, callbackId: string, text?: string): Promise<void> {
  await axios.post(
    `${TG_API}/bot${token}/answerCallbackQuery`,
  {
      callback_query_id: callbackId,
      ...(text ? { text, show_alert: text.length > 60 } : {}),
    },
    { timeout: 10_000 },
  )
}

async function sendBotMessage(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
): Promise<void> {
  await axios.post(
    `${TG_API}/bot${token}/sendMessage`,
    {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
    { timeout: 20_000 },
  )
}

async function isTelegramAdminOfLinkedChannel(
  token: string,
  telegramUserId: number,
  maxChatId: number,
): Promise<boolean> {
  for (const tgChannelId of resolveTelegramSourceChannelsForMaxChat(maxChatId)) {
    const admins = await listTelegramChatAdministrators(token, tgChannelId)
    if (admins.some((a) => a.userId === telegramUserId)) {
      return true
    }
  }
  return false
}

export async function canManageMaxCommentViaTelegram(
  bot: Bot,
  telegramUserId: number,
  maxChatId: number,
): Promise<boolean> {
  const pairing = profilePairingForPlatformUser('telegram', telegramUserId)
  if (pairing.max_user_id != null) {
    const isMaxAdmin = await isUserChannelAdmin(bot, maxChatId, pairing.max_user_id)
    if (isMaxAdmin) {
      return true
    }
  }
  const token = getTelegramToken()
  if (!token) {
    return false
  }
  return isTelegramAdminOfLinkedChannel(token, telegramUserId, maxChatId)
}

function resolveCommentContext(commentId: string): {
  comment: NonNullable<ReturnType<typeof commentStore.getComment>>
  post: NonNullable<ReturnType<typeof postStore.getPost>>
  maxChatId: number
} | null {
  const comment = commentStore.getComment(commentId)
  if (!comment) {
    return null
  }
  const post = postStore.getPost(comment.post_id)
  if (!post) {
    return null
  }
  return { comment, post, maxChatId: post.chat_id }
}

function setPendingReply(telegramUserId: number, pending: Omit<PendingReply, 'expiresAt'>): void {
  pendingRepliesByUser.set(telegramUserId, {
    ...pending,
    expiresAt: Date.now() + PENDING_REPLY_TTL_MS,
  })
}

function takePendingReply(telegramUserId: number): PendingReply | null {
  const pending = pendingRepliesByUser.get(telegramUserId)
  if (!pending) {
    return null
  }
  if (Date.now() > pending.expiresAt) {
    pendingRepliesByUser.delete(telegramUserId)
    return null
  }
  pendingRepliesByUser.delete(telegramUserId)
  return pending
}

function clearPendingReply(telegramUserId: number): void {
  pendingRepliesByUser.delete(telegramUserId)
}

async function performCommentDelete(
  bot: Bot,
  telegramUserId: number,
  commentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = resolveCommentContext(commentId)
  if (!ctx) {
    return { ok: false, error: 'Комментарий не найден' }
  }
  const allowed = await canManageMaxCommentViaTelegram(bot, telegramUserId, ctx.maxChatId)
  if (!allowed) {
    return { ok: false, error: 'Нет прав на удаление' }
  }

  const removed = commentStore.getComment(commentId)
  if (!removed) {
    return { ok: false, error: 'Комментарий не найден' }
  }

  commentStore.deleteComment(commentId)
  const newCount = postStore.decrementCommentCount(ctx.post.post_id)
  if (newCount !== null) {
    const updatedPost = postStore.getPost(ctx.post.post_id)
    if (updatedPost) {
      await postStore.updateButtonCaption(bot, updatedPost)
    }
  }

  await syncTelegramAdminCommentNotification({
    comment: removed,
    postId: ctx.post.post_id,
    channelChatId: ctx.maxChatId,
    messageMid: ctx.post.message_mid,
    deleted: true,
  })

  return { ok: true }
}

async function performCommentReply(
  bot: Bot,
  telegramUserId: number,
  commentId: string,
  replyText: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = replyText.trim()
  if (trimmed === '') {
    return { ok: false, error: 'Текст ответа пустой' }
  }

  const ctx = resolveCommentContext(commentId)
  if (!ctx) {
    return { ok: false, error: 'Комментарий не найден' }
  }
  const allowed = await canManageMaxCommentViaTelegram(bot, telegramUserId, ctx.maxChatId)
  if (!allowed) {
    return { ok: false, error: 'Нет прав на ответ' }
  }

  const channelReplyName = channelRegistry.getChannel(ctx.maxChatId)?.title?.trim() || 'Канал'
  const pairing = profilePairingForPlatformUser('telegram', telegramUserId)
  const replierName =
    pairing.max_user_id != null
      ? `администратор`
      : 'администратор Telegram'

  const updated = commentStore.addReply(
    commentId,
    trimmed,
    channelReplyName,
    [],
    replierName,
  )
  if (!updated) {
    return { ok: false, error: 'Не удалось сохранить ответ' }
  }

  try {
    await syncAdminCommentNotification(bot, updated, ctx.post.post_id, ctx.maxChatId)
  } catch (err: unknown) {
    logger.warn('performCommentReply: sync MAX admin notification failed', { commentId, err })
  }
  try {
    await syncTelegramAdminCommentNotification({
      comment: updated,
      postId: ctx.post.post_id,
      channelChatId: ctx.maxChatId,
      messageMid: ctx.post.message_mid,
    })
  } catch (err: unknown) {
    logger.warn('performCommentReply: sync TG admin notification failed', { commentId, err })
  }

  await notifyUserAboutMiniappReply(bot, {
    userId: Number(updated.user_id),
    commentId: updated.comment_id,
    postText: ctx.post.text,
    userCommentText: updated.text,
    adminReplyText: trimmed,
    postId: ctx.post.post_id,
    channelChatId: ctx.maxChatId,
  })

  return { ok: true }
}

export async function handleTelegramCommentModerationCallback(
  update: Record<string, unknown>,
  bot: Bot,
): Promise<boolean> {
  const cq = update.callback_query as Record<string, unknown> | undefined
  if (!cq) {
    return false
  }
  const data = typeof cq.data === 'string' ? cq.data.trim() : ''
  const parsed = parseCommentCallbackData(data)
  if (!parsed) {
    return false
  }

  const from = cq.from as Record<string, unknown> | undefined
  const telegramUserId = typeof from?.id === 'number' ? from.id : null
  const callbackId = typeof cq.id === 'string' ? cq.id : null
  if (telegramUserId == null || !callbackId) {
    return true
  }

  const token = getTelegramToken()
  if (!token) {
    return true
  }

  const ctx = resolveCommentContext(parsed.commentId)
  if (!ctx && parsed.action !== 'cancel') {
    try {
      await answerCallbackQuery(token, callbackId, 'Комментарий не найден')
    } catch {
      /* ignore */
    }
    return true
  }

  if (parsed.action === 'cancel') {
    clearPendingReply(telegramUserId)
    try {
      await answerCallbackQuery(token, callbackId)
    } catch {
      /* ignore */
    }
    return true
  }

  const allowed =
    ctx != null ? await canManageMaxCommentViaTelegram(bot, telegramUserId, ctx.maxChatId) : false
  if (!allowed) {
    try {
      await answerCallbackQuery(token, callbackId, 'Нет прав')
    } catch {
      /* ignore */
    }
    return true
  }

  if (parsed.action === 'reply') {
    setPendingReply(telegramUserId, {
      commentId: parsed.commentId,
      postId: ctx!.post.post_id,
      maxChatId: ctx!.maxChatId,
    })
    try {
      await answerCallbackQuery(token, callbackId)
    } catch {
      /* ignore */
    }
    await sendBotMessage(
      token,
      telegramUserId,
      '✍️ Напишите ответ на комментарий одним сообщением.\n\nОтмена: /cancel',
    )
    return true
  }

  if (parsed.action === 'delete') {
    try {
      await answerCallbackQuery(token, callbackId)
    } catch {
      /* ignore */
    }
    await sendBotMessage(token, telegramUserId, 'Удалить этот комментарий в MAX?', {
      inline_keyboard: [
        [
          { text: '✅ Да, удалить', callback_data: `${TG_COMMENT_CALLBACK_PREFIX}dy:${parsed.commentId}` },
          { text: 'Отмена', callback_data: `${TG_COMMENT_CALLBACK_PREFIX}cn:${parsed.commentId}` },
        ],
      ],
    })
    return true
  }

  if (parsed.action === 'delete_yes') {
    const result = await performCommentDelete(bot, telegramUserId, parsed.commentId)
    try {
      await answerCallbackQuery(token, callbackId, result.ok ? 'Комментарий удалён' : result.error)
    } catch {
      /* ignore */
    }
    if (result.ok) {
      await sendBotMessage(token, telegramUserId, '✅ Комментарий удалён в MAX.')
    }
    return true
  }

  return true
}

export async function tryHandleTelegramCommentModerationReply(
  bot: Bot,
  telegramUserId: number,
  text: string,
): Promise<boolean> {
  const trimmed = text.trim()
  if (trimmed === '/cancel' || trimmed === '/cancel@commentvmax_bot') {
    if (pendingRepliesByUser.has(telegramUserId)) {
      clearPendingReply(telegramUserId)
      const token = getTelegramToken()
      if (token) {
        await sendBotMessage(token, telegramUserId, 'Ответ отменён.')
      }
      return true
    }
    return false
  }

  const pending = takePendingReply(telegramUserId)
  if (!pending) {
    return false
  }

  const token = getTelegramToken()
  if (!token) {
    return true
  }

  const result = await performCommentReply(bot, telegramUserId, pending.commentId, trimmed)
  if (result.ok) {
    await sendBotMessage(token, telegramUserId, '✅ Ответ опубликован в MAX.')
  } else {
    await sendBotMessage(token, telegramUserId, `❌ ${result.error}`)
  }
  return true
}
