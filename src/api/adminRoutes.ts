import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Bot } from '@maxhub/max-bot-api'
import type { ChatMember } from '@maxhub/max-bot-api/types'
import express from 'express'

import { config } from '../config'
import { checkAdminAuth } from '../middleware/adminAuth'
import {
  fullyDisconnectRegisteredChannel,
  pruneRegisteredChannelsNotAccessibleByBot,
} from '../services/channelFullDisconnect'
import { getRecentAdminActivity } from '../services/adminActivityStore'
import { adminRuntimeSettingsStore } from '../services/adminRuntimeSettingsStore'
import { channelNotifyLinkStore } from '../services/channelNotifyLinkStore'
import { channelRegistry } from '../services/channelRegistry'
import { disabledAdminStore } from '../services/disabledAdminStore'
import { restartChannelPostPoller, runChannelPollerForChat } from '../services/channelPoller'
import { commentStore } from '../services/commentStore'
import { postStore } from '../services/postStore'
import { stateManager } from '../services/stateManager'
import { subscriberStore } from '../services/subscriberStore'
import { fullyRemoveUserFromBot } from '../services/userAccessCleanup'
import { userMiniappSettingsStore } from '../services/userMiniappSettingsStore'
import {
  adminPanelCredentialsMatch,
  adminPanelLogoutCookieHeader,
  adminPanelSessionCookieHeader,
} from '../utils/adminPanelSession'
import { getAdminLogTail, logger } from '../utils/logger'

const RUNTIME_LOG_PATH = join(process.cwd(), 'data', 'runtime.log')

