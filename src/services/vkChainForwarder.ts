/**
 * vkChainForwarder.ts
 *
 * Сервис для связки Telegram→VK (через MAX-канал как якорь связки):
 * 1. Берёт посты из Telegram (текст + фото/видео как в TG) и публикует на стену VK.
 * 2. Опрашивает комментарии VK и синхронизирует их в MAX miniapp.
 * 3. Отправляет новые комментарии из MAX miniapp в VK.
 */

import axios from 'axios'
import type { Bot } from '@maxhub/max-bot-api'

import { listVkChainsSync, updateVkChain, type VkChainRecord } from '../api/adminPanelState'
import type { TgMessage } from '../forwarder/telegramReader'
import { getTgFileUrl } from '../forwarder/telegramReader'
import { evaluateComment } from './antispamService'
import { commentStore } from './commentStore'
import {
  claimAndPropagateCommentsBooking,
  isCommentSyncBlockedByBooking,
} from './commentsBookingService'
import {
  fetchVkWallComments,
  publishVkWallComment,
  publishVkWallPost,
  uploadVkWallPhotoFromBuffer,
  uploadVkWallVideoFromBuffer,
} from './integrationPlatformClient'
import { postStore } from './postStore'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { vkPostMappingStore } from './vkPostMappingStore'
import { isCommentSynced, markCommentSynced } from '../utils/commentSyncGuard'
import { logger } from '../utils/logger'
import { sendAdminAlert } from '../utils/alertService'

const VK_COMMENT_POLL_INTERVAL_MS = 3_000
const VK_MAX_TO_VK_SYNC_INTERVAL_MS = 2_000
/** Не опрашивать VK-пост старше 30 дней */
const VK_POST_MAX_AGE_DAYS = 30
/** Формат имени VK-пользователя в miniapp */
const VK_USER_PREFIX = 'vk:'
/** VK wall.post — не более 10 вложений. */
const VK_WALL_ATTACHMENTS_LIMIT = 10
const TG_DOWNLOAD_TIMEOUT_MS = 120_000

export interface TelegramPostToVkInput {
  /** MAX chat id — якорь VK-связки (тот же канал, куда идёт TG→MAX). */
  maxChatId: number
  /** mid поста в MAX после пересылки (для маппинга комментариев). */
  maxMid: string
  /** Токен TG-бота, через который читаем файл постов. */
  tgToken: string
  /** Сообщения Telegram (одно или альбом) — источник текста и медиа. */
  tgMessages: TgMessage[]
}

/** Текст поста ровно как в Telegram (caption/text), без подписей MAX/«— TG». */
export function exactTelegramPostText(messages: TgMessage[]): string {
  const ordered = [...messages].sort((a, b) => a.message_id - b.message_id)
  for (const msg of ordered) {
    const raw = (msg.caption || msg.text || '').trim()
    if (raw) return raw
  }
  return ''
}

function tgMessageHasMedia(msg: TgMessage): boolean {
  if (msg.photo && msg.photo.length > 0) return true
  if (msg.video?.file_id) return true
  const docMime = msg.document?.mime_type?.toLowerCase() ?? ''
  if (msg.document?.file_id && docMime.startsWith('image/')) return true
  return false
}

async function downloadBinary(url: string): Promise<Buffer | null> {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: TG_DOWNLOAD_TIMEOUT_MS,
    })
    return Buffer.from(res.data)
  } catch (err: unknown) {
    logger.warn('[vkChain] media download failed', { url: url.slice(0, 120), err })
    return null
  }
}

async function uploadTgPhotoToVk(
  vkToken: string,
  groupId: string,
  tgToken: string,
  fileId: string,
  filenameHint?: string,
): Promise<string | null> {
  const url = await getTgFileUrl(tgToken, fileId)
  if (!url) return null
  const buffer = await downloadBinary(url)
  if (!buffer) return null
  const fromPath = url.split('/').pop()?.split('?')[0]
  return uploadVkWallPhotoFromBuffer(
    vkToken,
    groupId,
    buffer,
    filenameHint || fromPath || 'photo.jpg',
  )
}

