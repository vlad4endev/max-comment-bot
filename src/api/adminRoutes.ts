import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Bot } from '@maxhub/max-bot-api'
import type { ChatMember } from '@maxhub/max-bot-api/types'
import express from 'express'
import pLimit from 'p-limit'

import { config, getTelegramToken } from '../config'
import { getDb } from '../db/database'
import { checkAdminAuth } from '../middleware/adminAuth'
import {
  normalizeCommentSyncKeywords,
  normalizeCommentSyncMatchMode,
  type CommentSyncMatchMode,
} from '../utils/commentSyncFilter'
import {
  fullyDisconnectRegisteredChannel,
  maybePruneRegisteredChannelsNotAccessibleByBot,
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
import { getPostLinkAutoRecoveryStats } from '../services/postLinkAutoRecovery'
import { diagnosePostLinks } from '../services/postLinkDiagnostics'
import {
  diagnoseCommentSync,
  repairMissingThreadMappings,
} from '../services/commentSyncDiagnostics'
import { postStore } from '../services/postStore'
import { stateManager } from '../services/stateManager'
import { subscriberStore } from '../services/subscriberStore'
import { channelSubscriberSnapshotStore } from '../services/channelSubscriberSnapshotStore'
import { fullyRemoveUserFromBot } from '../services/userAccessCleanup'
import { userMiniappSettingsStore } from '../services/userMiniappSettingsStore'
import {
  adminPanelCredentialsMatch,
  adminPanelLogoutCookieHeader,
  adminPanelSessionCookieHeader,
} from '../utils/adminPanelSession'
import {
  countAntispamBlocksToday,
  buildTgChainHealth,
  createTgChain,
  createVkChain,
  deleteTgChain,
  deleteVkChain,
  getAntispamLog,
  getAntispamWords,
  getChannelExtras,
  listTgChains,
  listVkChains,
  saveAntispamWords,
  saveAntispamEngine,
  saveScoredWords,
  saveChannelExtras,
  updateTgChain,
  updateVkChain,
  type TgChainRecord,
} from './adminPanelState'
import { createAutopostRouter } from './autopostRoutes'
import { buildDashboardAnalytics, parseDashboardPeriodDays } from '../services/analyticsService'
import { integrationsStore } from '../services/integrationsStore'
import { parseAdminLogLine, type AdminLogEntry, type AdminLogLevel } from '../utils/adminLogFormat'
import { resolveTgChainChannelFields, repairStaleTgChainBotTokens } from '../services/tgChainChannelRef'
import { resolveVkGroup, listVkManagedGroups } from '../services/integrationPlatformClient'
import { isMtprotoSessionReady, resolveMtprotoCredentials } from '../services/mtprotoConfigStore'
import {
  describeTelegramTokenSources,
  getTelegramHealthSnapshot,
  isTelegramTokenAuthorized,
  probeTelegramBotApi,
} from '../services/telegramHealthService'
import { findActiveTgChainForPair } from '../utils/tgChainPair'
import { normalizeTelegramLinkedChatsForApi } from '../utils/telegramLinkedChats'
import { purgeTgChainForwardedMaxPosts } from '../services/tgChainPostPurge'
import {
  analyzeLogs,
  getLogAiPublicConfig,
  saveLogAiConfig,
  testLogAiConnection,
  type LogAnalysisFocus,
} from '../services/logAnalysisService'
import { getAdminLogTail, logger } from '../utils/logger'
import { extractMemberAvatarUrl } from '../utils/memberAvatar'
import {
  ANTISPAM_SCORE_TIERS,
  resetScoredWordsToDefault,
} from '../db/seedAntispamScoredWords'
import type { ScoredWordsByScore } from '../db/seedAntispamScoredWords'

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

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }
  return null
}

function parseTgDiscussionChatId(value: unknown): string | null | undefined {
  if (value === null || value === '') {
    return null
  }
  let raw: string | null = null
  if (typeof value === 'number' && Number.isFinite(value)) {
    raw = String(Math.trunc(value))
  } else {
    raw = parseNonEmptyString(value)
  }
  if (!raw) {
    return undefined
  }
  const normalized = raw.replace(/^@/, '')
  if (!/^-?\d+$/.test(normalized)) {
    return undefined
  }
  return normalized
}

const TG_CHAIN_PATCH_FIELDS: (keyof TgChainRecord)[] = [
  'forward_posts',
  'forward_comments',
  'forward_posts_since',
  'tg_discussion_chat_id',
  'tg_discussion_send_as',
  'comment_sync_keywords',
  'comment_sync_match_mode',
  'add_comments_button',
  'add_signature',
  'active',
  'bot_token',
  'max_chat_id',
  'tg_channel_id',
  'tg_username',
  'max_title',
]