export interface AdminRouterDeps {
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

function isChannelAdminOrOwnerMember(m: ChatMember): boolean {
  return !m.is_bot && (m.is_admin || m.is_owner)
}

async function listChannelAdminsShort(bot: Bot, chatId: number): Promise<ChatMember[]> {
  try {
    const { members } = await bot.api.getChatAdmins(chatId)
    const admins = members.filter(isChannelAdminOrOwnerMember)
    if (admins.length > 0) {
      return [...new Map(admins.map((m) => [m.user_id, m])).values()].sort(
        (a, b) => a.user_id - b.user_id,
      )
    }
  } catch (err: unknown) {
    logger.warn('admin listChannelAdminsShort: getChatAdmins failed', { chatId, err })
  }
  return []
}

const REL_CHANNEL_ADMIN = 'Админ канала'
const REL_COMMENT_NOTIFY = 'Уведомления о комментариях'

function latestUsernameFromComments(userId: number): string | null {
  for (const c of commentStore.listAllCommentsNewestFirst()) {
    if (c.user_id === userId) {
      const u = c.username.trim()
      if (u !== '') {
        return u
      }
    }
  }
  return null
}

async function resolveDisplayNameFromMax(
  bot: Bot,
  userId: number,
  channelChatIds: number[],
): Promise<string | null> {
  const ordered = [...new Set(channelChatIds)]
  for (const chatId of ordered) {
    try {
      const { members } = await bot.api.getChatMembers(chatId, { user_ids: [userId] })
      const m = members[0]
      const n = m?.name?.trim()
      if (n) {
        return n
      }
    } catch (err: unknown) {
      logger.debug('admin /users: getChatMembers for display name failed', { chatId, userId, err })
    }
  }
  const priv = stateManager.getUserPrivateChatId(userId)
  if (priv !== undefined) {
    try {
      const { members } = await bot.api.getChatMembers(priv, { user_ids: [userId] })
      const n = members[0]?.name?.trim()
      if (n) {
        return n
      }
    } catch (err: unknown) {
      logger.debug('admin /users: getChatMembers private for display name failed', {
        priv,
        userId,
        err,
      })
    }
  }
  return null
}

export function createAdminRouter(deps: AdminRouterDeps): express.Router {
  const router = express.Router()
  router.use(express.json({ limit: '256kb' }))

  const secureCookie = config.NODE_ENV === 'production'
  const sessionMaxAgeSec = 7 * 24 * 60 * 60

  router.post('/panel-login', (req, res) => {
    const body = req.body
    const username = isRecord(body) ? parseNonEmptyString(body.username) : null
    const password = isRecord(body) ? parseNonEmptyString(body.password) : null
    if (!username || !password) {
      res.status(400).json({ error: 'invalid credentials' })
      return
    }
    if (
      !adminPanelCredentialsMatch(
        username,
        password,
        config.adminPanelUser,
        config.adminPanelPassword,
      )
    ) {
      res.status(401).json({ error: 'invalid credentials' })
      return
    }
    res.setHeader(
      'Set-Cookie',
      adminPanelSessionCookieHeader(config.adminPanelSessionSecret, sessionMaxAgeSec, secureCookie),
    )
    res.json({ ok: true })
  })

  router.post('/panel-logout', (_req, res) => {
    res.setHeader('Set-Cookie', adminPanelLogoutCookieHeader(secureCookie))
    res.json({ ok: true })
  })

  const secured = express.Router()
  secured.use(checkAdminAuth)

  secured.get('/settings', (_req, res) => {
    res.json({
      poll_interval_sec: adminRuntimeSettingsStore.getPollIntervalMs() / 1000,
      bot_nickname: config.BOT_NICKNAME,
      mini_app_url: config.miniAppUrl ?? null,
      admin_panel_user: config.adminPanelUser,
    })
  })

  secured.get('/stats', async (_req, res) => {
    await pruneRegisteredChannelsNotAccessibleByBot(deps.bot)
    const channels = channelRegistry.getAllChannels().filter((c) => c.type === 'channel')
    res.json({
      channel_count: channels.length,
      bot_subscribers: subscriberStore.getAllSubscribers().length,
      comment_count: commentStore.totalCount,
      post_count: postStore.getTotalPostCount(),
    })
  })

  secured.get('/channels', async (_req, res) => {
    const snapshot = [...channelRegistry.getAllChannels()].filter((c) => c.type === 'channel')
    const rows: {
      chat_id: number
      title: string | null
      type: (typeof snapshot)[0]['type']
      subscribers: number | null
      post_count: number
      comment_count: number
      date_added: string
      status: 'pending' | 'active'
    }[] = []
    for (const c of snapshot) {
      if (channelRegistry.getChannel(c.chat_id) === null) {
        continue
      }
      let subscribers: number | null = null
      try {
        const chat = await deps.bot.api.getChat(c.chat_id)
        const raw = (chat as { participants_count?: unknown }).participants_count
        if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
          subscribers = raw
        }
      } catch (err: unknown) {
        logger.warn('admin GET /channels: getChat failed, pruning channel', { chatId: c.chat_id, err })
        await fullyDisconnectRegisteredChannel(deps.bot, c.chat_id, 'registry_stale_removed')
        continue
      }
      const posts = postStore.getPostsByChatId(c.chat_id)
      const postIds = new Set(posts.map((p) => p.post_id))
      const commentCount = commentStore.countForPostIds(postIds)
      const pending = stateManager.isChannelPendingAdminRights(c.chat_id)
      rows.push({
        chat_id: c.chat_id,
        title: c.title,
        type: c.type,
        subscribers,
        post_count: posts.length,
        comment_count: commentCount,
        date_added: c.date_added,
        status: pending ? 'pending' : 'active',
      })
    }
    res.json({ channels: rows })
  })

  secured.get('/activity', (_req, res) => {
    res.json({ events: getRecentAdminActivity(10) })
  })