async function uploadTgVideoToVk(
  vkToken: string,
  groupId: string,
  tgToken: string,
  fileId: string,
  title: string,
): Promise<string | null> {
  const url = await getTgFileUrl(tgToken, fileId)
  if (!url) return null
  const buffer = await downloadBinary(url)
  if (!buffer) return null
  return uploadVkWallVideoFromBuffer(vkToken, groupId, buffer, 'video.mp4', title)
}

async function buildVkAttachmentsFromTgMessages(
  vkToken: string,
  groupId: string,
  tgToken: string,
  messages: TgMessage[],
): Promise<string[]> {
  const out: string[] = []
  const ordered = [...messages].sort((a, b) => a.message_id - b.message_id)
  for (const msg of ordered) {
    if (out.length >= VK_WALL_ATTACHMENTS_LIMIT) break
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1]!
      const att = await uploadTgPhotoToVk(vkToken, groupId, tgToken, largest.file_id)
      if (att) out.push(att)
      continue
    }
    const doc = msg.document
    const docMime = doc?.mime_type?.toLowerCase() ?? ''
    if (doc?.file_id && docMime.startsWith('image/')) {
      const att = await uploadTgPhotoToVk(
        vkToken,
        groupId,
        tgToken,
        doc.file_id,
        doc.file_name || 'photo.jpg',
      )
      if (att) out.push(att)
      continue
    }
    if (msg.video?.file_id) {
      const title = (msg.caption || msg.text || 'video').trim().slice(0, 128) || 'video'
      const att = await uploadTgVideoToVk(vkToken, groupId, tgToken, msg.video.file_id, title)
      if (att) out.push(att)
    }
  }
  return out
}

async function resolveVkWallAttachmentsFromTelegram(
  vkToken: string,
  groupId: string,
  tgToken: string,
  messages: TgMessage[],
): Promise<string[]> {
  return buildVkAttachmentsFromTgMessages(vkToken, groupId, tgToken, messages)
}

function formatVkCommentUsername(fromId: number): string {
  if (fromId > 0) return 'Пользователь ВК'
  return 'Сообщество ВК'
}

let botRef: Bot | null = null
let commentPollTimer: NodeJS.Timeout | null = null
let maxToVkSyncTimer: NodeJS.Timeout | null = null
let started = false
let vkCommentsSyncInFlight = false
let maxToVkSyncInFlight = false
/** Защита от гонки при повторном вызове для одного и того же MAX mid. */
const inflightVkPublish = new Set<string>()

export function setVkChainForwarderBot(bot: Bot): void {
  botRef = bot
}

function vkForwardPostsEnabled(chain: VkChainRecord): boolean {
  // Как в админ-UI: отсутствие поля = включено (не `&& chain.forward_posts`).
  return chain.forward_posts !== false
}

function matchVkChainsForMaxChat(maxChatId: number): VkChainRecord[] {
  const canonicalChatId = resolveCanonicalChannelChatId(maxChatId) ?? maxChatId
  return listVkChainsSync().filter(
    (c) =>
      c.active !== false &&
      vkForwardPostsEnabled(c) &&
      (Math.abs(c.max_chat_id) === Math.abs(canonicalChatId) ||
        Math.abs(c.max_chat_id) === Math.abs(maxChatId)),
  )
}

// ── Публикация Telegram → VK ─────────────────────────────────────────────────

/**
 * Публикует пост из Telegram на стену VK для всех активных связок MAX-канала.
 * Текст и вложения берутся только из Telegram (как в исходном посте).
 */
export async function publishTelegramPostToVk(input: TelegramPostToVkInput): Promise<void> {
  const mid = input.maxMid.trim()
  const tgToken = input.tgToken.trim()
  const tgMessages = input.tgMessages
  if (!mid || !tgToken || tgMessages.length === 0) {
    logger.warn('[vkChain] publishTelegramPostToVk: incomplete Telegram payload', {
      maxMid: mid || null,
      hasToken: Boolean(tgToken),
      tgMessages: tgMessages.length,
    })
    return
  }

  const chains = matchVkChainsForMaxChat(input.maxChatId)
  if (chains.length === 0) {
    logger.debug('[vkChain] publishTelegramPostToVk: no matching active chains', {
      maxChatId: input.maxChatId,
      maxMid: mid,
      knownChains: listVkChainsSync().length,
    })
    return
  }

  const caption = exactTelegramPostText(tgMessages)
  for (const chain of chains) {
    await publishTelegramPostToVkChain(chain, {
      maxChatId: input.maxChatId,
      maxMid: mid,
      tgToken,
      tgMessages,
      caption,
    })
  }
}

