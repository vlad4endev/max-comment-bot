import type { Bot } from '@maxhub/max-bot-api'
import { Keyboard } from '@maxhub/max-bot-api'
import express from 'express'

import { config } from '../config'
import { channelRegistry } from '../services/channelRegistry'
import { isUserChannelAdmin } from '../services/channelPostActions'
import type { Comment } from '../services/commentStore'
import { commentStore } from '../services/commentStore'
import {
  notifyAdminsNewMiniappComment,
  notifyUserAboutMiniappReply,
} from '../services/notificationService'
import { buildMiniAppUrl, isMiniAppOpenUrlConfigured, postStore } from '../services/postStore'
import { stateManager } from '../services/stateManager'
import {
  parseMiniappFeatureKey,
  userMiniappSettingsStore,
} from '../services/userMiniappSettingsStore'
import { logger } from '../utils/logger'

export interface CommentApiRouterDeps {
  bot: Bot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number.parseInt(value, 10)
    if (Number.isInteger(n) && n > 0) {
      return n
    }
  }
  return null
}

/** Channel / group chat ids are negative (e.g. -100…); reject 0 only. */
function parseNonZeroInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value !== 0) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number.parseInt(value, 10)
    if (Number.isInteger(n) && n !== 0) {
      return n
    }
  }
  return null
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const t = value.trim()
  return t === '' ? null : t
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }
  if (value === 'true' || value === '1') {
    return true
  }
  if (value === 'false' || value === '0') {
    return false
  }
  return null
}

async function listChannelChatIdsWhereUserIsAdmin(bot: Bot, userId: number): Promise<number[]> {
  const registered = channelRegistry
    .getAllChannels()
    .filter((c) => c.type === 'channel')
    .map((c) => c.chat_id)
  const flags = await Promise.all(
    registered.map(async (chatId) =>
      (await isUserChannelAdmin(bot, chatId, userId)) ? chatId : null,
    ),
  )
  return flags.filter((x): x is number => x !== null).sort((a, b) => a - b)
}

function toWireComment(c: Comment): {
  comment_id: string
  post_id: string
  user_id: number
  username: string
  text: string
  timestamp: string
  reply?: { text: string; timestamp: string; admin_name?: string }
} {
  return {
    comment_id: c.comment_id,
    post_id: c.post_id,
    user_id: c.user_id,
    username: c.username,
    text: c.text,
    timestamp: c.timestamp,
    reply: c.reply,
  }
}

/**
 * Express router for Mini App REST API (`/api/...`).
 */
