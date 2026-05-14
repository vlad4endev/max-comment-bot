import type { Bot } from '@maxhub/max-bot-api'
import express from 'express'

import { channelRegistry } from '../services/channelRegistry'
import type { Comment } from '../services/commentStore'
import { commentStore } from '../services/commentStore'
import {
  notifyAdminsNewMiniappComment,
  notifyUserAboutMiniappReply,
} from '../services/notificationService'
import { postStore } from '../services/postStore'
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

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const t = value.trim()
  return t === '' ? null : t
}

function toWireComment(c: Comment): {
  comment_id: string
  post_id: string
  user_id: number
  username: string
  text: string
  timestamp: string
  reply?: { text: string; timestamp: string }
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
    const chatId = parsePositiveInt(body.chat_id)
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
    const chatId = parsePositiveInt(body.chat_id)
    const adminText = parseNonEmptyString(body.admin_text)
    if (!commentId || !postId || !chatId || !adminText) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }

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

    const updated = commentStore.addReply(commentId, adminText)
    if (!updated) {
      res.status(404).json({ error: 'comment not found' })
      return
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