  secured.get('/users', async (_req, res) => {
    await pruneRegisteredChannelsNotAccessibleByBot(deps.bot)
    const ownerId = config.ownerUserId
    const channels = channelRegistry.getAllChannels().filter((ch) => ch.type === 'channel')

    type Row = {
      user_id: number
      name: string | null
      role: 'owner' | 'admin' | 'subscriber'
      linkByChatId: Map<number, { title: string | null; relations: Set<string> }>
      registered_at: string | null
      is_subscriber: boolean
      has_miniapp_settings: boolean
    }

    const byUser = new Map<number, Row>()

    function touch(userId: number): Row {
      let row = byUser.get(userId)
      if (!row) {
        row = {
          user_id: userId,
          name: null,
          role: 'subscriber',
          linkByChatId: new Map(),
          registered_at: null,
          is_subscriber: false,
          has_miniapp_settings: false,
        }
        byUser.set(userId, row)
      }
      return row
    }

    function rowAddLinkRelation(row: Row, chatId: number, title: string | null, relation: string): void {
      let cell = row.linkByChatId.get(chatId)
      if (!cell) {
        cell = { title, relations: new Set() }
        row.linkByChatId.set(chatId, cell)
      }
      if (title) {
        cell.title = cell.title ?? title
      }
      cell.relations.add(relation)
    }

    for (const uid of userMiniappSettingsStore.getAllUserIdsWithSettings()) {
      touch(uid).has_miniapp_settings = true
    }

    for (const uid of subscriberStore.getAllSubscribers()) {
      const row = touch(uid)
      row.is_subscriber = true
    }

    for (const ch of channels) {
      let admins: ChatMember[] = []
      try {
        admins = await listChannelAdminsShort(deps.bot, ch.chat_id)
      } catch (err: unknown) {
        logger.warn('admin /users: channel admins failed', { chatId: ch.chat_id, err })
      }
      for (const m of admins) {
        const row = touch(m.user_id)
        if (m.name) {
          row.name = row.name ?? m.name
        }
        rowAddLinkRelation(row, ch.chat_id, ch.title, REL_CHANNEL_ADMIN)
        if (m.user_id === ownerId) {
          row.role = 'owner'
        } else if (row.role !== 'owner') {
          row.role = 'admin'
        }
      }
    }

    for (const link of channelNotifyLinkStore.getAllLinks()) {
      const row = touch(link.user_id)
      const title = channelRegistry.getChannel(link.channel_chat_id)?.title ?? null
      rowAddLinkRelation(row, link.channel_chat_id, title, REL_COMMENT_NOTIFY)
      row.is_subscriber = row.is_subscriber || subscriberStore.hasSubscriber(link.user_id)
      if (row.registered_at === null) {
        row.registered_at = link.joined_at
      } else if (link.joined_at.localeCompare(row.registered_at) < 0) {
        row.registered_at = link.joined_at
      }
    }

    for (const row of byUser.values()) {
      if (row.user_id === ownerId) {
        row.role = 'owner'
      }
    }

    const rows = [...byUser.values()]
    for (const row of rows) {
      const chatIdsForName = [...row.linkByChatId.keys()].sort((a, b) => a - b)
      const existing = row.name?.trim()
      if (!existing) {
        const fromMax = await resolveDisplayNameFromMax(deps.bot, row.user_id, chatIdsForName)
        if (fromMax) {
          row.name = fromMax
        }
      }
      if (!row.name?.trim()) {
        const fromComments = latestUsernameFromComments(row.user_id)
        if (fromComments) {
          row.name = fromComments
        }
      }
    }

    const out = rows.map((row) => {
      const channel_links = [...row.linkByChatId.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([chat_id, v]) => ({
          chat_id,
          channel_title: v.title,
          relations: [...v.relations].sort((x, y) => x.localeCompare(y, 'ru')),
        }))

      let context_hint: string | null = null
      if (row.linkByChatId.size === 0) {
        if (row.is_subscriber) {
          context_hint =
            'Подписчик бота (/start): привязка к каналу в боте не найдена (уведомления не включены или канал отключён)'
        } else if (row.has_miniapp_settings) {
          context_hint =
            'Открывали настройки мини-приложения: канал не привязан (нет ссылки уведомлений и нет прав админа в подключённых каналах)'
        }
      }

      return {
        user_id: row.user_id,
        name: row.name,
        role: row.role,
        /** @deprecated Используйте channel_links; оставлено для совместимости */
        channels: channel_links.map((l) => ({ chat_id: l.chat_id, title: l.channel_title })),
        channel_links,
        context_hint,
        registered_at: row.registered_at,
        avatar_url: null as string | null,
      }
    })

    out.sort((a, b) => a.user_id - b.user_id)
    res.json({ users: out })
  })