function buildTgChainPatchFromBody(
  body: Record<string, unknown>,
  chainId: string,
  callerIp: string | undefined,
): Partial<TgChainRecord> {
  const patch: Partial<TgChainRecord> = {}

  for (const field of TG_CHAIN_PATCH_FIELDS) {
    if (!(field in body)) {
      continue
    }
    switch (field) {
      case 'active':
      case 'forward_posts':
      case 'forward_comments':
      case 'add_comments_button':
      case 'add_signature':
        if (typeof body[field] === 'boolean') {
          patch[field] = body[field]
          if (field === 'forward_posts' && body.forward_posts === false) {
            logger.warn('[tgChain PATCH] forward_posts explicitly set to false', {
              chainId,
              callerIp,
            })
          }
        }
        break
      case 'forward_posts_since': {
        const since = body.forward_posts_since
        if (since === null || since === '') {
          patch.forward_posts_since = null
        } else if (typeof since === 'string' && since.trim()) {
          patch.forward_posts_since = since.trim()
        }
        break
      }
      case 'tg_discussion_chat_id': {
        const discussionChatId = parseTgDiscussionChatId(body.tg_discussion_chat_id)
        if (discussionChatId !== undefined) {
          patch.tg_discussion_chat_id = discussionChatId
        }
        break
      }
      case 'tg_discussion_send_as': {
        const discussionSendAs = parseDiscussionSendAs(body.tg_discussion_send_as)
        if (discussionSendAs !== undefined) {
          patch.tg_discussion_send_as = discussionSendAs
        }
        break
      }
      case 'comment_sync_keywords': {
        const commentSyncKeywords = parseCommentSyncKeywords(body.comment_sync_keywords)
        patch.comment_sync_keywords = normalizeCommentSyncKeywords(commentSyncKeywords ?? [])
        break
      }
      case 'comment_sync_match_mode': {
        const commentSyncMatchMode = parseCommentSyncMatchMode(body.comment_sync_match_mode)
        patch.comment_sync_match_mode = commentSyncMatchMode ?? 'contains'
        break
      }
      case 'bot_token': {
        const token = parseNonEmptyString(body.bot_token)
        if (token) {
          patch.bot_token = token
        }
        break
      }
      case 'max_chat_id': {
        const maxChatId = parseNonZeroInt(body.max_chat_id)
        if (maxChatId !== null) {
          patch.max_chat_id = maxChatId
        }
        break
      }
      case 'tg_channel_id': {
        const tgChannelId = parseNonEmptyString(body.tg_channel_id)
        if (tgChannelId) {
          patch.tg_channel_id = tgChannelId
        }
        break
      }
      case 'tg_username': {
        const tgUsername = parseNonEmptyString(body.tg_username)
        if (tgUsername) {
          patch.tg_username = tgUsername.replace(/^@/, '')
        }
        break
      }
      case 'max_title': {
        if (body.max_title === null) {
          patch.max_title = null
        } else {
          const maxTitle = parseNonEmptyString(body.max_title)
          if (maxTitle) {
            patch.max_title = maxTitle
          }
        }
        break
      }
      default:
        break
    }
  }

  return patch
}

