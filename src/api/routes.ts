import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import type { Bot } from '@maxhub/max-bot-api'
import type { ChatMember } from '@maxhub/max-bot-api/types'
import express from 'express'
import multer from 'multer'

import { config, getTelegramToken } from '../config'
import { getDb } from '../db/database'
import { listTelegramChatAdministrators } from '../services/integrationPlatformClient'
import { buildBotJoinUrl } from '../utils/deeplink'
import { channelNotifyLinkStore } from '../services/channelNotifyLinkStore'
import { channelRegistry } from '../services/channelRegistry'
import { channelSubscriberSnapshotStore } from '../services/channelSubscriberSnapshotStore'
import {
  channelSettingsStore,
  parseManagerUrlInput,
} from '../services/channelSettingsStore'
import { disabledAdminStore } from '../services/disabledAdminStore'
import {
  resolveCanonicalChannelChatId,
  resolveChannelChatIdFromInviteParam,
} from '../services/resolveChannelChatId'
import { ensurePostFromChannelMessage, isUserChannelAdmin } from '../services/channelPostActions'
import { evaluateComment } from '../services/antispamService'
import type { Comment } from '../services/commentStore'
import { commentStore } from '../services/commentStore'
import { subscriberStore } from '../services/subscriberStore'
import {
  notifyAdminsNewMiniappComment,
  notifyUserAboutMiniappReply,
  syncAdminCommentNotification,
} from '../services/notificationService'
import { notifyTelegramAdminsNewMiniappComment, syncTelegramAdminCommentNotification } from '../services/telegramAdminNotificationService'
import {
  syncAdminReplyToTelegramThread,
  syncMaxCommentToTelegramThread,
} from '../services/telegramThreadReplySync'
import { canManageMaxCommentViaTelegram } from '../services/telegramCommentModerationService'
import { telegramBotUserStore } from '../services/telegramBotUserStore'
import { verifyTelegramMiniappAuth } from '../services/telegramMiniappAuth'
import {
  getTelegramChannelAdminsForMiniapp,
  getTelegramMiniappStats,
  listTelegramMiniappChannelsForUser,
  registerTelegramChannelByKeyForMiniappUser,
  registerTelegramChannelNotifyLink,
  resolveTelegramChannelInviteAccess,
} from '../services/telegramMiniappService'
import { telegramChannelRegistry } from '../services/telegramChannelRegistry'
import { telegramChannelNotifyLinkStore } from '../services/telegramChannelNotifyLinkStore'
import type { Post } from '../services/postStore'
import { isPostCommentsClosedInMax, postStore, resolveChannelPostUrl } from '../services/postStore'
import { rememberPostIdAlias } from '../services/postIdAliasStore'
import { resolveMiniappPostOpen } from '../services/miniappPostRecovery'
import { parseStartappPayload } from '../utils/startappPayload'
import { stateManager } from '../services/stateManager'
import {
  parseMiniappFeatureKey,
  userMiniappSettingsStore,
} from '../services/userMiniappSettingsStore'
import { fullyRemoveUserFromBot } from '../services/userAccessCleanup'
import { resolveMemberAvatarUrls, resolveMemberDisplayName } from '../utils/memberAvatar'
import {
  confirmChannelLinkDraft,
  createChannelLinkDraft,
  getChannelLinkDraftPreview,
  getOwnerProfileBundle,
  listChannelLinksForMaxUser,
  listChannelLinksForTelegramUser,
  syncOwnerProfileFromMiniapp,
} from '../services/channelLinkService'
import {
  profilePairingForPlatformUser,
  syncAllChannelLinkAdminTeamsForUser,
  syncChannelLinkAdminTeam,
} from '../services/channelLinkAdminTeamSync'
import { ensureAdminPanelStateLoaded, listTgChains } from '../api/adminPanelState'
import { integrationsStore } from '../services/integrationsStore'
import {
  createMaxPairingInvite,
  createTelegramPairingInvite,
  getAccountPairingStatus,
} from '../services/accountPairingService'
import { ownerProfileStore } from '../services/ownerProfileStore'
import {
  buildTelegramNotifyInviteUrlForMaxChannel,
  listSupplementalTelegramAdminsForMaxChannel,
  resolvePrimaryTelegramChannelChatIdForMax,
} from '../services/maxChannelTelegramAdminInvite'
import { cacheGetOrCompute } from '../cache/tieredCache'
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

function parseOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** NFKC: compatibility superscripts etc. → plain ASCII digits/letters for consistent rendering. */
function normalizeUserFacingText(value: string): string {
  try {
    return value.normalize('NFKC')
  } catch {
    return value
  }
}

function normalizePhotoUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.length > 2048) {
    return null
  }
  return trimmed
}

function parsePhotoUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: string[] = []
  for (const raw of value) {
    const normalized = normalizePhotoUrl(raw)
    if (normalized) {
      out.push(normalized)
    }
  }
  return [...new Set(out)].slice(0, 10)
}

function isTelegramMiniappPlatform(req: express.Request): boolean {
  const fromHeader = parseHeaderString(req.headers['x-miniapp-platform'])
  const fromQuery = parseNonEmptyString(req.query.platform)
  const raw = (fromHeader ?? fromQuery ?? '').toLowerCase()
  return raw === 'telegram' || raw === 'tg'
}

function parseTelegramChatIdQuery(value: unknown): string | null {
  const raw = parseNonEmptyString(value)
  if (!raw || !/^-?\d+$/.test(raw)) {
    return null
  }
  return raw
}

function parseHeaderString(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim()
    return t === '' ? null : t
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    const t = value[0].trim()
    return t === '' ? null : t
  }
  return null
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

function isAdminParamValue(value: unknown): boolean {
  if (value == null) {
    return false
  }
  const normalized = String(value).trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function isChannelAdminOrOwnerMember(m: ChatMember): boolean {
  return !m.is_bot && (m.is_admin || m.is_owner)
}

function adminDisplayInitials(name: string): string {
  const t = name.trim()
  if (t === '') {
    return '?'
  }
  const parts = t.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    const a = parts[0].charAt(0)
    const b = parts[parts.length - 1].charAt(0)
    return `${a}${b}`.toUpperCase()
  }
  return t.slice(0, 2).toUpperCase()
}

/**
 * Lists channel admins/owners: paginates {@link Bot.api.getChatMembers}, filters roles; if none found, uses {@link Bot.api.getChatAdmins}.
 */
async function listChannelAdminsForMiniApp(bot: Bot, chatId: number): Promise<ChatMember[]> {
  try {
    const { members } = await bot.api.getChatAdmins(chatId)
    const admins = members.filter(isChannelAdminOrOwnerMember)
    if (admins.length > 0) {
      return [...new Map(admins.map((m) => [m.user_id, m])).values()].sort(
        (a, b) => a.user_id - b.user_id,
      )
    }
  } catch (err: unknown) {
    logger.warn('listChannelAdminsForMiniApp: getChatAdmins failed, falling back to members list', {
      chatId,
      err,
    })
  }

  const byId = new Map<number, ChatMember>()
  let marker: number | undefined
  const pageSize = 100
  for (let page = 0; page < 100; page += 1) {
    const res = await bot.api.getChatMembers(chatId, {
      count: pageSize,
      ...(marker !== undefined ? { marker } : {}),
    })
    for (const m of res.members) {
      if (isChannelAdminOrOwnerMember(m)) {
        byId.set(m.user_id, m)
      }
    }
    const next = res.marker
    if (next === undefined || next === null) {
      break
    }
    marker = next
  }
  if (byId.size > 0) {
    return [...byId.values()].sort((a, b) => a.user_id - b.user_id)
  }
  const { members } = await bot.api.getChatAdmins(chatId)
  return members.filter(isChannelAdminOrOwnerMember).sort((a, b) => a.user_id - b.user_id)
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

const MINIAPP_ADMIN_CHANNELS_TTL_SEC = 120
const MINIAPP_CHANNEL_BRANDING_TTL_SEC = 300

async function listChannelChatIdsWhereUserIsAdminCached(bot: Bot, userId: number): Promise<number[]> {
  return cacheGetOrCompute(`miniapp:admin-channels:${userId}`, MINIAPP_ADMIN_CHANNELS_TTL_SEC, () =>
    listChannelChatIdsWhereUserIsAdmin(bot, userId),
  )
}

function userHasAnyComment(userId: number): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM comments WHERE user_id = ? LIMIT 1')
    .get(userId) as { ok: number } | undefined
  return row !== undefined
}