  secured.get('/comments', (req, res) => {
    const chatId = parseNonZeroInt(req.query.chat_id)
    if (chatId === null) {
      res.status(400).json({ error: 'missing or invalid chat_id' })
      return
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''
    let list = commentStore.listCommentsForChannelChatId(chatId)
    if (q !== '') {
      list = list.filter(
        (c) =>
          c.text.toLowerCase().includes(q) ||
          c.username.toLowerCase().includes(q) ||
          c.post_id.toLowerCase().includes(q),
      )
    }
    const wired = list.map((c) => {
      const post = postStore.getPost(c.post_id)
      const postPreview = post?.text?.trim() ?? c.post_id
      return {
        comment_id: c.comment_id,
        post_id: c.post_id,
        post_preview: postPreview,
        user_id: c.user_id,
        username: c.username,
        text: c.text,
        reply: c.reply,
        timestamp: c.timestamp,
      }
    })
    res.json({ comments: wired })
  })

  secured.post('/comments/delete', async (req, res) => {
    const body = req.body
    const id = isRecord(body) ? parseNonEmptyString(body.comment_id) : null
    if (!id) {
      res.status(400).json({ error: 'invalid comment_id' })
      return
    }
    const removed = commentStore.deleteComment(id)
    if (!removed) {
      res.status(404).json({ error: 'not found' })
      return
    }
    void postStore.decrementCommentCount(removed.post_id)
    const post = postStore.getPost(removed.post_id)
    if (post) {
      try {
        await postStore.updateButtonCaption(deps.bot, post)
      } catch {
        /* ignore */
      }
    }
    res.json({ ok: true })
  })

  secured.get('/logs', async (req, res) => {
    const levelRaw = typeof req.query.level === 'string' ? req.query.level.toUpperCase() : ''
    const level =
      levelRaw === 'INFO' || levelRaw === 'WARN' || levelRaw === 'ERROR' ? levelRaw : null

    let lines = getAdminLogTail(500)
    try {
      const file = await readFile(RUNTIME_LOG_PATH, 'utf8')
      const fromFile = file.split(/\r?\n/).filter((l) => l.trim() !== '')
      if (fromFile.length > lines.length) {
        lines = fromFile.slice(-500)
      }
    } catch {
      /* use memory */
    }
    if (level) {
      lines = lines.filter((l) => l.includes(` [${level}] `))
    }
    const last = lines.slice(-100)
    res.json({ lines: last })
  })

  secured.post('/refresh-buttons', async (req, res) => {
    const body = req.body
    const chatId = isRecord(body) ? parseNonZeroInt(body.chat_id) : null
    if (chatId === null) {
      res.status(400).json({ error: 'invalid chat_id' })
      return
    }
    try {
      await runChannelPollerForChat(deps.bot, chatId)
      res.json({ ok: true })
    } catch (err: unknown) {
      logger.error('admin refresh-buttons', err)
      res.status(500).json({ error: 'failed' })
    }
  })

  secured.post('/remove-channel', async (req, res) => {
    const body = req.body
    const chatId = isRecord(body) ? parseNonZeroInt(body.chat_id) : null
    if (chatId === null) {
      res.status(400).json({ error: 'invalid chat_id' })
      return
    }
    await fullyDisconnectRegisteredChannel(deps.bot, chatId, 'manual_admin_panel')
    res.json({ ok: true })
  })

  secured.post('/settings', async (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const raw = body.poll_interval
    let seconds: number | null = null
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      seconds = raw
    } else if (typeof raw === 'string' && raw.trim() !== '') {
      seconds = Number.parseFloat(raw)
    }
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
      res.status(400).json({ error: 'invalid poll_interval (seconds)' })
      return
    }
    const ms = Math.round(seconds * 1000)
    const applied = await adminRuntimeSettingsStore.setPollIntervalMs(ms)
    restartChannelPostPoller(deps.bot)
    res.json({
      ok: true,
      poll_interval_ms: applied,
      poll_interval_sec: applied / 1000,
    })
  })

  secured.post('/reset', (req, res) => {
    const body = req.body
    const target =
      isRecord(body) && body.target === 'posts'
        ? 'posts'
        : isRecord(body) && body.target === 'subscribers'
          ? 'subscribers'
          : null
    if (!target) {
      res.status(400).json({ error: 'target must be posts | subscribers' })
      return
    }
    if (target === 'posts') {
      postStore.clearAllPosts()
      commentStore.clearAllComments()
    } else {
      subscriberStore.clearAllSubscribers()
    }
    res.json({ ok: true })
  })

  secured.post('/users/remove', (req, res) => {
    const body = req.body
    const userId = isRecord(body) ? parsePositiveInt(body.user_id) : null
    if (!userId) {
      res.status(400).json({ error: 'invalid user_id' })
      return
    }
    if (userId === config.ownerUserId) {
      res.status(400).json({ error: 'cannot remove owner' })
      return
    }
    disabledAdminStore.disableUser(userId)
    fullyRemoveUserFromBot(userId)
    res.json({ ok: true })
  })

  router.use(secured)

  return router
}