export function createCommentApiRouter(deps: CommentApiRouterDeps): express.Router {
  const router = express.Router()
  router.use(express.json({ limit: '512kb' }))

  router.get('/stats', async (req, res) => {
    const userId = parsePositiveInt(req.query.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    try {
      const adminChannelIds = await listChannelChatIdsWhereUserIsAdmin(deps.bot, userId)
      let posts = 0
      const postIds = new Set<string>()
      for (const chatId of adminChannelIds) {
        const list = postStore.getPostsByChatId(chatId)
        posts += list.length
        for (const p of list) {
          postIds.add(p.post_id)
        }
      }
      const comments = commentStore.countForPostIds(postIds)
      res.json({
        channels: adminChannelIds.length,
        posts,
        comments,
        bot_nickname: config.BOT_NICKNAME,
      })
    } catch (err: unknown) {
      logger.error('GET /api/stats failed', { err })
      res.status(500).json({ error: 'internal error' })
    }
  })

  router.get('/channels', async (req, res) => {
    const userId = parsePositiveInt(req.query.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    try {
      const adminChannelIds = await listChannelChatIdsWhereUserIsAdmin(deps.bot, userId)
      const channels = await Promise.all(
        adminChannelIds.map(async (chatId) => {
          const reg = channelRegistry.getChannel(chatId)
          let subscribers: number | null = null
          try {
            const chat = await deps.bot.api.getChat(chatId)
            const raw = (chat as { participants_count?: unknown }).participants_count
            if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
              subscribers = raw
            }
          } catch {
            subscribers = null
          }
          const pending = stateManager.isChannelPendingAdminRights(chatId)
          return {
            chat_id: chatId,
            title: reg?.title ?? null,
            subscribers,
            status: pending ? ('pending' as const) : ('active' as const),
          }
        }),
      )
      res.json({ channels, bot_nickname: config.BOT_NICKNAME })
    } catch (err: unknown) {
      logger.error('GET /api/channels failed', { err })
      res.status(500).json({ error: 'internal error' })
    }
  })

  router.get('/settings', (req, res) => {
    const userId = parsePositiveInt(req.query.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    res.json(userMiniappSettingsStore.getMerged(userId))
  })

  router.post('/settings', (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const userId = parsePositiveInt(body.user_id)
    const feature = parseMiniappFeatureKey(body.feature)
    const enabled = parseBoolean(body.enabled)
    if (!userId || !feature || enabled === null) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }
    const next = userMiniappSettingsStore.setFeature(userId, feature, enabled)
    res.json(next)
  })

  router.get('/post/:postId', (req, res) => {
    const post = postStore.getPost(req.params.postId)
    if (!post) {
      res.status(404).json({ error: 'post not found' })
      return
    }
    const channel = channelRegistry.getChannel(post.chat_id)
    res.json({
      post_id: post.post_id,
      text: post.text,
      photo_url: post.photo_url ?? null,
      chat_id: post.chat_id,
      comment_count: post.comment_count,
      channel_title: channel?.title ?? null,
    })
  })

  router.get('/comments/:postId', (req, res) => {
    const list = commentStore.getComments(req.params.postId).map(toWireComment)
    res.json(list)
  })

  router.post('/comment', async (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const postId = parseNonEmptyString(body.post_id)
    const chatId = parseNonZeroInt(body.chat_id)
    const userId = parsePositiveInt(body.user_id)
    const username = parseNonEmptyString(body.username)
    const text = parseNonEmptyString(body.text)
    if (!postId || !chatId || !userId || !username || !text) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }

    const post = postStore.getPost(postId)
    if (!post || post.chat_id !== chatId) {
      res.status(404).json({ error: 'post not found' })
      return
    }

    const saved = commentStore.saveComment({
      post_id: postId,
      user_id: userId,
      username,
      text,
    })

    const newCount = postStore.incrementCommentCount(postId)
    if (newCount === null) {
      res.status(500).json({ error: 'post update failed' })
      return
    }
    const updatedPost = postStore.getPost(postId)
    if (updatedPost) {
      await postStore.updateButtonCaption(deps.bot, updatedPost)
    }

    const channelTitle = channelRegistry.getChannel(chatId)?.title ?? '—'
    try {
      await notifyAdminsNewMiniappComment(deps.bot, {
        commentId: saved.comment_id,
        channelChatId: chatId,
        postText: post.text,
        channelTitle,
        username,
        commentText: text,
        postId,
      })
    } catch (err: unknown) {
      logger.warn('POST /api/comment: notify admins failed', { err })
    }

    res.json({ comment_id: saved.comment_id, timestamp: saved.timestamp })
  })

  router.post('/reply', async (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const commentId = parseNonEmptyString(body.comment_id)
    const postId = parseNonEmptyString(body.post_id)
    const chatId = parseNonZeroInt(body.chat_id)
    const adminText = parseNonEmptyString(body.admin_text)
    if (!commentId || !postId || !chatId || !adminText) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }
    const rawAdminName =
      typeof body.admin_name === 'string' ? body.admin_name.trim() : ''
    const replierName = rawAdminName || 'Админ'

    const post = postStore.getPost(postId)
    if (!post || post.chat_id !== chatId) {
      res.status(404).json({ error: 'post not found' })
      return
    }

    const existing = commentStore.getComment(commentId)
    if (!existing || existing.post_id !== postId) {
      res.status(404).json({ error: 'comment not found' })
      return
    }

    const updated = commentStore.addReply(commentId, adminText, rawAdminName || undefined)
    if (!updated) {
      res.status(404).json({ error: 'comment not found' })
      return
    }

    const mids = commentStore.getNotificationMids(commentId)
    const originalText = updated.notification_text
    if (mids.length > 0 && originalText && isMiniAppOpenUrlConfigured()) {
      const replyPreview = adminText.slice(0, 80)
      const ellipsis = adminText.length > 80 ? '...' : ''
      const statusLine = `\n\n✅ Ответил ${replierName}: «${replyPreview}${ellipsis}»`
      const updatedText = `${originalText}${statusLine}`
      const miniAppUrl = buildMiniAppUrl(postId, chatId, { admin: '1' })
      const kb = Keyboard.inlineKeyboard([[Keyboard.button.link('✅ Просмотрено', miniAppUrl)]])
      for (const { admin_id, message_mid } of mids) {
        try {
          await deps.bot.api.editMessage(message_mid, {
            text: updatedText,
            attachments: [kb],
          })
        } catch (e: unknown) {
          logger.warn('Could not update notification message', { admin_id, message_mid, e })
        }
      }
    } else if (mids.length > 0 && !originalText) {
      logger.warn('POST /api/reply: skip notification edit (missing notification_text)', { commentId })
    }

    await notifyUserAboutMiniappReply(deps.bot, {
      userId: updated.user_id,
      postText: post.text,
      userCommentText: updated.text,
      adminReplyText: adminText,
      postId,
      channelChatId: chatId,
    })

    res.json({ ok: true })
  })

  return router
}
