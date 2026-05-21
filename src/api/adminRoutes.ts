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
  resolveRegisteredChannelAccess,
} from '../services/channelFullDisconnect'
import { getRecentAdminActivity } from '../services/adminActivityStore'
import { adminRuntimeSettingsStore } from '../services/adminRuntimeSettingsStore'
import { channelNotifyLinkStore } from '../services/channelNotifyLinkStore'
import { channelRegistry } from '../services/channelRegistry'
import { disabledAdminStore } from '../services/disabledAdminStore'
import {
  RefreshButtonsError,
  restartChannelPostPoller,
  runChannelPollerForChat,
} from '../services/channelPoller'
import { ensurePostFromChannelMessage } from '../services/channelPostActions'
import { commentStore } from '../services/commentStore'
import { diagnosePostLinks } from '../services/postLinkDiagnostics'
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
import {
  countAntispamBlocksToday,
  createTgChain,
  deleteTgChain,
  getAntispamLog,
  getAntispamWords,
  getChannelExtras,
  listTgChains,
  saveAntispamWords,
  saveChannelExtras,
  updateTgChain,
} from './adminPanelState'
import { createAutopostRouter } from './autopostRoutes'
import { buildDashboardAnalytics, parseDashboardPeriodDays } from '../services/analyticsService'
import { parseAdminLogLine, type AdminLogEntry, type AdminLogLevel } from '../utils/adminLogFormat'
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