function getTgChainLastForwardedAt(chainId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(forwarded_at) AS last_forwarded_at
       FROM tg_chain_forwarded
       WHERE chain_id = ?
         AND max_message_mid IS NOT NULL
         AND TRIM(max_message_mid) != ''`,
    )
    .get(chainId) as { last_forwarded_at: string | null } | undefined
  return row?.last_forwarded_at ?? null
}

function parseDiscussionSendAs(value: unknown): 'channel' | 'chat' | undefined {
  if (value === 'channel' || value === 'chat') {
    return value
  }
  return undefined
}

function parseCommentSyncKeywords(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value
    .filter((w): w is string => typeof w === 'string')
    .map((w) => w.trim())
    .filter(Boolean)
}

function parseCommentSyncMatchMode(value: unknown): CommentSyncMatchMode | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  return normalizeCommentSyncMatchMode(value)
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
const REL_CHANNEL_SUBSCRIBER = 'Подписчик канала'

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

async function resolveAvatarFromMax(
  bot: Bot,
  userId: number,
  channelChatIds: number[],
): Promise<string | null> {
  const ordered = [...new Set(channelChatIds)]
  for (const chatId of ordered) {
    try {
      const { members } = await bot.api.getChatMembers(chatId, { user_ids: [userId] })
      const avatarUrl = extractMemberAvatarUrl(members[0])
      if (avatarUrl) {
        return avatarUrl
      }
    } catch (err: unknown) {
      logger.debug('admin /users: getChatMembers for avatar failed', { chatId, userId, err })
    }
  }
  const priv = stateManager.getUserPrivateChatId(userId)
  if (priv !== undefined) {
    try {
      const { members } = await bot.api.getChatMembers(priv, { user_ids: [userId] })
      const avatarUrl = extractMemberAvatarUrl(members[0])
      if (avatarUrl) {
        return avatarUrl
      }
    } catch (err: unknown) {
      logger.debug('admin /users: getChatMembers private for avatar failed', {
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
      log_ai: getLogAiPublicConfig(),
    })
  })

  secured.get('/stats', (_req, res) => {
    const channels = channelRegistry.getAllChannels().filter((c) => c.type === 'channel')
    res.json({
      channel_count: channels.length,
      bot_subscribers: subscriberStore.getAllSubscribers().length,
      comment_count: commentStore.totalCount,
      post_count: postStore.getTotalPostCount(),
    })
  })

  secured.get('/dashboard', (req, res) => {
    const periodDays = parseDashboardPeriodDays(req.query.days)
    const payload = buildDashboardAnalytics(periodDays)
    res.json(payload)
  })

  secured.get('/dashboard-telegram', async (_req, res) => {
    await integrationsStore.load()
    const integ = integrationsStore.getTelegramIntegration()
    const channels = normalizeTelegramLinkedChatsForApi(integ?.linkedChats)
    const flows = integrationsStore.getFlows().filter((f) => f.source.platform === 'telegram')
    const flowsActive = flows.filter((f) => f.enabled).length
    const forwardedLog = integrationsStore.getForwardedLog(50)
    const tgForwarded = forwardedLog.filter((e) => e.fromPlatform === 'telegram')

    res.json({
      totals: {
        channels: channels.length,
        channels_admin: channels.filter((c) => c.botIsAdmin === true).length,
        admins_total: 0,
        admins_started: 0,
        flows_active: flowsActive,
        forwarded_total: tgForwarded.length,
      },
      channels: channels.map((ch) => ({
        id: ch.id,
        title: ch.title,
        username: ch.username,
        type: ch.type,
        botIsAdmin: ch.botIsAdmin === true,
        admins: [],
        admins_total: 0,
        admins_started: 0,
      })),
      recent_forwarded: tgForwarded.slice(0, 15),
    })
  })

  secured.get('/channels', async (req, res) => {
    const summaryOnly = req.query.summary === '1' || req.query.summary === 'true'
    if (summaryOnly) {
      const snapshot = channelRegistry.getAllChannels().filter((c) => c.type === 'channel')
      res.json({
        channels: snapshot.map((c) => ({
          chat_id: c.chat_id,
          title: c.title,
          status: stateManager.isChannelPendingAdminRights(c.chat_id) ? ('pending' as const) : ('active' as const),
        })),
      })
      return
    }
    await maybePruneRegisteredChannelsNotAccessibleByBot(deps.bot)
    const snapshot = [...channelRegistry.getAllChannels()].filter((c) => c.type === 'channel')
    const limit = pLimit(4)
    const rows = await Promise.all(
      snapshot.map((c) =>
        limit(async () => {
          if (channelRegistry.getChannel(c.chat_id) === null) {
            return null
          }
          const pending = stateManager.isChannelPendingAdminRights(c.chat_id)
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
            logger.warn('admin GET /channels: getChat failed', { chatId: c.chat_id, err })
            return null
          }
          return {
            chat_id: c.chat_id,
            title: c.title,
            type: c.type,
            subscribers,
            post_count: postStore.countPostsByChatId(c.chat_id),
            comment_count: commentStore.countCommentsByChatId(c.chat_id),
            date_added: c.date_added,
            status: pending ? ('pending' as const) : ('active' as const),
            avatar_url,
          }
        }),
      ),
    )
    res.json({ channels: rows.filter((row): row is NonNullable<typeof row> => row !== null) })
  })

  secured.get('/bot-status', async (_req, res) => {
    await integrationsStore.load()
    const tgInteg = integrationsStore.getTelegramIntegration()
    const vkInteg = integrationsStore
      .getIntegrations()
      .find((i) => i.platform === 'vk' && i.status === 'connected')
    const tgToken = (tgInteg?.token?.trim() || getTelegramToken()).trim()
    const tokenSources = describeTelegramTokenSources()
    const tgHealth = tgToken ? await probeTelegramBotApi(tgToken) : getTelegramHealthSnapshot()
    const tgChains = await listTgChains()
    const chainTokenChecks = await Promise.all(
      tgChains.map(async (chain) => {
        const chainToken = chain.bot_token?.trim() || tgToken
        const preview =
          chainToken.length > 4 ? `••••${chainToken.slice(-4)}` : chainToken ? '••••' : ''
        const usesOwnToken = Boolean(chain.bot_token?.trim()) && chain.bot_token?.trim() !== tgToken
        const apiOk = chainToken ? await isTelegramTokenAuthorized(chainToken) : false
        return {
          chain_id: chain.id,
          name: chain.tg_username?.trim() || chain.tg_channel_id?.trim() || chain.id,
          token_preview: preview,
          uses_own_token: usesOwnToken,
          api_ok: apiOk,
        }
      }),
    )
    const readerToken = (process.env.TG_READER_BOT_TOKEN || '').trim()
    const readerHealth = readerToken ? await probeTelegramBotApi(readerToken) : null
    const vkChains = await listVkChains()
    const tgLinked = normalizeTelegramLinkedChatsForApi(tgInteg?.linkedChats)
    res.json({
      active: true,
      label: 'MAX бот активен',
      platforms: {
        max: { active: true, label: 'MAX бот' },
        telegram: {
          connected: Boolean(tgInteg && tgToken),
          has_token: Boolean(tgToken),
          api_ok: tgHealth.api_ok,
          bot_username: tgHealth.bot_username,
          api_error: tgHealth.error,
          label:
            tgHealth.api_ok && tgToken
              ? 'Telegram подключён'
              : tgToken
                ? 'Telegram: ошибка авторизации'
                : 'Telegram не подключён',
          chains_active: tgChains.filter((c) => c.active).length,
          channels_total: tgLinked.length,
          channels_admin: tgLinked.filter((c) => c.botIsAdmin === true).length,
          token_sources: tokenSources,
          chain_tokens: chainTokenChecks,
          reader_api_ok: readerHealth?.api_ok ?? null,
          reader_token_preview: tokenSources.reader_token_preview,
        },
        vk: {
          connected: Boolean(vkInteg),
          label: vkInteg ? 'VK подключён' : 'VK не подключён',
          chains_active: vkChains.filter((c) => c.active).length,
        },
      },
      mtproto_ready: isMtprotoSessionReady(),
      telegram_health_checked_at: tgHealth.checked_at,
    })
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
    await maybePruneRegisteredChannelsNotAccessibleByBot(deps.bot)
    const ownerId = config.ownerUserId
    const commentStatsByUser = commentStore.aggregateUserCommentStats()
    const snapshotMembers = channelSubscriberSnapshotStore.listAllMembers()

    type Row = {
      user_id: number
      name: string | null
      role: 'owner' | 'admin' | 'subscriber'
      linkByChatId: Map<number, { title: string | null; relations: Set<string> }>
      registered_at: string | null
      is_subscriber: boolean
      has_miniapp_settings: boolean
      avatar_url: string | null
      comments_total: number
      comments_answered: number
      comments_unanswered: number
      last_comment_at: string | null
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
          avatar_url: null,
          comments_total: 0,
          comments_answered: 0,
          comments_unanswered: 0,
          last_comment_at: null,
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

    for (const member of snapshotMembers) {
      const row = touch(member.user_id)
      if (!row.name?.trim()) {
        row.name = member.name
      }
      if (!row.avatar_url && member.avatar_url) {
        row.avatar_url = member.avatar_url
      }
      const title = channelRegistry.getChannel(member.channel_chat_id)?.title ?? null
      rowAddLinkRelation(row, member.channel_chat_id, title, REL_CHANNEL_SUBSCRIBER)
      if (member.is_admin || member.is_owner) {
        rowAddLinkRelation(row, member.channel_chat_id, title, REL_CHANNEL_ADMIN)
        if (member.user_id === ownerId) {
          row.role = 'owner'
        } else if (row.role !== 'owner') {
          row.role = 'admin'
        }
      }
    }

    for (const [userId, stats] of commentStatsByUser) {
      const row = touch(userId)
      row.comments_total = stats.total
      row.comments_answered = stats.answered
      row.comments_unanswered = stats.unanswered
      row.last_comment_at = stats.last_comment_at
      if (!row.avatar_url && stats.latest_avatar_url) {
        row.avatar_url = stats.latest_avatar_url
      }
      if (!row.name?.trim() && stats.latest_username) {
        row.name = stats.latest_username
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

    const out = [...byUser.values()].map((row) => {
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
        started_bot: row.is_subscriber,
        is_restricted: disabledAdminStore.isDisabled(row.user_id),
        /** @deprecated Используйте channel_links; оставлено для совместимости */
        channels: channel_links.map((l) => ({ chat_id: l.chat_id, title: l.channel_title })),
        channel_links,
        context_hint,
        registered_at: row.registered_at,
        avatar_url: row.avatar_url,
        comment_stats: {
          total: row.comments_total,
          answered: row.comments_answered,
          unanswered: row.comments_unanswered,
          last_comment_at: row.last_comment_at,
        },
      }
    })

    out.sort((a, b) => a.user_id - b.user_id)
    res.json({ users: out })
  })

  secured.get('/users/:userId', async (req, res) => {
    const userId = parsePositiveInt(req.params.userId)
    if (!userId) {
      res.status(400).json({ error: 'invalid user_id' })
      return
    }

    await maybePruneRegisteredChannelsNotAccessibleByBot(deps.bot)
    const ownerId = config.ownerUserId
    const links = channelNotifyLinkStore.getAllLinks().filter((link) => link.user_id === userId)
    const channelsWithAdminRole = channelRegistry.getAllChannels().filter((channel) => channel.type === 'channel')
    const commentsRaw = commentStore.listAllCommentsNewestFirst().filter((c) => c.user_id === userId)

    const channelLinksById = new Map<number, { title: string | null; relations: Set<string> }>()
    function addChannelRelation(chatId: number, title: string | null, relation: string): void {
      let row = channelLinksById.get(chatId)
      if (!row) {
        row = { title, relations: new Set<string>() }
        channelLinksById.set(chatId, row)
      }
      if (title && !row.title) {
        row.title = title
      }
      row.relations.add(relation)
    }
    for (const link of links) {
      const title = channelRegistry.getChannel(link.channel_chat_id)?.title ?? null
      addChannelRelation(link.channel_chat_id, title, REL_COMMENT_NOTIFY)
    }
    for (const member of channelSubscriberSnapshotStore.listMembersForUser(userId)) {
      const title = channelRegistry.getChannel(member.channel_chat_id)?.title ?? null
      addChannelRelation(member.channel_chat_id, title, REL_CHANNEL_SUBSCRIBER)
    }
    for (const ch of channelsWithAdminRole) {
      try {
        const { members } = await deps.bot.api.getChatMembers(ch.chat_id, { user_ids: [userId] })
        const m = members[0]
        if (m && !m.is_bot && (m.is_admin || m.is_owner)) {
          addChannelRelation(ch.chat_id, ch.title, REL_CHANNEL_ADMIN)
        }
      } catch (err: unknown) {
        logger.debug('admin /users/:userId getChatMembers failed', { chatId: ch.chat_id, userId, err })
      }
    }

    const isSubscriber = subscriberStore.hasSubscriber(userId)
    const hasMiniappSettings = userMiniappSettingsStore
      .getAllUserIdsWithSettings()
      .includes(userId)
    if (
      channelLinksById.size === 0 &&
      !isSubscriber &&
      !hasMiniappSettings &&
      commentsRaw.length === 0 &&
      userId !== ownerId
    ) {
      res.status(404).json({ error: 'user not found' })
      return
    }

    const channelIds = [...channelLinksById.keys()].sort((a, b) => a - b)
    const avatarFromComment = commentsRaw.find((c) => c.avatar_url?.trim())?.avatar_url?.trim() ?? null
    let name = commentsRaw.find((c) => c.username.trim())?.username.trim() ?? null
    const fromMaxName = await resolveDisplayNameFromMax(deps.bot, userId, channelIds)
    if (fromMaxName) {
      name = fromMaxName
    }
    let avatarUrl = avatarFromComment
    if (!avatarUrl) {
      avatarUrl = await resolveAvatarFromMax(deps.bot, userId, channelIds)
    }

    let registeredAt: string | null = null
    for (const link of links) {
      if (!registeredAt || link.joined_at.localeCompare(registeredAt) < 0) {
        registeredAt = link.joined_at
      }
    }

    const channel_links = [...channelLinksById.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([chat_id, value]) => ({
        chat_id,
        channel_title: value.title,
        relations: [...value.relations].sort((x, y) => x.localeCompare(y, 'ru')),
      }))
    const hasAdminRelation = channel_links.some((link) => link.relations.includes(REL_CHANNEL_ADMIN))

    const comments = commentsRaw.map((c) => {
      const post = postStore.getPost(c.post_id)
      const answered = Boolean(c.reply?.text?.trim())
      return {
        comment_id: c.comment_id,
        post_id: c.post_id,
        text: c.text,
        timestamp: c.timestamp,
        status: answered ? ('answered' as const) : ('unanswered' as const),
        reply: answered
          ? {
              text: c.reply!.text,
              timestamp: c.reply!.timestamp,
              admin_name: c.reply!.admin_name ?? null,
            }
          : null,
        post_context: post
          ? {
              chat_id: post.chat_id,
              channel_title: channelRegistry.getChannel(post.chat_id)?.title ?? null,
              text: post.text,
              photo_url: post.photo_url ?? null,
              channel_post_url: post.channel_post_url ?? null,
              timestamp: post.timestamp,
            }
          : null,
      }
    })

    const answeredComments = comments.filter((c) => c.status === 'answered')
    const unansweredComments = comments.filter((c) => c.status === 'unanswered')

    res.json({
      user: {
        user_id: userId,
        name,
        role:
          userId === ownerId
            ? ('owner' as const)
            : hasAdminRelation
              ? ('admin' as const)
              : ('subscriber' as const),
        is_restricted: disabledAdminStore.isDisabled(userId),
        channel_links,
        context_hint:
          channel_links.length === 0 && isSubscriber
            ? 'Подписчик бота (/start): привязка к каналу не найдена'
            : channel_links.length === 0 && hasMiniappSettings
              ? 'Пользователь открывал мини-приложение, но не привязан к каналу'
              : null,
        registered_at: registeredAt,
        avatar_url: avatarUrl,
        comment_stats: {
          total: comments.length,
          answered: answeredComments.length,
          unanswered: unansweredComments.length,
          last_comment_at: comments[0]?.timestamp ?? null,
        },
        is_subscriber: isSubscriber,
        started_bot: isSubscriber,
        has_miniapp_settings: hasMiniappSettings,
        private_chat_id: stateManager.getUserPrivateChatId(userId) ?? null,
      },
      comments: {
        answered: answeredComments,
        unanswered: unansweredComments,
        total: comments.length,
      },
    })
  })

  secured.post('/users/sync-channel-subscribers', async (_req, res) => {
    try {
      await maybePruneRegisteredChannelsNotAccessibleByBot(deps.bot, { force: true })
      const result = await channelSubscriberSnapshotStore.syncAllRegisteredChannels(deps.bot)
      res.json({ ok: true, ...result })
    } catch (err: unknown) {
      logger.error('admin /users/sync-channel-subscribers failed', err)
      res.status(500).json({ error: 'failed to sync channel subscribers' })
    }
  })

  secured.get('/comments', (req, res) => {
    const chatId = parseNonZeroInt(req.query.chat_id)
    if (chatId === null) {
      res.status(400).json({ error: 'missing or invalid chat_id' })
      return
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const limitRaw =
      typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 100
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 100
    const rows = commentStore.listCommentsForChannelAdminPage(chatId, { limit, q })
    const totalInChannel = commentStore.countCommentsByChatId(chatId)
    const wired = rows.map(({ comment: c, post_preview }) => ({
      comment_id: c.comment_id,
      post_id: c.post_id,
      post_preview,
      user_id: c.user_id,
      username: c.username,
      text: c.text,
      reply: c.reply,
      timestamp: c.timestamp,
    }))
    res.json({
      comments: wired,
      total_in_channel: totalInChannel,
      returned: wired.length,
      truncated: totalInChannel > wired.length,
    })
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
      const autoRecovery = getPostLinkAutoRecoveryStats()
      res.json({
        posts,
        pending_buttons: pendingButtons,
        channels,
        comments,
        subscribers,
        retry_queue: retryQueueSize,
        auto_recovery: autoRecovery,
      })
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

  secured.get('/logs/ai-config', (_req, res) => {
    res.json(getLogAiPublicConfig())
  })

  secured.post('/logs/ai-config', async (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    try {
      const saved = await saveLogAiConfig({
        provider: typeof body.provider === 'string' ? body.provider : undefined,
        api_key: typeof body.api_key === 'string' ? body.api_key : undefined,
        base_url: typeof body.base_url === 'string' ? body.base_url : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
      })
      res.json({ ok: true, ...saved })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'save failed'
      if (message === 'api_key required' || message === 'model required' || message === 'base_url required for custom provider') {
        res.status(400).json({ error: 'validation_error', message })
        return
      }
      logger.error('admin /logs/ai-config failed', err)
      res.status(500).json({ error: 'failed to save AI config' })
    }
  })

  secured.post('/logs/ai-test', async (_req, res) => {
    try {
      const result = await testLogAiConnection()
      res.json(result)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'test failed'
      if (message === 'LOG_AI_NOT_CONFIGURED') {
        res.status(503).json({
          error: 'ai_not_configured',
          message: 'Сначала укажите ключ оператора ИИ',
        })
        return
      }
      if (message.startsWith('LOG_AI_REQUEST_FAILED:')) {
        res.status(502).json({
          error: 'ai_request_failed',
          message: message.replace(/^LOG_AI_REQUEST_FAILED:\s*/, ''),
        })
        return
      }
      logger.error('admin /logs/ai-test failed', err)
      res.status(500).json({ error: 'internal error' })
    }
  })

  secured.post('/logs/analyze', async (req, res) => {
    const body = isRecord(req.body) ? req.body : {}
    const limitRaw = typeof body.limit === 'number' ? body.limit : Number.parseInt(String(body.limit ?? ''), 10)
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 200
    const levelRaw = typeof body.level === 'string' ? body.level.toUpperCase() : ''
    const level =
      levelRaw === 'INFO' || levelRaw === 'WARN' || levelRaw === 'ERROR' || levelRaw === 'DEBUG'
        ? levelRaw
        : null
    const filter = typeof body.filter === 'string' ? body.filter.trim() : ''
    const focusRaw = typeof body.focus === 'string' ? body.focus.trim() : 'general'
    const focusAllowed: LogAnalysisFocus[] = [
      'general',
      'errors',
      'comment_buttons',
      'database',
      'rate_limit',
      'integrations',
    ]
    const focus: LogAnalysisFocus = focusAllowed.includes(focusRaw as LogAnalysisFocus)
      ? (focusRaw as LogAnalysisFocus)
      : 'general'

    try {
      const report = await analyzeLogs({ limit, level, filter, focus })
      res.json(report)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'analysis failed'
      if (message === 'LOG_AI_NOT_CONFIGURED') {
        res.status(503).json({
          error: 'ai_not_configured',
          message: 'Настройте оператора ИИ в разделе Настройки',
        })
        return
      }
      if (message.startsWith('LOG_AI_REQUEST_FAILED:')) {
        res.status(502).json({
          error: 'ai_request_failed',
          message: message.replace(/^LOG_AI_REQUEST_FAILED:\s*/, ''),
        })
        return
      }
      if (message === 'LOG_AI_PARSE_FAILED' || message === 'LOG_AI_EMPTY_RESPONSE') {
        res.status(502).json({ error: 'ai_bad_response', message: 'ИИ вернул некорректный ответ, попробуйте ещё раз' })
        return
      }
      logger.error('admin /logs/analyze failed', err)
      res.status(500).json({ error: 'internal error' })
    }
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
    const comments = commentStore.listCommentsForChannelChatId(chatId, 8).map((c) => {
      const post = postStore.getPost(c.post_id)
      const answered = Boolean(c.reply?.text)
      return {
        comment_id: c.comment_id,
        post_id: c.post_id,
        username: c.username,
        text: c.text,
        timestamp: c.timestamp,
        ...(c.source === 'telegram' || c.source === 'vk' ? { source: c.source } : {}),
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
        post_count: postStore.countPostsByChatId(chatId),
        comment_count: commentStore.countCommentsByChatId(chatId),
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
      engine: data.engine,
      restricted_users: data.restricted_users,
      scored_words: data.scored_words,
      scored_words_total: data.scored_words_total,
      score_tiers: [...ANTISPAM_SCORE_TIERS],
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
    if (isRecord(req.body.engine)) {
      const eng = req.body.engine as Record<string, unknown>
      const enginePatch: Partial<import('./adminPanelState').AntispamEngineConfig> = {}
      if (typeof eng.soft_mode === 'boolean') enginePatch.soft_mode = eng.soft_mode
      if (typeof eng.enabled === 'boolean') enginePatch.enabled = eng.enabled
      if (typeof eng.spam_threshold === 'number') enginePatch.spam_threshold = eng.spam_threshold
      if (typeof eng.ban_threshold === 'number') enginePatch.ban_threshold = eng.ban_threshold
      if (typeof eng.captcha_required_score === 'number') {
        enginePatch.captcha_required_score = eng.captcha_required_score
      }
      if (typeof eng.emoji_overuse_limit === 'number') {
        enginePatch.emoji_overuse_limit = eng.emoji_overuse_limit
      }
      if (Array.isArray(eng.whitelist_user_ids)) {
        enginePatch.whitelist_user_ids = eng.whitelist_user_ids.filter(
          (id): id is number => typeof id === 'number' && id > 0,
        )
      }
      if (Array.isArray(eng.blacklist_user_ids)) {
        enginePatch.blacklist_user_ids = eng.blacklist_user_ids.filter(
          (id): id is number => typeof id === 'number' && id > 0,
        )
      }
      if (Object.keys(enginePatch).length > 0) {
        await saveAntispamEngine(enginePatch)
      }
    }
    res.json({ ok: true })
  })

  secured.post('/antispam/scored-words', async (req, res) => {
    if (!isRecord(req.body) || !isRecord(req.body.scored_words)) {
      res.status(400).json({ error: 'invalid scored_words' })
      return
    }
    const raw = req.body.scored_words as Record<string, unknown>
    const dict: ScoredWordsByScore = {}
    for (const tier of ANTISPAM_SCORE_TIERS) {
      const arr = raw[String(tier)]
      dict[tier] = Array.isArray(arr)
        ? [
            ...new Set(
              arr
                .filter((w): w is string => typeof w === 'string')
                .map((w) => w.trim().toLowerCase())
                .filter(Boolean),
            ),
          ]
        : []
    }
    const saved = await saveScoredWords(dict)
    res.json({ ok: true, scored_words: saved, scored_words_total: Object.values(saved).flat().length })
  })

  secured.post('/antispam/scored-words/reset', async (_req, res) => {
    const saved = resetScoredWordsToDefault()
    res.json({
      ok: true,
      scored_words: saved,
      scored_words_total: Object.values(saved).flat().length,
    })
  })

  secured.post('/antispam/test', async (req, res) => {
    if (!isRecord(req.body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const text = typeof req.body.text === 'string' ? req.body.text : ''
    const chatIdRaw = req.body.chat_id
    const chatId =
      typeof chatIdRaw === 'number' && Number.isInteger(chatIdRaw) && chatIdRaw !== 0
        ? chatIdRaw
        : 0
    const { evaluateComment } = await import('../services/antispamService')
    const result = evaluateComment({
      text,
      userId: 0,
      username: 'test',
      channelChatId: chatId,
      source: 'max',
    })
    res.json({ ok: true, result })
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
    const chainsWithHealth = chains.map((chain) => ({
      ...chain,
      health: buildTgChainHealth(chain, getTgChainLastForwardedAt(chain.id)),
    }))
    const active = chains.filter((c) => c.active).length
    const forwardedToday = chains.reduce((s, c) => s + c.forwarded_today, 0)
    const errorsToday = chains.reduce((s, c) => s + c.errors_today, 0)
    const mtproto = resolveMtprotoCredentials()
    res.json({
      chains: chainsWithHealth,
      stats: { active, forwarded_today: forwardedToday, errors_today: errorsToday },
      mtproto: {
        ready: isMtprotoSessionReady(),
        source: mtproto.source,
      },
    })
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
    await integrationsStore.load()
    const integ = integrationsStore.getTelegramIntegration()
    const tgToken = (
      parseNonEmptyString(req.body.bot_token) ??
      integ?.token?.trim() ??
      getTelegramToken()
    ).trim()
    if (!tgToken) {
      res.status(400).json({ error: 'Не задан токен Telegram-бота (интеграция или TG_TOKEN)' })
      return
    }
    const resolved = await resolveTgChainChannelFields(tgToken, tgKey)
    if (!resolved?.tg_channel_id || !/^-100\d+$/.test(resolved.tg_channel_id)) {
      res.status(400).json({
        error:
          'Не удалось определить Telegram-канал. Укажите @username или -100… id; бот должен быть админом канала.',
      })
      return
    }
    const tgChannelId = resolved.tg_channel_id
    const tgUsername =
      resolved.tg_username ||
      (tgKey.startsWith('@') ? tgKey.replace(/^@/, '') : '') ||
      parseNonEmptyString(req.body.tg_username)?.replace(/^@/, '') ||
      ''
    const existing = findActiveTgChainForPair(
      await listTgChains(),
      maxChatId,
      tgChannelId,
      tgUsername,
    )
    if (existing) {
      res.status(400).json({ error: 'Активная цепочка для этой пары TG → MAX уже есть' })
      return
    }
    const ch = channelRegistry.getChannel(maxChatId)
    const discussionChatId = parseTgDiscussionChatId(req.body.tg_discussion_chat_id)
    const discussionSendAs = parseDiscussionSendAs(req.body.tg_discussion_send_as)
    const commentSyncKeywords = parseCommentSyncKeywords(req.body.comment_sync_keywords)
    const commentSyncMatchMode = parseCommentSyncMatchMode(req.body.comment_sync_match_mode)
    const row = await createTgChain({
      max_chat_id: maxChatId,
      max_title: ch?.title ?? null,
      tg_username: tgUsername,
      tg_channel_id: tgChannelId,
      bot_token: parseNonEmptyString(req.body.bot_token)?.trim() || tgToken,
      forward_posts: req.body.forward_posts !== false,
      forward_comments: req.body.forward_comments !== false,
      tg_discussion_chat_id: discussionChatId === undefined ? null : discussionChatId,
      ...(discussionSendAs ? { tg_discussion_send_as: discussionSendAs } : {}),
      comment_sync_keywords: normalizeCommentSyncKeywords(commentSyncKeywords ?? []),
      ...(commentSyncMatchMode ? { comment_sync_match_mode: commentSyncMatchMode } : {}),
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
    const patch = buildTgChainPatchFromBody(req.body, id, req.ip)
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

  secured.post('/tg-chains/:id/purge-max-posts', async (req, res) => {
    const id = parseNonEmptyString(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const body = isRecord(req.body) ? req.body : {}
    const sinceIso = parseNonEmptyString(body.since)
    const untilIso = parseNonEmptyString(body.until)
    const dryRun = body.dry_run === true
    const limitRaw = body.limit
    const limit =
      typeof limitRaw === 'number' && Number.isFinite(limitRaw)
        ? Math.floor(limitRaw)
        : typeof limitRaw === 'string' && limitRaw.trim() !== ''
          ? Math.floor(Number(limitRaw))
          : undefined
    const sourceRaw = parseNonEmptyString(body.source)
    const source =
      sourceRaw === 'forwarded' ||
      sourceRaw === 'posts_db' ||
      sourceRaw === 'feed' ||
      sourceRaw === 'auto'
        ? sourceRaw
        : undefined

    try {
      const result = await purgeTgChainForwardedMaxPosts(deps.bot, id, {
        sinceIso: sinceIso ?? undefined,
        untilIso: untilIso ?? undefined,
        dryRun,
        limit,
        source,
      })
      res.json({ ok: true, purge: result })
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'chain_not_found') {
        res.status(404).json({ error: 'not found' })
        return
      }
      logger.error('admin tg-chains purge-max-posts', err)
      res.status(500).json({ error: 'failed' })
    }
  })

  // ── VK-chains ──────────────────────────────────────────────────────────────

  secured.get('/vk-chains', async (_req, res) => {
    const chains = await listVkChains()
    const active = chains.filter((c) => c.active).length
    const forwardedToday = chains.reduce((s, c) => s + c.forwarded_today, 0)
    const errorsToday = chains.reduce((s, c) => s + c.errors_today, 0)
    res.json({
      chains,
      stats: { active, forwarded_today: forwardedToday, errors_today: errorsToday },
    })
  })

  /** Список сообществ VK, где токен имеет права модератора/редактора/администратора. */
  secured.get('/vk-groups', async (req, res) => {
    await integrationsStore.load()
    const vkInt = integrationsStore.getIntegrations().find(
      (i) => i.platform === 'vk' && i.status === 'connected',
    )
    const token = parseNonEmptyString(String(req.query.token ?? '')) ?? vkInt?.token ?? ''
    if (!token) {
      res.status(400).json({ error: 'VK не подключён — укажите токен' })
      return
    }
    const groups = await listVkManagedGroups(token)
    res.json({ groups })
  })

  /** Разрешить VK-сообщество по URL, slug или числовому ID. */
  secured.post('/vk-resolve-group', async (req, res) => {
    if (!isRecord(req.body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    await integrationsStore.load()
    const vkInt = integrationsStore.getIntegrations().find(
      (i) => i.platform === 'vk' && i.status === 'connected',
    )
    const token = parseNonEmptyString(req.body.vk_token) ?? vkInt?.token ?? ''
    const input = parseNonEmptyString(req.body.input)
    if (!token || !input) {
      res.status(400).json({ error: 'token and input required' })
      return
    }
    const result = await resolveVkGroup(token, input)
    if (!result.group) {
      res.status(404).json({ error: result.error ?? 'Сообщество не найдено. Проверьте ссылку или ID.' })
      return
    }
    res.json({ group: result.group })
  })

  secured.post('/vk-chains', async (req, res) => {
    if (!isRecord(req.body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const maxChatId = parseNonZeroInt(req.body.max_chat_id)
    const vkGroupIdRaw = parseNonEmptyString(req.body.vk_group_id)
    if (maxChatId === null || !vkGroupIdRaw) {
      res.status(400).json({ error: 'max_chat_id and vk_group_id required' })
      return
    }
    await integrationsStore.load()
    const vkInt = integrationsStore.getIntegrations().find(
      (i) => i.platform === 'vk' && i.status === 'connected',
    )
    const vkToken = parseNonEmptyString(req.body.vk_token) ?? vkInt?.token ?? ''
    if (!vkToken) {
      res.status(400).json({ error: 'Токен VK не найден: укажите vk_token или подключите VK в Интеграциях' })
      return
    }
    const vkGroupId = vkGroupIdRaw.replace(/^-/, '')

    // Резолвим сообщество, чтобы сохранить имя и screen_name
    let vkScreenName: string | undefined
    let vkName: string | undefined
    try {
      const info = await resolveVkGroup(vkToken, vkGroupId)
      if (info.group) {
        vkScreenName = info.group.screenName
        vkName = info.group.name
      }
    } catch {
      // не блокируем создание, если API недоступен
    }

    const existing = (await listVkChains()).find(
      (c) =>
        c.active &&
        Math.abs(c.max_chat_id) === Math.abs(maxChatId) &&
        c.vk_group_id.replace(/^-/, '') === vkGroupId,
    )
    if (existing) {
      res.status(400).json({ error: 'Активная VK-связка для этой пары MAX ↔ VK уже есть' })
      return
    }
    const ch = channelRegistry.getChannel(maxChatId)
    const row = await createVkChain({
      max_chat_id: maxChatId,
      max_title: ch?.title ?? null,
      vk_group_id: vkGroupId,
      vk_screen_name: vkScreenName,
      vk_name: vkName,
      vk_token: vkToken,
      forward_posts: req.body.forward_posts !== false,
      sync_comments: Boolean(req.body.sync_comments),
      active: true,
    })
    res.json({ ok: true, chain: row })
  })

  secured.patch('/vk-chains/:id', async (req, res) => {
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
    if (typeof req.body.sync_comments === 'boolean') patch.sync_comments = req.body.sync_comments
    const vkToken = parseNonEmptyString(req.body.vk_token)
    if (vkToken) patch.vk_token = vkToken
    const vkGroupId = parseNonEmptyString(req.body.vk_group_id)
    if (vkGroupId) patch.vk_group_id = vkGroupId.replace(/^-/, '')
    const updated = await updateVkChain(id, patch)
    if (!updated) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ ok: true, chain: updated })
  })

  secured.delete('/vk-chains/:id', async (req, res) => {
    const id = parseNonEmptyString(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const ok = await deleteVkChain(id)
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
      const firstPass = await runChannelPollerForChat(deps.bot, chatId, {
        // Admin click should return quickly; deep 24h sweep is handled by scheduled poller and retries.
        lookbackMs: 6 * 60 * 60 * 1000,
        maxPages: 8,
      })
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

      res.json({
        ok: true,
        ...firstPass,
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

  secured.get('/comment-sync/diagnostics', async (req, res) => {
    const chainId = parseNonEmptyString(req.query.chain_id)
    try {
      const report = await diagnoseCommentSync(chainId ?? undefined)
      res.json({ ok: true, ...report })
    } catch (err: unknown) {
      logger.error('admin comment-sync/diagnostics', err)
      res.status(500).json({ error: 'failed' })
    }
  })

  secured.post('/comment-sync/repair-threads', async (req, res) => {
    const body = req.body
    const chainId = isRecord(body) ? parseNonEmptyString(body.chain_id) : null
    if (!chainId) {
      res.status(400).json({ error: 'chain_id required' })
      return
    }
    const limit = isRecord(body) ? parsePositiveInt(body.limit) : null
    const onlyWithPending = isRecord(body) ? parseBoolean(body.only_with_pending) === true : false
    try {
      const result = await repairMissingThreadMappings(chainId, limit ?? 30, {
        onlyWithPending,
      })
      const diagnostics = await diagnoseCommentSync(chainId)
      res.json({ ok: true, repair: result, diagnostics })
    } catch (err: unknown) {
      logger.error('admin comment-sync/repair-threads', err)
      res.status(500).json({ error: 'failed' })
    }
  })

  secured.post('/comment-sync/repair-tokens', async (_req, res) => {
    try {
      await integrationsStore.load()
      const repair = await repairStaleTgChainBotTokens()
      const tokenSources = describeTelegramTokenSources()
      const telegramHealth = await probeTelegramBotApi()
      res.json({ ok: true, repair, token_sources: tokenSources, telegram_health: telegramHealth })
    } catch (err: unknown) {
      logger.error('admin comment-sync/repair-tokens', err)
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

  secured.post('/users/restrict', (req, res) => {
    const body = req.body
    const userId = isRecord(body) ? parsePositiveInt(body.user_id) : null
    const restricted = isRecord(body) ? parseBoolean(body.restricted) : null
    if (!userId || restricted === null) {
      res.status(400).json({ error: 'invalid user_id or restricted flag' })
      return
    }
    if (userId === config.ownerUserId) {
      res.status(400).json({ error: 'cannot restrict owner' })
      return
    }
    if (restricted) {
      disabledAdminStore.disableUser(userId)
    } else {
      disabledAdminStore.enableUser(userId)
    }
    res.json({ ok: true, user_id: userId, restricted })
  })

  secured.post('/users/notify', async (req, res) => {
    const body = req.body
    const userId = isRecord(body) ? parsePositiveInt(body.user_id) : null
    const text = isRecord(body) ? parseNonEmptyString(body.text) : null
    if (!userId || !text) {
      res.status(400).json({ error: 'invalid user_id or text' })
      return
    }
    if (text.length > 2000) {
      res.status(400).json({ error: 'text is too long' })
      return
    }
    try {
      await deps.bot.api.sendMessageToUser(userId, text)
      res.json({ ok: true })
    } catch (err: unknown) {
      logger.warn('admin /users/notify failed', { userId, err })
      res.status(502).json({ error: 'не удалось отправить уведомление пользователю' })
    }
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