/**
 * @deprecated Используйте {@link publishTelegramPostToVk}. Оставлено для совместимости вызовов.
 */
export async function onMaxPostPublished(
  maxChatId: number,
  maxMid: string,
  _postText: string,
  mediaContext?: { tgToken?: string; tgMessages?: TgMessage[] },
): Promise<void> {
  const tgToken = mediaContext?.tgToken?.trim()
  const tgMessages = mediaContext?.tgMessages
  if (!tgToken || !tgMessages || tgMessages.length === 0) {
    logger.debug('[vkChain] onMaxPostPublished skipped — нужен Telegram source (tgToken + tgMessages)', {
      maxChatId,
      maxMid,
    })
    return
  }
  await publishTelegramPostToVk({
    maxChatId,
    maxMid,
    tgToken,
    tgMessages,
  })
}

async function maxMessageStillExists(maxMid: string): Promise<boolean> {
  const bot = botRef
  if (!bot) return true
  try {
    const message = await bot.api.getMessage(maxMid)
    return Boolean(message?.body?.mid)
  } catch {
    return false
  }
}

async function publishTelegramPostToVkChain(
  chain: VkChainRecord,
  input: {
    maxChatId: number
    maxMid: string
    tgToken: string
    tgMessages: TgMessage[]
    caption: string
  },
): Promise<void> {
  const { maxMid, tgToken, tgMessages, caption } = input
  const lockKey = `${chain.id}:${maxMid}`
  if (inflightVkPublish.has(lockKey)) {
    return
  }

  await vkPostMappingStore.load().catch((err: unknown) => {
    logger.warn('[vkChain] mapping store load failed before publish', err)
  })
  if (vkPostMappingStore.findByMaxMid(chain.id, maxMid)) {
    logger.debug('[vkChain] skip — already mapped to VK', { chainId: chain.id, maxMid })
    return
  }

  inflightVkPublish.add(lockKey)
  try {
    // Comment-gate rollback удаляет пост в MAX — не публикуем «осиротевший» пост в VK.
    if (!(await maxMessageStillExists(maxMid))) {
      logger.info('[vkChain] skip — MAX message missing (rolled back?)', {
        chainId: chain.id,
        maxMid,
      })
      return
    }

    const sourceHadMedia = tgMessages.some(tgMessageHasMedia)
    const attachments = await resolveVkWallAttachmentsFromTelegram(
      chain.vk_token,
      chain.vk_group_id,
      tgToken,
      tgMessages,
    )
    if (sourceHadMedia && attachments.length === 0) {
      logger.warn('[vkChain] Telegram had media but VK attachments empty — posting text only', {
        chainId: chain.id,
        maxMid,
        groupId: chain.vk_group_id,
        tgMessages: tgMessages.length,
      })
    }

    // Текст ровно как в Telegram; nbsp если пост media-only без подписи.
    const message = caption.trim() || '\u00a0'
    const vkPostId = await publishVkWallPost(
      chain.vk_token,
      chain.vk_group_id,
      message,
      attachments.length > 0 ? attachments : undefined,
    )
    if (vkPostId == null) {
      logger.warn('[vkChain] publishVkWallPost returned null', {
        chainId: chain.id,
        maxMid,
      })
      return
    }
    await vkPostMappingStore.upsert({
      chainId: chain.id,
      maxChatId: chain.max_chat_id,
      maxMid,
      vkPostId,
      vkGroupId: chain.vk_group_id,
      lastVkCommentId: 0,
    })
    await updateVkChain(chain.id, {
      forwarded_today: (chain.forwarded_today ?? 0) + 1,
    })
    logger.info('[vkChain] Telegram post published to VK', {
      chainId: chain.id,
      maxMid,
      vkPostId,
      groupId: chain.vk_group_id,
      attachmentCount: attachments.length,
      captionLen: caption.length,
      tgMessages: tgMessages.length,
    })
  } catch (err: unknown) {
    await updateVkChain(chain.id, {
      errors_today: (chain.errors_today ?? 0) + 1,
    })
    logger.error('[vkChain] failed to publish Telegram post to VK', {
      chainId: chain.id,
      maxMid,
      err,
    })
    void sendAdminAlert(
      `vk_publish_failed:${chain.id}`,
      'Не удалось опубликовать пост в VK — перенос постов заблокирован',
      {
        chainId: chain.id,
        maxMid,
        error: err instanceof Error ? err.message : String(err),
      },
    )
  } finally {
    inflightVkPublish.delete(lockKey)
  }
}