function userHasCommentsInChannel(userId: number, channelChatId: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS ok FROM comments c
       INNER JOIN posts p ON p.post_id = c.post_id
       WHERE c.user_id = ? AND p.chat_id = ?
       LIMIT 1`,
    )
    .get(userId, channelChatId) as { ok: number } | undefined
  return row !== undefined
}

function isChannelAdminFromSnapshot(userId: number, channelChatId: number): boolean {
  const targetAbs = Math.abs(channelChatId)
  for (const member of channelSubscriberSnapshotStore.listMembersForUser(userId)) {
    if (Math.abs(member.channel_chat_id) !== targetAbs) {
      continue
    }
    if (member.is_admin || member.is_owner) {
      return true
    }
  }
  return false
}

async function isUserAdminOfChannel(
  bot: Bot,
  channelChatId: number,
  userId: number,
): Promise<boolean> {
  if (isChannelAdminFromSnapshot(userId, channelChatId)) {
    return true
  }
  if (await isUserChannelAdmin(bot, channelChatId, userId)) {
    return true
  }
  const adminChannels = await listChannelChatIdsWhereUserIsAdminCached(bot, userId)
  return adminChannels.some((id) => Math.abs(id) === Math.abs(channelChatId))
}

function collectGateUserIds(platformUserId: number, isTelegram: boolean): number[] {
  const ids = [platformUserId]
  if (isTelegram) {
    const pairing = profilePairingForPlatformUser('telegram', platformUserId)
    if (pairing.max_user_id != null && !ids.includes(pairing.max_user_id)) {
      ids.push(pairing.max_user_id)
    }
  }
  return ids
}

function userHasPriorMiniappActivity(userIds: number[], channelChatId: number | null): boolean {
  for (const id of userIds) {
    if (userHasAnyComment(id)) {
      return true
    }
    if (channelChatId !== null && userHasCommentsInChannel(id, channelChatId)) {
      return true
    }
  }
  return false
}

async function resolveChannelBrandingCached(
  bot: Bot,
  chatId: number,
): Promise<{ title: string; avatar_url: string | null }> {
  return cacheGetOrCompute(
    `miniapp:channel-branding:${chatId}`,
    MINIAPP_CHANNEL_BRANDING_TTL_SEC,
    () => resolveChannelBranding(bot, chatId),
  )
}

async function resolveChannelBranding(
  bot: Bot,
  chatId: number,
): Promise<{ title: string; avatar_url: string | null }> {
  const title = channelRegistry.getChannel(chatId)?.title?.trim() || 'Канал'
  let avatar_url: string | null = null
  try {
    const chat = await bot.api.getChat(chatId)
    const raw = chat.icon?.url
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed) {
        avatar_url = trimmed
      }
    }
  } catch (err: unknown) {
    logger.warn('resolveChannelBranding: getChat failed', { chatId, err })
  }
  return { title, avatar_url }
}

function toWireComment(c: Comment): {
  comment_id: string
  post_id: string
  user_id: number
  username: string
  text: string
  timestamp: string
  avatar_url?: string
  photo_urls?: string[]
  posted_as_channel?: boolean
  source?: 'telegram' | 'max'
  answered_in_telegram?: boolean
  reply?: {
    reply_id?: string
    text: string
    timestamp: string
    admin_name?: string
    photo_urls?: string[]
    from_telegram?: boolean
  }
  replies?: {
    reply_id?: string
    text: string
    timestamp: string
    admin_name?: string
    photo_urls?: string[]
    from_telegram?: boolean
  }[]
} {
  const replies =
    Array.isArray(c.replies) && c.replies.length > 0
      ? c.replies
      : c.reply
        ? [c.reply]
        : undefined
  return {
    comment_id: c.comment_id,
    post_id: c.post_id,
    user_id: c.user_id,
    username: c.username,
    text: c.text,
    timestamp: c.timestamp,
    ...(c.avatar_url ? { avatar_url: c.avatar_url } : {}),
    ...(Array.isArray(c.photo_urls) && c.photo_urls.length > 0
      ? { photo_urls: c.photo_urls }
      : {}),
    ...(c.posted_as_channel ? { posted_as_channel: true } : {}),
    ...(c.source === 'telegram' ? { source: 'telegram' as const } : {}),
    ...(c.answered_in_telegram ? { answered_in_telegram: true } : {}),
    ...(c.reply ? { reply: c.reply } : {}),
    ...(replies ? { replies } : {}),
  }
}

async function enrichCommentsWithAvatars(
  bot: Bot,
  channelChatId: number,
  comments: Comment[],
): Promise<Comment[]> {
  const missingUserIds = new Set<number>()
  for (const c of comments) {
    if (c.posted_as_channel) {
      continue
    }
    if (!c.avatar_url?.trim()) {
      missingUserIds.add(c.user_id)
    }
  }
  if (missingUserIds.size === 0) {
    return comments
  }
  const urls = await resolveMemberAvatarUrls(bot, channelChatId, [...missingUserIds])
  if (urls.size === 0) {
    return comments
  }
  for (const c of comments) {
    if (c.posted_as_channel || c.avatar_url?.trim()) {
      continue
    }
    const url = urls.get(c.user_id)
    if (url) {
      commentStore.setCommentAvatarUrl(c.comment_id, url)
      c.avatar_url = url
    }
  }
  return comments
}

type AdminCommentAccess =
  | { ok: true; comment: Comment; post: Post }
  | { ok: false; status: number; error: string }

interface AdminModerationInput {
  commentId: string
  postId: string
  chatId: number
  userId: number
}

interface DisableChannelAdminInput {
  actorUserId: number
  targetUserId: number
  chatId: number
  targetPlatform: 'max' | 'telegram'
}

function parseAdminModerationBody(body: unknown): AdminModerationInput | null {
  if (!isRecord(body)) {
    return null
  }
  const commentId = parseNonEmptyString(body.comment_id)
  const postId = parseNonEmptyString(body.post_id)
  const chatId = parseNonZeroInt(body.chat_id)
  const userId = parsePositiveInt(body.user_id)
  if (!commentId || !postId || !chatId || !userId) {
    return null
  }
  return { commentId, postId, chatId, userId }
}

function parseDisableChannelAdminBody(body: unknown): DisableChannelAdminInput | null {
  if (!isRecord(body)) {
    return null
  }
  const actorUserId = parsePositiveInt(body.user_id)
  const targetUserId = parsePositiveInt(body.target_user_id)
  const chatId = parseNonZeroInt(body.chat_id)
  if (!actorUserId || !targetUserId || !chatId) {
    return null
  }
  const targetPlatform = body.target_platform === 'telegram' ? 'telegram' : 'max'
  return { actorUserId, targetUserId, chatId, targetPlatform }
}

async function resolveAdminCommentAccess(
  bot: Bot,
  input: { commentId: string; postId: string; chatId: number; userId: number },
): Promise<AdminCommentAccess> {
  const post = postStore.getPost(input.postId)
  if (!post || post.chat_id !== input.chatId) {
    return { ok: false, status: 404, error: 'post not found' }
  }
  if (!(await isUserChannelAdmin(bot, post.chat_id, input.userId))) {
    return { ok: false, status: 403, error: 'Только администраторы могут изменять комментарии' }
  }
  const comment = commentStore.getComment(input.commentId)
  if (!comment || comment.post_id !== input.postId) {
    return { ok: false, status: 404, error: 'comment not found' }
  }
  return { ok: true, comment, post }
}

const MINIAPP_UPLOADS_PUBLIC_PREFIX = '/miniapp/uploads'
const MINIAPP_UPLOADS_DIR = path.join(process.cwd(), 'miniapp', 'uploads')
const MAX_UPLOAD_FILES = 10
const MAX_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024

const miniappPhotoUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      fs.mkdirSync(MINIAPP_UPLOADS_DIR, { recursive: true })
      cb(null, MINIAPP_UPLOADS_DIR)
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase()
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg'
      cb(null, `${Date.now()}-${randomUUID()}${safeExt}`)
    },
  }),
  limits: {
    files: MAX_UPLOAD_FILES,
    fileSize: MAX_UPLOAD_SIZE_BYTES,
  },
  fileFilter(_req, file, cb) {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      cb(new Error('Можно загружать только изображения'))
      return
    }
    cb(null, true)
  },
})

/**
 * Express router for Mini App REST API (`/api/...`).
 */
export function createCommentApiRouter(deps: CommentApiRouterDeps): express.Router {
  const router = express.Router()
  router.use(express.json({ limit: '2mb' }))

  router.get('/config', (_req, res) => {
    res.json({
      bot_nickname: config.botNickname,
      telegram_bot_username: 'commentvmax_bot',
      mini_app_url: config.miniAppUrl ?? null,
      /** Bump when join UI changes — helps verify deploy (grep join-heading in /miniapp/index.html). */
      miniapp_join_ui: 'admin-invite-v2',
    })
  })

  router.get('/channel-info', async (req, res) => {
    if (isTelegramMiniappPlatform(req)) {
      const chatId = parseTelegramChatIdQuery(req.query.chat_id)
      if (!chatId) {
        res.status(400).json({ error: 'missing or invalid chat_id' })
        return
      }
      const cached = telegramChannelRegistry.getChannel(chatId)
      res.json({ title: cached?.title ?? null })
      return
    }
    const chatId = parseNonZeroInt(req.query.chat_id)
    if (chatId === null) {
      res.status(400).json({ error: 'missing or invalid chat_id' })
      return
    }
    const cached = channelRegistry.getChannel(chatId)
    if (cached?.title) {
      res.json({ title: cached.title })
      return
    }
    try {
      const chat = await deps.bot.api.getChat(chatId)
      res.json({ title: chat.title ?? null })
    } catch (err: unknown) {
      logger.warn('GET /channel-info: getChat failed', { chatId, err })
      res.json({ title: cached?.title ?? null })
    }
  })

  router.get('/user-status', async (req, res) => {
    const userId = parsePositiveInt(req.query.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    const chatId = parseNonZeroInt(req.query.chat_id)
    const isTelegram = isTelegramMiniappPlatform(req)
    const gateUserIds = collectGateUserIds(userId, isTelegram)
    const hasPriorActivity = userHasPriorMiniappActivity(gateUserIds, chatId)

    let isSubscriber = false
    let isAdmin = false

    if (isTelegram) {
      const pairing = profilePairingForPlatformUser('telegram', userId)
      isSubscriber =
        telegramBotUserStore.hasStarted(userId) ||
        subscriberStore.hasSubscriber(userId) ||
        (pairing.max_user_id != null && subscriberStore.hasSubscriber(pairing.max_user_id)) ||
        hasPriorActivity

      if (isAdminParamValue(req.query.admin)) {
        isAdmin = true
      } else if (chatId !== null) {
        const maxChatId = Math.abs(chatId)
        if (
          verifyTelegramMiniappAuth({
            telegramUserId: userId,
            maxChatId,
            tgUidRaw: parseNonEmptyString(req.query.tg_uid),
            tgExpRaw: parseNonEmptyString(req.query.tg_exp),
            tgSigRaw: parseNonEmptyString(req.query.tg_sig),
          })
        ) {
          isAdmin = true
        } else {
          try {
            isAdmin = await canManageMaxCommentViaTelegram(deps.bot, userId, maxChatId)
          } catch {
            isAdmin = false
          }
          if (!isAdmin) {
            for (const gateUserId of gateUserIds) {
              if (await isUserAdminOfChannel(deps.bot, chatId, gateUserId)) {
                isAdmin = true
                break
              }
            }
          }
        }
      } else {
        for (const gateUserId of gateUserIds) {
          const adminChannels = await listChannelChatIdsWhereUserIsAdminCached(deps.bot, gateUserId)
          if (adminChannels.length > 0) {
            isAdmin = true
            break
          }
        }
      }
    } else {
      isSubscriber = subscriberStore.hasSubscriber(userId) || hasPriorActivity
      if (chatId !== null) {
        isAdmin = await isUserAdminOfChannel(deps.bot, chatId, userId)
      } else {
        const adminChannels = await listChannelChatIdsWhereUserIsAdminCached(deps.bot, userId)
        isAdmin = adminChannels.length > 0
      }
    }

    if (isAdmin) {
      isSubscriber = true
    }

    const showSubscribeBanner = !isSubscriber && !isAdmin
    res.json({
      started: isSubscriber,
      is_admin: isAdmin,
      show_subscribe_banner: showSubscribeBanner,
      bot_nickname: isTelegram ? 'commentvmax_bot' : config.BOT_NICKNAME,
      telegram_bot_username: isTelegram ? 'commentvmax_bot' : null,
    })
  })

  router.post('/register-subscriber', (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const userId = parsePositiveInt(body.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    const chatId = parseNonZeroInt(body.chat_id)
    const source = parseNonEmptyString(body.source)
    const wasAlreadySubscribed = subscriberStore.hasSubscriber(userId)

    logger.info('register-subscriber called', {
      userId: body.user_id,
      chatId: body.chat_id,
      source: body.source,
      wasAlreadySubscribed,
    })

    if (isTelegramMiniappPlatform(req)) {
      telegramBotUserStore.markStarted({ id: userId })
    }
    subscriberStore.addSubscriber(userId)
    logger.info('subscriber registered', { userId, chatId, source })
    res.json({ ok: true })
  })

  router.get('/stats', async (req, res) => {
    const userId = parsePositiveInt(req.query.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    if (isTelegramMiniappPlatform(req)) {
      try {
        const stats = await getTelegramMiniappStats(userId)
        res.json(stats)
      } catch (err: unknown) {
        logger.error('GET /api/stats (telegram) failed', { err })
        res.status(500).json({ error: 'internal error' })
      }
      return
    }
    try {
      const adminChannelIds = await listChannelChatIdsWhereUserIsAdminCached(deps.bot, userId)
      let posts = 0
      let comments = 0
      for (const chatId of adminChannelIds) {
        posts += postStore.countPostsByChatId(chatId)
        comments += commentStore.countCommentsByChatId(chatId)
      }
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
    if (isTelegramMiniappPlatform(req)) {
      try {
        const payload = await listTelegramMiniappChannelsForUser(userId)
        res.json({
          channels: payload.channels,
          bot_nickname: payload.bot_username.replace(/^@/, ''),
        })
      } catch (err: unknown) {
        logger.error('GET /api/channels (telegram) failed', { err })
        res.status(500).json({ error: 'internal error' })
      }
      return
    }
    try {
      const adminChannelIds = await listChannelChatIdsWhereUserIsAdminCached(deps.bot, userId)
      const live = req.query.live === '1' || req.query.live === 'true'
      const channels = await Promise.all(
        adminChannelIds.map(async (chatId) => {
          const reg = channelRegistry.getChannel(chatId)
          let subscribers: number | null = null
          let avatar_url: string | null = null
          if (live) {
            try {
              const chat = await deps.bot.api.getChat(chatId)
              const raw = (chat as { participants_count?: unknown }).participants_count
              if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
                subscribers = raw
              }
              const iconRaw = chat.icon?.url
              if (typeof iconRaw === 'string') {
                const trimmed = iconRaw.trim()
                if (trimmed) {
                  avatar_url = trimmed
                }
              }
            } catch {
              subscribers = null
              avatar_url = null
            }
          }
          const pending = stateManager.isChannelPendingAdminRights(chatId)
          return {
            chat_id: chatId,
            title: reg?.title ?? null,
            subscribers,
            avatar_url,
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

  router.post('/telegram/channels/register', async (req, res) => {
    if (!isTelegramMiniappPlatform(req)) {
      res.status(400).json({ error: 'telegram miniapp only' })
      return
    }
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const userId = parsePositiveInt(body.user_id)
    const channelKey = parseNonEmptyString(body.channel)
    if (!userId || !channelKey) {
      res.status(400).json({ error: 'missing user_id or channel' })
      return
    }
    try {
      const channel = await registerTelegramChannelByKeyForMiniappUser(userId, channelKey)
      res.json({ ok: true, channel })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'channel not found') {
        res.status(404).json({ error: 'channel not found' })
        return
      }
      if (msg === 'forbidden') {
        res.status(403).json({ error: 'forbidden' })
        return
      }
      if (msg === 'not a channel') {
        res.status(400).json({ error: 'not a channel' })
        return
      }
      if (msg === 'telegram not configured') {
        res.status(503).json({ error: 'telegram not configured' })
        return
      }
      logger.error('POST /api/telegram/channels/register failed', { err })
      res.status(500).json({ error: 'internal error' })
    }
  })

  router.get('/channel-admins', async (req, res) => {
    const userId = parsePositiveInt(req.query.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id or chat_id' })
      return
    }
    if (isTelegramMiniappPlatform(req)) {
      const chatId = parseTelegramChatIdQuery(req.query.chat_id)
      if (!chatId) {
        res.status(400).json({ error: 'missing or invalid user_id or chat_id' })
        return
      }
      try {
        const payload = await getTelegramChannelAdminsForMiniapp(userId, chatId)
        res.json(payload)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === 'channel not connected') {
          res.status(404).json({ error: 'channel not connected' })
          return
        }
        if (msg === 'forbidden') {
          res.status(403).json({ error: 'Доступ запрещён' })
          return
        }
        logger.error('GET /api/channel-admins (telegram) failed', { err })
        res.status(500).json({ error: 'internal error' })
      }
      return
    }
    const chatIdRaw = parseNonZeroInt(req.query.chat_id)
    if (!chatIdRaw) {
      res.status(400).json({ error: 'missing or invalid user_id or chat_id' })
      return
    }
    const chatId = resolveCanonicalChannelChatId(chatIdRaw)
    if (chatId === null || !channelRegistry.getChannel(chatId)) {
      res.status(404).json({ error: 'channel not connected' })
      return
    }
    try {
      if (!(await isUserChannelAdmin(deps.bot, chatId, userId))) {
        res.status(403).json({ error: 'Доступ запрещён' })
        return
      }
      const members = await listChannelAdminsForMiniApp(deps.bot, chatId)
      const linkedIds = new Set(channelNotifyLinkStore.getUserIdsForChannel(chatId))
      const admins = members
        .map((m) => {
          const pairing = profilePairingForPlatformUser('max', m.user_id)
          return {
            user_id: m.user_id,
            name: m.name,
            initials: adminDisplayInitials(m.name),
            linked: linkedIds.has(m.user_id),
            paired: pairing.paired,
            max_user_id: pairing.max_user_id,
            tg_user_id: pairing.tg_user_id,
            peer_platform:
              pairing.tg_user_id != null
                ? ('telegram' as const)
                : pairing.paired
                  ? ('telegram' as const)
                  : null,
          }
        })
        .filter((a) => !disabledAdminStore.isDisabled(a.user_id))
      const listedIds = new Set(admins.map((a) => a.user_id))
      for (const linkedUserId of linkedIds) {
        if (listedIds.has(linkedUserId)) {
          continue
        }
        try {
          const { members: linkedMembers } = await deps.bot.api.getChatMembers(chatId, {
            user_ids: [linkedUserId],
          })
          const m = linkedMembers[0]
          if (m && isChannelAdminOrOwnerMember(m)) {
            if (disabledAdminStore.isDisabled(m.user_id)) {
              continue
            }
            const pairing = profilePairingForPlatformUser('max', m.user_id)
            admins.push({
              user_id: m.user_id,
              name: m.name,
              initials: adminDisplayInitials(m.name),
              linked: true,
              paired: pairing.paired,
              max_user_id: pairing.max_user_id,
              tg_user_id: pairing.tg_user_id,
              peer_platform:
                pairing.tg_user_id != null
                  ? ('telegram' as const)
                  : pairing.paired
                    ? ('telegram' as const)
                    : null,
            })
            listedIds.add(m.user_id)
          }
        } catch (err: unknown) {
          logger.warn('GET /api/channel-admins: could not resolve linked admin', {
            chatId,
            linkedUserId,
            err,
          })
        }
      }
      const maxAdminIds = new Set(admins.map((a) => a.user_id))
      await integrationsStore.load()
      const tgToken = (integrationsStore.getTelegramIntegration()?.token?.trim() || getTelegramToken()).trim()
      const supplemental = await listSupplementalTelegramAdminsForMaxChannel(chatId, maxAdminIds, tgToken)
      for (const row of supplemental.admins) {
        if (disabledAdminStore.isDisabled(row.user_id)) {
          continue
        }
        admins.push(row)
      }
      admins.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
      logger.info('GET /api/channel-admins', {
        chatId,
        chatIdRaw,
        requestUserId: userId,
        linkedUserIds: [...linkedIds],
        adminUserIds: admins.map((a) => a.user_id),
        tgOnlyCount: supplemental.admins.length,
      })
      const invite_url = buildBotJoinUrl(chatId)
      const invite_url_telegram = buildTelegramNotifyInviteUrlForMaxChannel(chatId)
      res.json({
        admins,
        invite_url,
        ...(invite_url_telegram ? { invite_url_telegram } : {}),
      })
    } catch (err: unknown) {
      logger.error('GET /api/channel-admins failed', { err })
      res.status(500).json({ error: 'internal error' })
    }
  })

  router.post('/channel-admins/disable', async (req, res) => {
    const input = parseDisableChannelAdminBody(req.body)
    if (!input) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }
    if (isTelegramMiniappPlatform(req)) {
      const body = req.body
      if (!isRecord(body)) {
        res.status(400).json({ error: 'missing or invalid fields' })
        return
      }
      const actorUserId = parsePositiveInt(body.user_id)
      const targetUserId = parsePositiveInt(body.target_user_id)
      const chatId = parseTelegramChatIdQuery(body.chat_id)
      if (!actorUserId || !targetUserId || !chatId) {
        res.status(400).json({ error: 'missing or invalid fields' })
        return
      }
      if (!telegramChannelRegistry.getChannel(chatId)) {
        res.status(404).json({ error: 'channel not connected' })
        return
      }
      try {
        const token = getTelegramToken()
        const admins = await listTelegramChatAdministrators(token, chatId)
        const isActorAdmin = admins.some((a) => a.userId === actorUserId)
        if (!isActorAdmin) {
          res.status(403).json({ error: 'Доступ запрещён' })
          return
        }
        telegramChannelNotifyLinkStore.removeUserFromChannel(targetUserId, chatId)
        res.json({ ok: true })
      } catch (err: unknown) {
        logger.error('POST /api/channel-admins/disable (telegram) failed', {
          err,
          actorUserId,
          targetUserId,
          chatId,
        })
        res.status(500).json({ error: 'internal error' })
      }
      return
    }
    const chatId = resolveCanonicalChannelChatId(input.chatId)
    if (chatId === null || !channelRegistry.getChannel(chatId)) {
      res.status(404).json({ error: 'channel not connected' })
      return
    }
    if (input.targetUserId === config.ownerUserId) {
      res.status(400).json({ error: 'owner cannot be disabled' })
      return
    }
    try {
      if (!(await isUserChannelAdmin(deps.bot, chatId, input.actorUserId))) {
        res.status(403).json({ error: 'Доступ запрещён' })
        return
      }
      if (input.targetPlatform === 'telegram') {
        await integrationsStore.load()
        const tgChatId = resolvePrimaryTelegramChannelChatIdForMax(chatId)
        if (!tgChatId) {
          res.status(400).json({ error: 'telegram channel not linked' })
          return
        }
        const tgToken = (integrationsStore.getTelegramIntegration()?.token?.trim() || getTelegramToken()).trim()
        if (!tgToken) {
          res.status(400).json({ error: 'telegram not connected' })
          return
        }
        const tgAdmins = await listTelegramChatAdministrators(tgToken, tgChatId)
        if (!tgAdmins.some((a) => a.userId === input.targetUserId)) {
          res.status(400).json({ error: 'target user is not a telegram channel admin' })
          return
        }
        telegramChannelNotifyLinkStore.removeUserFromChannel(input.targetUserId, tgChatId)
        res.json({ ok: true })
        return
      }
      if (!(await isUserChannelAdmin(deps.bot, chatId, input.targetUserId))) {
        res.status(400).json({ error: 'target user is not a channel admin' })
        return
      }
      disabledAdminStore.disableUser(input.targetUserId)
      fullyRemoveUserFromBot(input.targetUserId)
      res.json({ ok: true })
    } catch (err: unknown) {
      logger.error('POST /api/channel-admins/disable failed', { err, chatId, input })
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

  router.get('/channel-settings', async (req, res) => {
    const chatIdRaw = parseNonZeroInt(req.query.chat_id)
    if (!chatIdRaw) {
      res.status(400).json({ error: 'missing or invalid chat_id' })
      return
    }
    const chatId = resolveCanonicalChannelChatId(chatIdRaw)
    if (chatId === null || !channelRegistry.getChannel(chatId)) {
      res.status(404).json({ error: 'channel not connected' })
      return
    }
    const fields = parseNonEmptyString(req.query.fields)
    const userId = parsePositiveInt(req.query.user_id)
    const managerOnly =
      fields === 'manager_url' || userId === null

    if (managerOnly) {
      res.json({ manager_url: channelSettingsStore.getManagerUrl(chatId) })
      return
    }

    try {
      if (!(await isUserChannelAdmin(deps.bot, chatId, userId))) {
        res.json({ manager_url: channelSettingsStore.getManagerUrl(chatId) })
        return
      }
      res.json(channelSettingsStore.getSettings(chatId))
    } catch (err: unknown) {
      logger.error('GET /api/channel-settings failed', { err, chatId })
      res.status(500).json({ error: 'internal error' })
    }
  })

  router.post('/channel-settings', async (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const userId = parsePositiveInt(body.user_id)
    const chatIdRaw = parseNonZeroInt(body.chat_id)
    if (!userId || !chatIdRaw) {
      res.status(400).json({ error: 'missing or invalid user_id or chat_id' })
      return
    }
    const chatId = resolveCanonicalChannelChatId(chatIdRaw)
    if (chatId === null || !channelRegistry.getChannel(chatId)) {
      res.status(404).json({ error: 'channel not connected' })
      return
    }
    if (!('manager_url' in body)) {
      res.status(400).json({ error: 'missing manager_url' })
      return
    }
    const managerUrl = parseManagerUrlInput(body.manager_url)
    if (managerUrl === 'invalid') {
      res.status(400).json({ error: 'invalid manager_url' })
      return
    }
    try {
      if (!(await isUserChannelAdmin(deps.bot, chatId, userId))) {
        res.status(403).json({ error: 'Доступ запрещён' })
        return
      }
      const next = channelSettingsStore.setManagerUrl(chatId, managerUrl)
      res.json(next)
    } catch (err: unknown) {
      logger.error('POST /api/channel-settings failed', { err, chatId, userId })
      res.status(500).json({ error: 'internal error' })
    }
  })

  async function resolveChannelInviteAccess(
    userId: number,
    joinChannelIdRaw: string | null,
  ): Promise<
    | { ok: true; channelChatId: number; title: string | null }
    | { ok: false; status: 400 | 403 | 404; error: string }
  > {
    if (!joinChannelIdRaw) {
      return { ok: false, status: 400, error: 'missing or invalid join_channel_id' }
    }
    const channelChatId = resolveChannelChatIdFromInviteParam(joinChannelIdRaw)
    if (channelChatId === null) {
      return { ok: false, status: 400, error: 'missing or invalid join_channel_id' }
    }
    const reg = channelRegistry.getChannel(channelChatId)
    if (!reg) {
      return { ok: false, status: 404, error: 'channel is not connected to this bot' }
    }
    return { ok: true, channelChatId, title: reg.title }
  }

  router.get('/channel-invite', async (req, res) => {
    const userId = parsePositiveInt(req.query.user_id)
    const joinChannelIdRaw = parseNonEmptyString(req.query.join_channel_id)
    if (!userId || !joinChannelIdRaw) {
      res.status(400).json({ error: 'missing user_id or join_channel_id' })
      return
    }
    if (isTelegramMiniappPlatform(req)) {
      try {
        const access = await resolveTelegramChannelInviteAccess(userId, joinChannelIdRaw)
        if (!access.ok) {
          res.status(access.status).json({ error: access.error })
          return
        }
        res.json({
          ok: true,
          channel_title: access.title,
          already_linked: telegramChannelNotifyLinkStore.isLinked(userId, access.channelChatId),
        })
      } catch (err: unknown) {
        logger.error('GET /api/channel-invite (telegram) failed', { err })
        res.status(500).json({ error: 'internal error' })
      }
      return
    }
    try {
      const access = await resolveChannelInviteAccess(userId, joinChannelIdRaw)
      if (!access.ok) {
        res.status(access.status).json({ error: access.error })
        return
      }
      res.json({
        ok: true,
        channel_title: access.title,
        already_linked: channelNotifyLinkStore.isLinked(userId, access.channelChatId),
      })
    } catch (err: unknown) {
      logger.error('GET /api/channel-invite failed', { err })
      res.status(500).json({ error: 'internal error' })
    }
  })

  router.post('/channel-invite', async (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const userId = parsePositiveInt(body.user_id)
    const joinChannelIdRaw = parseNonEmptyString(body.join_channel_id)
    if (!userId || !joinChannelIdRaw) {
      res.status(400).json({ error: 'missing user_id or join_channel_id' })
      return
    }
    if (isTelegramMiniappPlatform(req)) {
      try {
        const result = await registerTelegramChannelNotifyLink(userId, joinChannelIdRaw)
        res.json({
          ok: true,
          channel_title: result.channel_title,
          already_linked: result.already_linked,
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('not connected')) {
          res.status(404).json({ error: 'channel is not connected to this bot' })
          return
        }
        logger.error('POST /api/channel-invite (telegram) failed', { err })
        res.status(500).json({ error: 'internal error' })
      }
      return
    }
    try {
      const access = await resolveChannelInviteAccess(userId, joinChannelIdRaw)
      if (!access.ok) {
        res.status(access.status).json({ error: access.error })
        return
      }
      const wasLinked = channelNotifyLinkStore.isLinked(userId, access.channelChatId)
      channelNotifyLinkStore.register(userId, access.channelChatId)
      subscriberStore.addSubscriber(userId)
      await channelNotifyLinkStore.forcePersist()
      res.json({
        ok: true,
        channel_title: access.title,
        already_linked: wasLinked,
      })
    } catch (err: unknown) {
      logger.error('POST /api/channel-invite failed', { err })
      res.status(500).json({ error: 'internal error' })
    }
  })

  function parseOwnerAccountFromBody(
    body: Record<string, unknown>,
    platform: 'max' | 'telegram',
    userId: number,
  ) {
    return {
      platform,
      platformUserId: userId,
      username: parseOptionalString(body.username) || null,
      firstName: parseOptionalString(body.first_name) || null,
      lastName: parseOptionalString(body.last_name) || null,
      photoUrl: normalizePhotoUrl(body.photo_url),
    }
  }

  function mapChannelLinkError(err: unknown): { status: number; error: string } {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'forbidden') {
      return { status: 403, error: 'Доступ запрещён' }
    }
    if (msg === 'invalid code' || msg === 'code not available' || msg === 'code expired') {
      return { status: 404, error: 'Код не найден или истёк' }
    }
    if (msg === 'not awaiting confirm') {
      return { status: 409, error: 'Связка уже подтверждена или код недоступен' }
    }
    if (msg === 'max channel already linked' || msg === 'pair already linked') {
      return { status: 409, error: 'Эта связка уже существует' }
    }
    if (msg === 'max channel not connected' || msg === 'telegram channel not connected') {
      return { status: 404, error: 'Канал не подключён к боту' }
    }
    if (msg === 'max channel pending admin rights' || msg === 'telegram bot is not admin') {
      return { status: 400, error: 'Боту нужны права администратора в канале' }
    }
    if (msg === 'invalid tg channel') {
      return { status: 400, error: 'Некорректный Telegram-канал' }
    }
    if (msg === 'chain not found' || msg === 'chain has no telegram channel id') {
      return { status: 404, error: 'Связка не найдена' }
    }
    return { status: 500, error: 'internal error' }
  }

  router.post('/owner-profile/sync', async (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const userId = parsePositiveInt(body.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    const platform = isTelegramMiniappPlatform(req) ? 'telegram' : 'max'
    try {
      const result = await syncOwnerProfileFromMiniapp(
        platform,
        parseOwnerAccountFromBody(body, platform, userId),
      )
      res.json({ ok: true, ...result, accounts: getOwnerProfileBundle(result.profile_id).accounts })
    } catch (err: unknown) {
      logger.error('POST /api/owner-profile/sync failed', { err })
      res.status(500).json({ error: 'internal error' })
    }
  })

  function mapAccountPairingError(err: unknown): { status: number; error: string } {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'telegram already linked' || msg === 'max already linked') {
      return { status: 409, error: 'Аккаунт уже привязан' }
    }
    if (msg === 'invalid initiator platform') {
      return { status: 400, error: 'Неверная платформа' }
    }
    return { status: 500, error: 'internal error' }
  }

  router.get('/account-pairing/status', async (req, res) => {
    const userId = parsePositiveInt(req.query.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    const platform = isTelegramMiniappPlatform(req) ? 'telegram' : 'max'
    res.json(getAccountPairingStatus(platform, userId))
  })

  router.post('/account-pairing/invite-telegram', async (req, res) => {
    if (isTelegramMiniappPlatform(req)) {
      res.status(400).json({ error: 'only from MAX miniapp' })
      return
    }
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const userId = parsePositiveInt(body.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    try {
      const invite = createTelegramPairingInvite(parseOwnerAccountFromBody(body, 'max', userId))
      res.json({ ok: true, ...invite })
    } catch (err: unknown) {
      const mapped = mapAccountPairingError(err)
      if (mapped.status >= 500) {
        logger.error('POST /api/account-pairing/invite-telegram failed', { err })
      }
      res.status(mapped.status).json({ error: mapped.error })
    }
  })

  router.post('/account-pairing/invite-max', async (req, res) => {
    if (!isTelegramMiniappPlatform(req)) {
      res.status(400).json({ error: 'only from Telegram miniapp' })
      return
    }
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const userId = parsePositiveInt(body.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    try {
      const invite = createMaxPairingInvite(parseOwnerAccountFromBody(body, 'telegram', userId))
      res.json({ ok: true, ...invite })
    } catch (err: unknown) {
      const mapped = mapAccountPairingError(err)
      if (mapped.status >= 500) {
        logger.error('POST /api/account-pairing/invite-max failed', { err })
      }
      res.status(mapped.status).json({ error: mapped.error })
    }
  })

  router.get('/owner-profile', async (req, res) => {
    const userId = parsePositiveInt(req.query.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    const platform = isTelegramMiniappPlatform(req) ? 'telegram' : 'max'
    const profileId = ownerProfileStore.getProfileId(platform, userId)
    if (!profileId) {
      res.json({ profile_id: null, accounts: [] })
      return
    }
    res.json(getOwnerProfileBundle(profileId))
  })

  router.post('/channel-links/sync-admin-team', async (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const userId = parsePositiveInt(body.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    const linkId = parseNonEmptyString(body.link_id)
    try {
      await integrationsStore.load()
      const integ = integrationsStore.getTelegramIntegration()
      const tgToken = (integ?.token?.trim() || getTelegramToken()).trim()
      if (!tgToken) {
        res.status(400).json({ error: 'telegram not connected' })
        return
      }
      await ensureAdminPanelStateLoaded()
      const isTg = isTelegramMiniappPlatform(req)
      let linkIds: string[] = []
      if (linkId) {
        linkIds = [linkId]
      } else if (isTg) {
        const links = await listChannelLinksForTelegramUser(tgToken, userId)
        linkIds = links.map((l) => l.id)
      } else {
        const links = await listChannelLinksForMaxUser(deps.bot, userId)
        linkIds = links.map((l) => l.id)
      }
      const chains = (await listTgChains()).filter((c) => linkIds.includes(c.id))
      if (chains.length === 0) {
        res.status(404).json({ error: 'Нет связок для синхронизации' })
        return
      }
      const results = await syncAllChannelLinkAdminTeamsForUser(deps.bot, tgToken, {
        chains,
        actorMaxUserId: isTg ? undefined : userId,
        actorTgUserId: isTg ? userId : undefined,
      })
      if (results.length === 0 && linkId) {
        const single = await syncChannelLinkAdminTeam(deps.bot, tgToken, {
          chainId: linkId,
          actorMaxUserId: isTg ? undefined : userId,
          actorTgUserId: isTg ? userId : undefined,
        })
        res.json({ ok: true, results: [single] })
        return
      }
      res.json({ ok: true, results })
    } catch (err: unknown) {
      const mapped = mapChannelLinkError(err)
      if (mapped.status >= 500) {
        logger.error('POST /api/channel-links/sync-admin-team failed', { err })
      }
      res.status(mapped.status).json({ error: mapped.error })
    }
  })

  router.get('/channel-links', async (req, res) => {
    const userId = parsePositiveInt(req.query.user_id)
    if (!userId) {
      res.status(400).json({ error: 'missing or invalid user_id' })
      return
    }
    try {
      if (isTelegramMiniappPlatform(req)) {
        await integrationsStore.load()
        const integ = integrationsStore.getTelegramIntegration()
        const token = (integ?.token?.trim() || getTelegramToken()).trim()
        if (!token) {
          res.json({ links: [] })
          return
        }
        const links = await listChannelLinksForTelegramUser(token, userId)
        res.json({ links })
        return
      }
      const links = await listChannelLinksForMaxUser(deps.bot, userId)
      res.json({ links })
    } catch (err: unknown) {
      logger.error('GET /api/channel-links failed', { err })
      res.status(500).json({ error: 'internal error' })
    }
  })

  router.post('/channel-link-drafts', async (req, res) => {
    if (isTelegramMiniappPlatform(req)) {
      res.status(400).json({ error: 'create draft from MAX miniapp only' })
      return
    }
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const userId = parsePositiveInt(body.user_id)
    const maxChatId = parseNonZeroInt(body.max_chat_id)
    if (!userId || maxChatId === null) {
      res.status(400).json({ error: 'missing user_id or max_chat_id' })
      return
    }
    try {
      const payload = await createChannelLinkDraft(deps.bot, {
        maxUserId: userId,
        maxChatId,
        account: parseOwnerAccountFromBody(body, 'max', userId),
      })
      res.json({ ok: true, ...payload })
    } catch (err: unknown) {
      const mapped = mapChannelLinkError(err)
      if (mapped.status >= 500) {
        logger.error('POST /api/channel-link-drafts failed', { err })
      }
      res.status(mapped.status).json({ error: mapped.error })
    }
  })

  router.get('/channel-link-drafts/:code', async (req, res) => {
    const code = parseNonEmptyString(req.params.code)
    if (!code) {
      res.status(400).json({ error: 'invalid code' })
      return
    }
    const preview = getChannelLinkDraftPreview(code)
    if (!preview) {
      res.status(404).json({ error: 'Код не найден' })
      return
    }
    res.json(preview)
  })

  router.post('/channel-link-drafts/:code/confirm', async (req, res) => {
    if (!isTelegramMiniappPlatform(req)) {
      res.status(400).json({ error: 'confirm from Telegram miniapp only' })
      return
    }
    const code = parseNonEmptyString(req.params.code)
    const body = req.body
    if (!code || !isRecord(body)) {
      res.status(400).json({ error: 'invalid code or body' })
      return
    }
    const userId = parsePositiveInt(body.user_id)
    const tgChannelId = parseTelegramChatIdQuery(body.tg_channel_id)
    if (!userId || !tgChannelId) {
      res.status(400).json({ error: 'missing user_id or tg_channel_id' })
      return
    }
    await integrationsStore.load()
    const integ = integrationsStore.getTelegramIntegration()
    const token = (integ?.token?.trim() || getTelegramToken()).trim()
    if (!token) {
      res.status(503).json({ error: 'telegram bot not configured' })
      return
    }
    try {
      const forwardPosts = parseBoolean(body.forward_posts)
      const addCommentsButton = parseBoolean(body.add_comments_button)
      const result = await confirmChannelLinkDraft(
        token,
        {
          code,
          tgUserId: userId,
          tgChannelId,
          account: parseOwnerAccountFromBody(body, 'telegram', userId),
          forwardPosts: forwardPosts === null ? true : forwardPosts,
          addCommentsButton: addCommentsButton === null ? true : addCommentsButton,
        },
        { maxBot: deps.bot },
      )
      res.json({
        ok: true,
        status: result.status,
        profile_id: result.profile_id,
        max_title: result.max_title,
        tg_title: result.tg_title,
        message:
          'Код принят. Инициатору в MAX отправлено сообщение — нужно нажать «Подтвердить связку» в боте.',
      })
    } catch (err: unknown) {
      const mapped = mapChannelLinkError(err)
      if (mapped.status >= 500) {
        logger.error('POST /api/channel-link-drafts/confirm failed', { err })
      }
      res.status(mapped.status).json({ error: mapped.error })
    }
  })

  interface MiniappPostLookup {
    postId: string
    chatIdRaw: number | null
    messageMid: string | null
    startParamUsed: string | null
  }

  function buildMiniappPostLookup(
    pathPostId: string,
    chatIdRaw: number | null,
    messageMid: string | null,
    startParamRaw: string | null,
  ): MiniappPostLookup {
    let postId = pathPostId.trim()
    let chatId = chatIdRaw
    let mid = messageMid
    let startParamUsed: string | null = null

    const startCandidates = [
      startParamRaw,
      pathPostId.trim().toLowerCase().startsWith('pid_') ? pathPostId.trim() : null,
    ].filter((v): v is string => typeof v === 'string' && v.trim() !== '')

    for (const raw of startCandidates) {
      const parsed = parseStartappPayload(raw)
      if (!parsed?.post_id) {
        continue
      }
      startParamUsed = raw.trim()
      postId = parsed.post_id
      if (parsed.chat_id !== undefined) {
        chatId = parsed.chat_id
      }
      if (parsed.message_mid) {
        mid = parsed.message_mid
      }
    }

    return { postId, chatIdRaw: chatId, messageMid: mid, startParamUsed }
  }

  function resolvePostForMiniApp(postId: string, chatIdRaw: number | null, messageMid: string | null) {
    const id = postId.trim()
    const mid = messageMid?.trim() ?? ''
    if (chatIdRaw !== null && mid !== '') {
      const byChannelMessage = postStore.findPostByChannelMessage(chatIdRaw, mid)
      if (byChannelMessage) {
        if (id !== '' && byChannelMessage.post_id !== id) {
          logger.warn('GET /post: post_id в ссылке не совпадает с message_mid — берём пост по mid', {
            requestedPostId: id,
            postId: byChannelMessage.post_id,
            chatId: chatIdRaw,
            messageMid: mid,
          })
          rememberPostIdAlias(id, byChannelMessage)
        }
        return byChannelMessage
      }
    }
    if (mid !== '') {
      const byMessageMid = postStore.findByMessageMid(mid)
      if (byMessageMid) {
        if (id !== '' && byMessageMid.post_id !== id) {
          logger.warn('GET /post: post_id в ссылке не совпадает с глобальным поиском по message_mid', {
            requestedPostId: id,
            postId: byMessageMid.post_id,
            chatId: chatIdRaw,
            messageMid: mid,
          })
          rememberPostIdAlias(id, byMessageMid)
        }
        return byMessageMid
      }
    }
    if (!id) {
      return null
    }
    return postStore.findPost(id, chatIdRaw ?? undefined, { logNotFound: false })
  }

  async function resolvePostForMiniAppOpen(
    pathPostId: string,
    chatIdRaw: number | null,
    messageMid: string | null,
    startParamRaw: string | null = null,
  ): Promise<Post | null> {
    const lookup = buildMiniappPostLookup(pathPostId, chatIdRaw, messageMid, startParamRaw)
    if (lookup.startParamUsed) {
      logger.info('miniapp: resolved lookup from start_param', {
        pathPostId,
        startParam: lookup.startParamUsed,
        postId: lookup.postId,
        chatId: lookup.chatIdRaw,
        messageMid: lookup.messageMid,
      })
    }
    return resolveMiniappPostOpen(deps.bot, lookup, resolvePostForMiniApp)
  }

  router.get('/post/:postId', async (req, res) => {
    const chatIdRaw = parseNonZeroInt(req.query.chat_id)
    const messageMid = parseNonEmptyString(req.query.message_mid)
    const startParamHeader = parseNonEmptyString(req.headers['x-miniapp-start-param'])
    const requestUserId =
      parseNonEmptyString(req.headers['x-miniapp-user-id']) ?? parseNonEmptyString(req.query.user_id)
    logger.info('miniapp: opened', {
      startParam: startParamHeader,
      userId: requestUserId,
      chatId: chatIdRaw,
    })
    const post = await resolvePostForMiniAppOpen(
      req.params.postId,
      chatIdRaw,
      messageMid,
      startParamHeader,
    )
    if (!post) {
      res.status(404).json({ error: 'post not found' })
      return
    }
    const channelBranding = await resolveChannelBrandingCached(deps.bot, post.chat_id)
    const channel_post_url = post.channel_post_url?.trim() || null
    res.json({
      post_id: post.post_id,
      text: post.text,
      photo_url: post.photo_url ?? null,
      channel_post_url,
      chat_id: post.chat_id,
      message_mid: post.message_mid,
      comment_count: post.comment_count,
      comments_booked_by: post.comments_booked_by ?? null,
      comments_closed: isPostCommentsClosedInMax(post),
      channel_title: channelBranding.title,
      channel_avatar_url: channelBranding.avatar_url,
    })
  })

  router.post('/post/:postId/refresh', async (req, res) => {
    const chatIdRaw = parseNonZeroInt(req.query.chat_id)
    const messageMid = parseNonEmptyString(req.query.message_mid)
    const startParamHeader = parseNonEmptyString(req.headers['x-miniapp-start-param'])
    const lookup = buildMiniappPostLookup(req.params.postId, chatIdRaw, messageMid, startParamHeader)
    const hadRowBefore =
      (lookup.messageMid &&
        lookup.chatIdRaw !== null &&
        postStore.findPostByChannelMessage(
          resolveCanonicalChannelChatId(lookup.chatIdRaw) ?? lookup.chatIdRaw,
          lookup.messageMid,
        )) ||
      (lookup.postId ? postStore.getPost(lookup.postId) : null)

    const post = await resolvePostForMiniAppOpen(
      req.params.postId,
      chatIdRaw,
      messageMid,
      startParamHeader,
    )
    if (!post) {
      res.status(404).json({ error: 'post not found' })
      return
    }
    res.json({
      ok: true,
      restored: !hadRowBefore,
      post_id: post.post_id,
      chat_id: post.chat_id,
      message_mid: post.message_mid,
    })
  })

  router.get('/post/:postId/channel-url', async (req, res) => {
    const chatIdRaw = parseNonZeroInt(req.query.chat_id)
    const messageMid = parseNonEmptyString(req.query.message_mid)
    const startParamHeader = parseNonEmptyString(req.headers['x-miniapp-start-param'])
    const post = await resolvePostForMiniAppOpen(
      req.params.postId,
      chatIdRaw,
      messageMid,
      startParamHeader,
    )
    if (!post) {
      res.status(404).json({ error: 'post not found' })
      return
    }
    let url: string | null = null
    try {
      url = await resolveChannelPostUrl(deps.bot, post)
    } catch (err: unknown) {
      logger.warn('GET /post/:postId/channel-url: resolve failed', {
        postId: post.post_id,
        err,
      })
    }
    res.json({ url })
  })

  router.get('/comments/:postId', async (req, res) => {
    const postId = req.params.postId
    const chatIdRaw = parseNonZeroInt(req.query.chat_id)
    const messageMid = parseNonEmptyString(req.query.message_mid)
    const startParamHeader = parseNonEmptyString(req.headers['x-miniapp-start-param'])
    const requestUserId =
      parseNonEmptyString(req.headers['x-miniapp-user-id']) ?? parseNonEmptyString(req.query.user_id)
    logger.info('miniapp: opened', {
      startParam: startParamHeader,
      userId: requestUserId,
      chatId: chatIdRaw,
    })
    const post = await resolvePostForMiniAppOpen(postId, chatIdRaw, messageMid, startParamHeader)
    if (!post) {
      res.status(404).json({ error: 'post not found' })
      return
    }
    const resolvedPostId = post.post_id
    try {
      const comments = commentStore.getComments(resolvedPostId)
      const enriched = await enrichCommentsWithAvatars(deps.bot, post.chat_id, comments)
      logger.info('miniapp: comments loaded', {
        postId: resolvedPostId,
        commentCount: enriched.length,
      })
      res.json(enriched.map(toWireComment))
    } catch (err: unknown) {
      logger.error('GET /api/comments/:postId failed', { postId: resolvedPostId, err })
      res.status(500).json({ error: 'internal error' })
    }
  })

  router.post('/upload-photos', (req, res) => {
    miniappPhotoUpload.array('photos', MAX_UPLOAD_FILES)(req, res, (err: unknown) => {
      if (err instanceof Error) {
        res.status(400).json({ error: err.message || 'Ошибка загрузки фото' })
        return
      }
      const files = Array.isArray(req.files) ? req.files : []
      const urls = files
        .map((f) => {
          const name = path.basename(f.filename)
          return `${MINIAPP_UPLOADS_PUBLIC_PREFIX}/${encodeURIComponent(name)}`
        })
        .slice(0, MAX_UPLOAD_FILES)
      res.json({ photo_urls: urls })
    })
  })

  router.post('/comment', async (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const postId = parseNonEmptyString(body.post_id)
    const chatId = parseNonZeroInt(body.chat_id)
    const messageMid = parseNonEmptyString(body.message_mid)
    const startParamHeader = parseNonEmptyString(req.headers['x-miniapp-start-param'])
    const userId = parsePositiveInt(body.user_id)
    const username = parseNonEmptyString(body.username)
    const text = normalizeUserFacingText(parseOptionalString(body.text))
    const photoUrls = parsePhotoUrls(body.photo_urls)
    const avatarFromClient =
      parseNonEmptyString(body.avatar_url) ?? parseNonEmptyString(body.photo_url)
    if (!postId || !chatId || !userId || !username || (text === '' && photoUrls.length === 0)) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }

    const post = await resolvePostForMiniAppOpen(postId, chatId, messageMid, startParamHeader)
    if (!post) {
      res.status(404).json({ error: 'post not found' })
      return
    }
    const canonicalPostChatId = resolveCanonicalChannelChatId(post.chat_id) ?? post.chat_id
    const canonicalRequestChatId = resolveCanonicalChannelChatId(chatId) ?? chatId
    if (canonicalPostChatId !== canonicalRequestChatId) {
      res.status(403).json({ error: 'Доступ запрещён' })
      return
    }
    if (isPostCommentsClosedInMax(post)) {
      res.status(403).json({
        error: 'comments_closed',
        message: 'Комментарии закрыты. Обсуждение ведётся в Telegram.',
      })
      return
    }

    const postAsChannel = await isUserChannelAdmin(deps.bot, chatId, userId)
    let saveUsername = username
    let avatarUrl = avatarFromClient
    let postedAsChannel = false
    if (postAsChannel) {
      const branding = await resolveChannelBranding(deps.bot, chatId)
      saveUsername = branding.title
      avatarUrl = branding.avatar_url ?? null
      postedAsChannel = true
    } else if (!avatarUrl) {
      const resolved = await resolveMemberAvatarUrls(deps.bot, chatId, [userId])
      avatarUrl = resolved.get(userId) ?? null
    }

    if (text) {
      const antispam = evaluateComment({
        text,
        userId,
        username: saveUsername,
        channelChatId: chatId,
        source: 'max',
        isChannelAdmin: postAsChannel,
      })
      if (!antispam.allowed) {
        res.status(403).json({
          error: 'spam_blocked',
          message: antispam.userMessage ?? 'Комментарий не прошёл проверку на спам.',
          spam_score: antispam.spamScore,
        })
        return
      }
    }

    const saved = commentStore.saveComment({
      post_id: postId,
      user_id: userId,
      username: saveUsername,
      text,
      ...(photoUrls.length > 0 ? { photo_urls: photoUrls } : {}),
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      ...(postedAsChannel ? { posted_as_channel: true } : {}),
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

    try {
      await syncMaxCommentToTelegramThread(deps.bot, saved, post)
    } catch (err: unknown) {
      logger.warn('POST /api/comment: sync TG thread failed', { commentId: saved.comment_id, err })
    }

    const channelTitle = channelRegistry.getChannel(chatId)?.title ?? '—'
    try {
      await notifyAdminsNewMiniappComment(deps.bot, {
        commentId: saved.comment_id,
        channelChatId: chatId,
        postText: post.text,
        channelTitle,
        username: saveUsername,
        commentText: text,
        commentPhotoUrls: photoUrls,
        postId,
      })
    } catch (err: unknown) {
      logger.warn('POST /api/comment: notify admins failed', { err })
    }
    try {
      await notifyTelegramAdminsNewMiniappComment(deps.bot, {
        commentId: saved.comment_id,
        maxChannelChatId: chatId,
        postText: post.text,
        channelTitle,
        username: saveUsername,
        commentText: text,
        commentPhotoUrls: photoUrls,
        postId,
        messageMid: post.message_mid,
      })
    } catch (err: unknown) {
      logger.warn('POST /api/comment: TG notify admins failed', { err })
    }

    res.json({
      comment_id: saved.comment_id,
      timestamp: saved.timestamp,
      ...(saved.posted_as_channel ? { posted_as_channel: true } : {}),
      ...(saved.avatar_url ? { avatar_url: saved.avatar_url } : {}),
      username: saved.username,
      text: saved.text,
      ...(Array.isArray(saved.photo_urls) && saved.photo_urls.length > 0
        ? { photo_urls: saved.photo_urls }
        : {}),
    })
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
    const replierUserId = parsePositiveInt(body.user_id)
    const adminText = normalizeUserFacingText(parseOptionalString(body.admin_text))
    const replyPhotoUrls = parsePhotoUrls(body.photo_urls)
    if (!commentId || !postId || !chatId || !replierUserId || (adminText === '' && replyPhotoUrls.length === 0)) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }
    const post = postStore.getPost(postId)
    if (!post || post.chat_id !== chatId) {
      res.status(404).json({ error: 'post not found' })
      return
    }
    if (isPostCommentsClosedInMax(post)) {
      res.status(403).json({
        error: 'comments_closed',
        message: 'Комментарии закрыты. Обсуждение ведётся в Telegram.',
      })
      return
    }
    const channelReplyName = (await resolveChannelBranding(deps.bot, chatId)).title

    const isMaxAdmin = await isUserChannelAdmin(deps.bot, post.chat_id, replierUserId)
    let isTelegramAuthorizedAdmin = false
    if (!isMaxAdmin) {
      const tgUidRaw =
        parseHeaderString(req.headers['x-miniapp-tg-uid']) ??
        parseHeaderString(req.query.tg_uid) ??
        parseNonEmptyString(body.tg_uid)
      const tgExpRaw =
        parseHeaderString(req.headers['x-miniapp-tg-exp']) ??
        parseHeaderString(req.query.tg_exp) ??
        parseNonEmptyString(body.tg_exp)
      const tgSigRaw =
        parseHeaderString(req.headers['x-miniapp-tg-sig']) ??
        parseHeaderString(req.query.tg_sig) ??
        parseNonEmptyString(body.tg_sig)
      isTelegramAuthorizedAdmin = verifyTelegramMiniappAuth({
        telegramUserId: replierUserId,
        maxChatId: post.chat_id,
        tgUidRaw,
        tgExpRaw,
        tgSigRaw,
      })
    }
    if (!isMaxAdmin && !isTelegramAuthorizedAdmin) {
      res.status(403).json({ error: 'Только администраторы могут отвечать' })
      return
    }

    const replierNameForStatus =
      (await resolveMemberDisplayName(deps.bot, post.chat_id, replierUserId)) ?? 'администратор'

    const existing = commentStore.getComment(commentId)
    if (!existing || existing.post_id !== postId) {
      res.status(404).json({ error: 'comment not found' })
      return
    }

    const updated = commentStore.addReply(
      commentId,
      adminText,
      channelReplyName,
      replyPhotoUrls,
      replierNameForStatus,
    )
    if (!updated) {
      res.status(404).json({ error: 'comment not found' })
      return
    }

    try {
      await syncAdminReplyToTelegramThread(deps.bot, updated, post)
    } catch (err: unknown) {
      logger.warn('POST /api/reply: sync TG thread failed', { commentId, err })
    }

    try {
      await syncAdminCommentNotification(deps.bot, updated, postId, chatId)
    } catch (err: unknown) {
      logger.warn('POST /api/reply: sync admin notification failed', { commentId, err })
    }
    try {
      await syncTelegramAdminCommentNotification({
        comment: updated,
        postId,
        channelChatId: chatId,
        messageMid: post.message_mid,
      })
    } catch (err: unknown) {
      logger.warn('POST /api/reply: sync TG admin notification failed', { commentId, err })
    }

    await notifyUserAboutMiniappReply(deps.bot, {
      userId: Number(updated.user_id),
      commentId: updated.comment_id,
      postText: post.text,
      userCommentText: updated.text,
      adminReplyText: adminText,
      adminReplyPhotoUrls: replyPhotoUrls,
      postId,
      channelChatId: chatId,
    })

    const [enriched] = await enrichCommentsWithAvatars(deps.bot, chatId, [updated])
    res.json(toWireComment(enriched ?? updated))
  })

  router.patch('/comment', async (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const commentId = parseNonEmptyString(body.comment_id)
    const postId = parseNonEmptyString(body.post_id)
    const chatId = parseNonZeroInt(body.chat_id)
    const editorUserId = parsePositiveInt(body.user_id)
    const rawText = parseNonEmptyString(body.text)
    const text = rawText != null ? normalizeUserFacingText(rawText) : null
    if (!commentId || !postId || !chatId || !editorUserId || !text) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }

    const access = await resolveAdminCommentAccess(deps.bot, {
      commentId,
      postId,
      chatId,
      userId: editorUserId,
    })
    if (!access.ok) {
      res.status(access.status).json({ error: access.error })
      return
    }

    const updated = commentStore.updateCommentText(commentId, text)
    if (!updated) {
      res.status(404).json({ error: 'comment not found' })
      return
    }
    res.json(toWireComment(updated))
  })

  const adminDeleteComment = async (
    res: express.Response,
    input: AdminModerationInput,
  ): Promise<void> => {
    const access = await resolveAdminCommentAccess(deps.bot, {
      commentId: input.commentId,
      postId: input.postId,
      chatId: input.chatId,
      userId: input.userId,
    })
    if (!access.ok) {
      res.status(access.status).json({ error: access.error })
      return
    }

    const removed = commentStore.deleteComment(input.commentId)
    if (!removed) {
      res.status(404).json({ error: 'comment not found' })
      return
    }

    try {
      await syncTelegramAdminCommentNotification({
        comment: removed,
        postId: input.postId,
        channelChatId: input.chatId,
        messageMid: access.post.message_mid,
        deleted: true,
      })
    } catch (err: unknown) {
      logger.warn('adminDeleteComment: sync TG admin notification failed', {
        commentId: input.commentId,
        err,
      })
    }

    const newCount = postStore.decrementCommentCount(input.postId)
    res.json({ ok: true, comment_count: newCount })
    if (newCount !== null) {
      const updatedPost = postStore.getPost(input.postId)
      if (updatedPost) {
        void postStore.updateButtonCaption(deps.bot, updatedPost).catch((err: unknown) => {
          logger.warn('adminDeleteComment: updateButtonCaption failed after response', {
            postId: input.postId,
            err,
          })
        })
      }
    }
  }

  router.delete('/comment', async (req, res) => {
    const input = parseAdminModerationBody(req.body)
    if (!input) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }
    await adminDeleteComment(res, input)
  })

  router.post('/comment/delete', async (req, res) => {
    const input = parseAdminModerationBody(req.body)
    if (!input) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }
    await adminDeleteComment(res, input)
  })

  router.patch('/reply', async (req, res) => {
    const body = req.body
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const commentId = parseNonEmptyString(body.comment_id)
    const postId = parseNonEmptyString(body.post_id)
    const chatId = parseNonZeroInt(body.chat_id)
    const editorUserId = parsePositiveInt(body.user_id)
    const adminText = normalizeUserFacingText(parseOptionalString(body.admin_text))
    const photoUrlsInBody = 'photo_urls' in body
    const replyPhotoUrls = photoUrlsInBody ? parsePhotoUrls(body.photo_urls) : undefined
    if (
      !commentId ||
      !postId ||
      !chatId ||
      !editorUserId ||
      (adminText === '' &&
        !(replyPhotoUrls !== undefined
          ? replyPhotoUrls.length > 0
          : !!(commentStore.getComment(commentId)?.reply?.photo_urls?.length)))
    ) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }
    const access = await resolveAdminCommentAccess(deps.bot, {
      commentId,
      postId,
      chatId,
      userId: editorUserId,
    })
    if (!access.ok) {
      res.status(access.status).json({ error: access.error })
      return
    }

    const channelReplyName =
      channelRegistry.getChannel(access.post.chat_id)?.title?.trim() || 'Канал'
    const updated = commentStore.updateReply(
      commentId,
      adminText,
      channelReplyName,
      replyPhotoUrls,
    )
    if (!updated) {
      res.status(404).json({ error: 'reply not found' })
      return
    }
    try {
      await syncAdminCommentNotification(deps.bot, updated, postId, chatId)
    } catch (err: unknown) {
      logger.warn('PATCH /api/reply: sync admin notification failed', { commentId, err })
    }
    res.json(toWireComment(updated))
  })

  const adminDeleteReply = async (
    res: express.Response,
    input: AdminModerationInput,
  ): Promise<void> => {
    const access = await resolveAdminCommentAccess(deps.bot, {
      commentId: input.commentId,
      postId: input.postId,
      chatId: input.chatId,
      userId: input.userId,
    })
    if (!access.ok) {
      res.status(access.status).json({ error: access.error })
      return
    }

    const updated = commentStore.deleteReply(input.commentId)
    if (!updated) {
      res.status(404).json({ error: 'reply not found' })
      return
    }
    try {
      await syncAdminCommentNotification(deps.bot, updated, input.postId, input.chatId)
    } catch (err: unknown) {
      logger.warn('DELETE /api/reply: sync admin notification failed', {
        commentId: input.commentId,
        err,
      })
    }
    res.json(toWireComment(updated))
  }

  router.delete('/reply', async (req, res) => {
    const input = parseAdminModerationBody(req.body)
    if (!input) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }
    await adminDeleteReply(res, input)
  })

  router.post('/reply/delete', async (req, res) => {
    const input = parseAdminModerationBody(req.body)
    if (!input) {
      res.status(400).json({ error: 'missing or invalid fields' })
      return
    }
    await adminDeleteReply(res, input)
  })

  return router
}