function extractChatAvatarUrl(chat: { icon?: { url?: unknown } | null | undefined }): string | null {
  const icon = chat.icon
  const iconRaw = icon && typeof icon === 'object' ? icon.url : undefined
  if (typeof iconRaw !== 'string') {
    return null
  }
  const trimmed = iconRaw.trim()
  return trimmed === '' ? null : trimmed
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

  secured.get('/dashboard', async (req, res) => {
    await pruneRegisteredChannelsNotAccessibleByBot(deps.bot)
    const periodDays = parseDashboardPeriodDays(req.query.days)
    const payload = buildDashboardAnalytics(periodDays)
    res.json(payload)
  })

  secured.get('/channels', async (_req, res) => {
    await pruneRegisteredChannelsNotAccessibleByBot(deps.bot)
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
      avatar_url: string | null
    }[] = []
    for (const c of snapshot) {
      if (channelRegistry.getChannel(c.chat_id) === null) {
        continue
      }
      const access = await resolveRegisteredChannelAccess(deps.bot, c.chat_id)
      if (access === 'chat_unreachable') {
        await fullyDisconnectRegisteredChannel(deps.bot, c.chat_id, 'registry_stale_removed')
        continue
      }
      if (access === 'bot_not_in_chat') {
        await fullyDisconnectRegisteredChannel(deps.bot, c.chat_id, 'removed_from_chat')
        continue
      }
      let subscribers: number | null = null
      let avatar_url: string | null = null
      try {
        const chat = await deps.bot.api.getChat(c.chat_id)
        avatar_url = extractChatAvatarUrl(chat)
        const raw = (chat as { participants_count?: unknown }).participants_count
        if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
          subscribers = raw
        }
      } catch (err: unknown) {
        logger.warn('admin GET /channels: getChat failed after access check', { chatId: c.chat_id, err })
        await fullyDisconnectRegisteredChannel(deps.bot, c.chat_id, 'registry_stale_removed')
        continue
      }
      const posts = postStore.getPostsByChatId(c.chat_id)
      const postIds = new Set(posts.map((p) => p.post_id))
      const commentCount = commentStore.countForPostIds(postIds)
      rows.push({
        chat_id: c.chat_id,
        title: c.title,
        type: c.type,
        subscribers,
        post_count: posts.length,
        comment_count: commentCount,
        date_added: c.date_added,
        status: access === 'ok' ? 'active' : 'pending',
        avatar_url,
      })
    }
    res.json({ channels: rows })
  })

  secured.get('/bot-status', (_req, res) => {
    res.json({ active: true, label: 'Бот активен' })
  })

  secured.get('/activity', (req, res) => {
    const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 15
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 15
    const raw = getRecentAdminActivity(limit)
    const events = raw.map((ev) => {
      const chatId =
        typeof ev.payload.chat_id === 'number'
          ? ev.payload.chat_id
          : typeof ev.payload.channel_chat_id === 'number'
            ? ev.payload.channel_chat_id
            : null
      const channelName =
        chatId !== null ? (channelRegistry.getChannel(chatId)?.title ?? `Канал ${chatId}`) : null
      let preview: string | null = null
      if (typeof ev.payload.text === 'string') {
        preview = ev.payload.text
      } else if (typeof ev.payload.username === 'string') {
        preview = ev.payload.username
      } else if (typeof ev.payload.user_id === 'number') {
        preview = `user ${ev.payload.user_id}`
      }
      return {
        type: ev.type,
        timestamp: ev.timestamp,
        channel_id: chatId,
        channel_name: channelName,
        preview,
        payload: ev.payload,
      }
    })
    res.json({ events })
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

  secured.get('/db-stats', (_req, res) => {
    try {
      const db = (require('../db/database') as { getDb: () => import('better-sqlite3').Database }).getDb()
      const posts = (db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n
      const pendingButtons = (db.prepare("SELECT COUNT(*) AS n FROM posts WHERE json_extract(data, '$.button_attach_pending') = 1").get() as { n: number }).n
      const channels = (db.prepare('SELECT COUNT(*) AS n FROM channels WHERE active = 1').get() as { n: number }).n
      const comments = (db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n
      const subscribers = (db.prepare('SELECT COUNT(*) AS n FROM subscribers').get() as { n: number }).n
      const retryQueueSize = (require('../services/commentButtonRetryQueue') as { getCommentButtonRetryQueueSize: () => number }).getCommentButtonRetryQueueSize()
      res.json({ posts, pending_buttons: pendingButtons, channels, comments, subscribers, retry_queue: retryQueueSize })
    } catch (err: unknown) {
      logger.error('admin /db-stats failed', err)
      res.status(500).json({ error: 'internal error' })
    }
  })

  secured.get('/logs', async (req, res) => {
    const levelRaw = typeof req.query.level === 'string' ? req.query.level.toUpperCase() : ''
    const levelFilter: AdminLogLevel | null =
      levelRaw === 'INFO' ||
      levelRaw === 'WARN' ||
      levelRaw === 'ERROR' ||
      levelRaw === 'DEBUG'
        ? levelRaw
        : null
    const filter =
      typeof req.query.filter === 'string' ? req.query.filter.trim().toLowerCase() : ''
    const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 200
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200

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

    let entries: AdminLogEntry[] = lines
      .map(parseAdminLogLine)
      .filter((e): e is AdminLogEntry => e !== null)

    if (levelFilter) {
      entries = entries.filter((e) => e.level === levelFilter)
    }
    if (filter) {
      entries = entries.filter((e) => {
        const hay = `${e.message} ${e.raw}`.toLowerCase()
        return hay.includes(filter)
      })
    }

    const slice = entries.slice(-limit)
    const stats = {
      total: slice.length,
      info: slice.filter((e) => e.level === 'INFO').length,
      warn: slice.filter((e) => e.level === 'WARN').length,
      error: slice.filter((e) => e.level === 'ERROR').length,
      debug: slice.filter((e) => e.level === 'DEBUG').length,
    }

    res.json({
      entries: slice,
      stats,
      lines: slice.map((e) => e.raw),
    })
  })

  secured.get('/channel/:chatId', async (req, res) => {
    const chatId = parseNonZeroInt(req.params.chatId)
    if (chatId === null) {
      res.status(400).json({ error: 'invalid chat_id' })
      return
    }
    const ch = channelRegistry.getChannel(chatId)
    if (!ch || ch.type !== 'channel') {
      res.status(404).json({ error: 'channel not found' })
      return
    }
    const access = await resolveRegisteredChannelAccess(deps.bot, chatId)
    if (access === 'chat_unreachable') {
      await fullyDisconnectRegisteredChannel(deps.bot, chatId, 'registry_stale_removed')
      res.status(404).json({ error: 'channel not found' })
      return
    }
    if (access === 'bot_not_in_chat') {
      await fullyDisconnectRegisteredChannel(deps.bot, chatId, 'removed_from_chat')
      res.status(404).json({ error: 'channel not found' })
      return
    }
    const posts = postStore.getPostsByChatId(chatId)
    const postIds = new Set(posts.map((p) => p.post_id))
    const comments = commentStore.listCommentsForChannelChatId(chatId).slice(0, 8).map((c) => {
      const post = postStore.getPost(c.post_id)
      const answered = Boolean(c.reply?.text)
      return {
        comment_id: c.comment_id,
        post_id: c.post_id,
        username: c.username,
        text: c.text,
        timestamp: c.timestamp,
        reply_status: answered ? ('answered' as const) : ('unanswered' as const),
        reply: answered
          ? {
              text: c.reply!.text,
              timestamp: c.reply!.timestamp,
              admin_name: c.reply!.admin_name ?? null,
            }
          : null,
        post_context: post
          ? {
              text: post.text,
              sender_name: post.sender_name ?? null,
              photo_url: post.photo_url ?? null,
              channel_post_url: post.channel_post_url ?? null,
              timestamp: post.timestamp,
            }
          : null,
      }
    })
    const extras = await getChannelExtras(chatId)
    const chains = (await listTgChains()).filter((c) => c.max_chat_id === chatId)
    let subscribers: number | null = null
    let avatar_url: string | null = null
    try {
      const chat = await deps.bot.api.getChat(chatId)
      avatar_url = extractChatAvatarUrl(chat)
      const raw = (chat as { participants_count?: unknown }).participants_count
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
        subscribers = raw
      }
    } catch {
      /* ignore */
    }
    res.json({
      channel: {
        chat_id: chatId,
        title: ch.title,
        status: access === 'ok' ? 'active' : 'pending',
        subscribers,
        post_count: posts.length,
        comment_count: commentStore.countForPostIds(postIds),
        date_added: ch.date_added,
        avatar_url,
      },
      recent_comments: comments,
      settings: extras,
      tg_chain: chains[0] ?? null,
    })
  })

  secured.post('/channel/:chatId/settings', async (req, res) => {
    const chatId = parseNonZeroInt(req.params.chatId)
    if (chatId === null || !isRecord(req.body)) {
      res.status(400).json({ error: 'invalid request' })
      return
    }
    const saved = await saveChannelExtras(chatId, req.body as Parameters<typeof saveChannelExtras>[1])
    res.json({ ok: true, settings: saved })
  })

  secured.get('/antispam/words', async (_req, res) => {
    const data = await getAntispamWords()
    const log = await getAntispamLog(200)
    res.json({
      global: data.global,
      byChannel: data.byChannel,
      rules: data.rules,
      blocked_today: countAntispamBlocksToday(log),
    })
  })

  secured.post('/antispam/words', async (req, res) => {
    if (!isRecord(req.body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const global = Array.isArray(req.body.global)
      ? req.body.global.filter((w): w is string => typeof w === 'string')
      : undefined
    const rules = isRecord(req.body.rules)
      ? (req.body.rules as Record<string, unknown>)
      : undefined
    const rulesPatch: Partial<import('./adminPanelState').AntispamRules> = {}
    if (rules) {
      if (typeof rules.block_links === 'boolean') rulesPatch.block_links = rules.block_links
      if (typeof rules.flood_protection === 'boolean') {
        rulesPatch.flood_protection = rules.flood_protection
      }
      if (typeof rules.caps_protection === 'boolean') {
        rulesPatch.caps_protection = rules.caps_protection
      }
      if (typeof rules.emoji_spam === 'boolean') rulesPatch.emoji_spam = rules.emoji_spam
    }
    await saveAntispamWords({
      global,
      rules: Object.keys(rulesPatch).length > 0 ? rulesPatch : undefined,
    })
    res.json({ ok: true })
  })

  secured.post('/antispam/channel/:chatId', async (req, res) => {
    const chatId = parseNonZeroInt(req.params.chatId)
    if (chatId === null || !isRecord(req.body)) {
      res.status(400).json({ error: 'invalid request' })
      return
    }
    const body = req.body
    const patch: Parameters<typeof saveChannelExtras>[1] = {}
    if (Array.isArray(body.stopwords)) {
      patch.stopwords = body.stopwords.filter((w): w is string => typeof w === 'string')
    }
    if (typeof body.block_links === 'boolean') patch.block_links = body.block_links
    if (typeof body.flood_protection === 'boolean') patch.flood_protection = body.flood_protection
    if (typeof body.auto_mute === 'boolean') patch.auto_mute = body.auto_mute
    const saved = await saveChannelExtras(chatId, patch)
    res.json({ ok: true, settings: saved })
  })

  secured.get('/antispam/log', async (req, res) => {
    const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50
    const entries = await getAntispamLog(limit)
    res.json({ entries })
  })

  secured.get('/tg-chains', async (_req, res) => {
    const chains = await listTgChains()
    const active = chains.filter((c) => c.active).length
    const forwardedToday = chains.reduce((s, c) => s + c.forwarded_today, 0)
    const errorsToday = chains.reduce((s, c) => s + c.errors_today, 0)
    res.json({ chains, stats: { active, forwarded_today: forwardedToday, errors_today: errorsToday } })
  })

  secured.post('/tg-chains', async (req, res) => {
    if (!isRecord(req.body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const maxChatId = parseNonZeroInt(req.body.max_chat_id)
    const tgRaw = parseNonEmptyString(req.body.tg_channel) ?? parseNonEmptyString(req.body.tg_username)
    if (maxChatId === null || !tgRaw) {
      res.status(400).json({ error: 'max_chat_id and tg_channel required' })
      return
    }
    const tgKey = tgRaw.trim()
    const isNumericTg = /^-?\d+$/.test(tgKey.replace(/^@/, ''))
    const tgChannelId = isNumericTg ? tgKey.replace(/^@/, '') : undefined
    const tgUsername = isNumericTg
      ? (parseNonEmptyString(req.body.tg_username)?.replace(/^@/, '') ?? '')
      : tgKey.replace(/^@/, '')
    if (!tgChannelId && !tgUsername) {
      res.status(400).json({ error: 'invalid tg channel' })
      return
    }
    const existing = (await listTgChains()).find(
      (c) =>
        c.active &&
        c.max_chat_id === maxChatId &&
        (tgChannelId
          ? c.tg_channel_id === tgChannelId
          : c.tg_username.toLowerCase() === tgUsername.toLowerCase()),
    )
    if (existing) {
      res.status(400).json({ error: 'Активная цепочка для этой пары TG → MAX уже есть' })
      return
    }
    const ch = channelRegistry.getChannel(maxChatId)
    const row = await createTgChain({
      max_chat_id: maxChatId,
      max_title: ch?.title ?? null,
      tg_username: tgUsername,
      tg_channel_id: tgChannelId,
      bot_token: parseNonEmptyString(req.body.bot_token) ?? '',
      forward_posts: Boolean(req.body.forward_posts),
      forward_comments: Boolean(req.body.forward_comments),
      add_comments_button: req.body.add_comments_button !== false,
      add_signature: Boolean(req.body.add_signature),
      active: true,
    })
    res.json({ ok: true, chain: row })
  })

  secured.patch('/tg-chains/:id', async (req, res) => {
    if (!isRecord(req.body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const id = parseNonEmptyString(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const patch: Record<string, unknown> = {}
    if (typeof req.body.active === 'boolean') patch.active = req.body.active
    if (typeof req.body.forward_posts === 'boolean') patch.forward_posts = req.body.forward_posts
    if (typeof req.body.forward_comments === 'boolean') patch.forward_comments = req.body.forward_comments
    if (typeof req.body.add_comments_button === 'boolean') {
      patch.add_comments_button = req.body.add_comments_button
    }
    const updated = await updateTgChain(id, patch)
    if (!updated) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ ok: true, chain: updated })
  })

  secured.delete('/tg-chains/:id', async (req, res) => {
    const id = parseNonEmptyString(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const ok = await deleteTgChain(id)
    if (!ok) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ ok: true })
  })

  secured.use('/autoposts', createAutopostRouter())

  secured.post('/refresh-buttons', async (req, res) => {
    const body = req.body
    const chatId = isRecord(body) ? parseNonZeroInt(body.chat_id) : null
    if (chatId === null) {
      res.status(400).json({ error: 'invalid chat_id' })
      return
    }
    try {
      const firstPass = await runChannelPollerForChat(deps.bot, chatId)
      const diagnosis = await diagnosePostLinks(chatId)

      const mids = [...new Set(
        diagnosis.candidates
          .map((c) => c.message_mid?.trim())
          .filter((v): v is string => Boolean(v)),
      )].slice(0, 20)

      let restoredFromLogs = 0
      for (const mid of mids) {
        const recovered = await ensurePostFromChannelMessage(deps.bot, chatId, mid)
        if (recovered) {
          restoredFromLogs += 1
        }
      }

      const secondPass = restoredFromLogs > 0 ? await runChannelPollerForChat(deps.bot, chatId) : null

      const resultStats =
        secondPass !== null
          ? {
              chat_id: firstPass.chat_id,
              messages_fetched: Math.max(firstPass.messages_fetched, secondPass.messages_fetched),
              posts_in_db: Math.max(firstPass.posts_in_db, secondPass.posts_in_db),
              created: firstPass.created + secondPass.created,
              refreshed: firstPass.refreshed + secondPass.refreshed,
              skipped: firstPass.skipped + secondPass.skipped,
              failed: firstPass.failed + secondPass.failed,
            }
          : firstPass

      res.json({
        ok: true,
        ...resultStats,
        restored_from_logs: restoredFromLogs,
        diagnostics: {
          signals_total: diagnosis.signals_total,
          id_mismatch: diagnosis.id_mismatch,
          post_lookup_not_found: diagnosis.post_lookup_not_found,
          candidates: diagnosis.candidates.slice(0, 20),
        },
      })
    } catch (err: unknown) {
      if (err instanceof RefreshButtonsError) {
        const status =
          err.code === 'miniapp_not_configured'
            ? 503
            : err.code === 'channel_not_found'
              ? 404
              : 502
        res.status(status).json({ error: err.message, code: err.code })
        return
      }
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