// ── Синхронизация VK-комментариев → MAX miniapp ──────────────────────────────

async function syncVkCommentsForChain(chain: VkChainRecord): Promise<void> {
  if (!chain.sync_comments) return
  const bot = botRef
  const mappings = vkPostMappingStore.listByChain(chain.id)
  const cutoff = Date.now() - VK_POST_MAX_AGE_DAYS * 86_400_000

  for (const mapping of mappings) {
    const createdAt = new Date(mapping.createdAt).getTime()
    if (Number.isFinite(createdAt) && createdAt < cutoff) continue

    const post = postStore.findPostByChannelMessage(mapping.maxChatId, mapping.maxMid)
    if (!post) continue

    if (isCommentSyncBlockedByBooking(post, 'vk')) {
      continue
    }

    const { comments, lastCommentId } = await fetchVkWallComments(
      chain.vk_token,
      chain.vk_group_id,
      mapping.vkPostId,
      mapping.lastVkCommentId,
    )

    if (lastCommentId > mapping.lastVkCommentId) {
      await vkPostMappingStore.updateLastCommentId(chain.id, mapping.vkPostId, lastCommentId)
    }

    for (const vkComment of comments) {
      const guardKey = `vk:${chain.id}:${vkComment.id}`
      if (isCommentSynced(guardKey)) continue

      const existing = commentStore
        .getComments(post.post_id)
        .find((c) => c.tg_comment_id === vkComment.id && c.source === 'vk')
      if (existing) {
        markCommentSynced(guardKey)
        continue
      }

      const username = formatVkCommentUsername(vkComment.from_id)
      const antispamUserKey = `${VK_USER_PREFIX}${vkComment.from_id}`

      const antispam = evaluateComment({
        text: vkComment.text,
        userId: vkComment.from_id,
        username: antispamUserKey,
        channelChatId: mapping.maxChatId,
        source: 'vk',
      })
      if (!antispam.allowed) {
        markCommentSynced(guardKey)
        logger.info('[vkChain] blocked VK comment by antispam', {
          chainId: chain.id,
          vkCommentId: vkComment.id,
          spamScore: antispam.spamScore,
          reason: antispam.reason,
        })
        continue
      }

      const saved = commentStore.saveVkThreadComment(
        {
          post_id: post.post_id,
          user_id: vkComment.from_id,
          username,
          text: vkComment.text,
        },
        vkComment.id,
      )

      markCommentSynced(guardKey)
      markCommentSynced(`max:${saved.comment_id}`)

      const claimed = await claimAndPropagateCommentsBooking(post.post_id, 'vk', bot ?? undefined)
      if (claimed) {
        logger.info('[vkChain] post booked by VK (cross-platform markers applied)', {
          chainId: chain.id,
          postId: post.post_id,
          vkCommentId: vkComment.id,
        })
      }

      const newCount = postStore.incrementCommentCount(post.post_id)
      if (newCount !== null && bot) {
        const updatedPost = postStore.getPost(post.post_id)
        if (updatedPost) {
          await postStore.updateButtonCaption(bot, updatedPost).catch((err: unknown) => {
            logger.warn('[vkChain] updateButtonCaption failed', { commentId: saved.comment_id, err })
          })
        }
      }

      logger.info('[vkChain] synced VK comment to MAX miniapp', {
        chainId: chain.id,
        vkCommentId: vkComment.id,
        commentId: saved.comment_id,
        postId: post.post_id,
      })
    }
  }
}

async function syncAllVkCommentsToMax(): Promise<void> {
  const chains = listVkChainsSync().filter((c) => c.active && c.sync_comments)
  for (const chain of chains) {
    try {
      await syncVkCommentsForChain(chain)
    } catch (err: unknown) {
      logger.error('[vkChain] syncVkCommentsForChain failed', { chainId: chain.id, err })
    }
  }
}

// ── Синхронизация MAX miniapp-комментариев → VK ──────────────────────────────

async function syncMaxCommentsToVk(): Promise<void> {
  const chains = listVkChainsSync().filter((c) => c.active && c.sync_comments)
  if (chains.length === 0) return

  const pendingComments = commentStore.listCommentsPendingMaxToTelegram(30)

  for (const comment of pendingComments) {
    const post = postStore.getPost(comment.post_id)
    if (!post) continue

    if (isCommentSyncBlockedByBooking(post, 'max')) {
      continue
    }

    for (const chain of chains) {
      if (Math.abs(chain.max_chat_id) !== Math.abs(post.chat_id)) continue

      const mapping = vkPostMappingStore
        .listByChain(chain.id)
        .find((m) => m.maxMid === post.message_mid)
      if (!mapping) continue

      const guardKey = `vk-reply:${chain.id}:${comment.comment_id}`
      if (isCommentSynced(guardKey)) continue

      const commentText = comment.text?.trim()
      if (!commentText) {
        markCommentSynced(guardKey)
        continue
      }

      const vkCommentId = await publishVkWallComment(
        chain.vk_token,
        chain.vk_group_id,
        mapping.vkPostId,
        commentText,
      )

      markCommentSynced(guardKey)

      if (vkCommentId != null) {
        logger.info('[vkChain] synced MAX comment to VK', {
          chainId: chain.id,
          commentId: comment.comment_id,
          vkCommentId,
          vkPostId: mapping.vkPostId,
        })
      }
    }
  }
}

// ── Запуск и остановка ───────────────────────────────────────────────────────

export function startVkChainForwarder(): void {
  if (started) return
  started = true

  void vkPostMappingStore.load().catch((err: unknown) => {
    logger.warn('[vkChain] mapping store load failed', err)
  })

  commentPollTimer = setInterval(() => {
    if (vkCommentsSyncInFlight) {
      return
    }
    vkCommentsSyncInFlight = true
    void syncAllVkCommentsToMax()
      .catch((err: unknown) => {
        logger.error('[vkChain] syncAllVkCommentsToMax error', err)
        void sendAdminAlert(
          'vk_comment_sync',
          'Сбой синхронизации комментариев VK→MAX — перенос комментариев может быть остановлен',
          { error: err instanceof Error ? err.message : String(err) },
        )
      })
      .finally(() => {
        vkCommentsSyncInFlight = false
      })
  }, VK_COMMENT_POLL_INTERVAL_MS)

  maxToVkSyncTimer = setInterval(() => {
    if (maxToVkSyncInFlight) {
      return
    }
    maxToVkSyncInFlight = true
    void syncMaxCommentsToVk()
      .catch((err: unknown) => {
        logger.error('[vkChain] syncMaxCommentsToVk error', err)
        void sendAdminAlert(
          'vk_max_comment_sync',
          'Сбой синхронизации комментариев MAX→VK — перенос комментариев может быть остановлен',
          { error: err instanceof Error ? err.message : String(err) },
        )
      })
      .finally(() => {
        maxToVkSyncInFlight = false
      })
  }, VK_MAX_TO_VK_SYNC_INTERVAL_MS)

  const activeChains = listVkChainsSync().filter((c) => c.active)
  logger.info('[vkChain] started', {
    activeChains: activeChains.length,
    commentPollMs: VK_COMMENT_POLL_INTERVAL_MS,
    maxToVkMs: VK_MAX_TO_VK_SYNC_INTERVAL_MS,
  })
}

export function stopVkChainForwarder(): void {
  if (commentPollTimer) {
    clearInterval(commentPollTimer)
    commentPollTimer = null
  }
  if (maxToVkSyncTimer) {
    clearInterval(maxToVkSyncTimer)
    maxToVkSyncTimer = null
  }
  started = false
  logger.info('[vkChain] stopped')
}
