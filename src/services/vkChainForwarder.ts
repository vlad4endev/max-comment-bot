/**
 * vkChainForwarder.ts
 *
 * Сервис для связки MAX-канала с VK-сообществом:
 * 1. Публикует посты из MAX в VK (вызывается хуком из tgChainForwarder).
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
import { mediaAttachmentRequestsFromMessageBody, postStore } from './postStore'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { vkPostMappingStore } from './vkPostMappingStore'
import { isCommentSynced, markCommentSynced } from '../utils/commentSyncGuard'
import { logger } from '../utils/logger'

const VK_COMMENT_POLL_INTERVAL_MS = 30_000
const VK_MAX_TO_VK_SYNC_INTERVAL_MS = 20_000
/** Не опрашивать VK-пост старше 30 дней */
const VK_POST_MAX_AGE_DAYS = 30
/** Формат имени VK-пользователя в miniapp */
const VK_USER_PREFIX = 'vk:'
/** VK wall.post — не более 10 вложений. */
const VK_WALL_ATTACHMENTS_LIMIT = 10
const TG_DOWNLOAD_TIMEOUT_MS = 120_000

export interface MaxPostPublishedMediaContext {
  tgToken?: string
  tgMessages?: TgMessage[]
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
): Promise<string | null> {
  const url = await getTgFileUrl(tgToken, fileId)
  if (!url) return null
  const buffer = await downloadBinary(url)
  if (!buffer) return null
  return uploadVkWallPhotoFromBuffer(vkToken, groupId, buffer)
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
    if (msg.video?.file_id) {
      const title = (msg.caption || msg.text || 'video').trim().slice(0, 128) || 'video'
      const att = await uploadTgVideoToVk(vkToken, groupId, tgToken, msg.video.file_id, title)
      if (att) out.push(att)
    }
  }
  return out
}

async function buildVkAttachmentsFromMaxMid(
  bot: Bot,
  vkToken: string,
  groupId: string,
  maxMid: string,
): Promise<string[]> {
  const out: string[] = []
  try {
    const message = await bot.api.getMessage(maxMid)
    const media = mediaAttachmentRequestsFromMessageBody(message.body.attachments)
    for (const att of media) {
      if (out.length >= VK_WALL_ATTACHMENTS_LIMIT) break
      const payload = (att as { payload?: { url?: string } }).payload
      const url = payload?.url?.trim()
      if (!url) continue
      const buffer = await downloadBinary(url)
      if (!buffer) continue
      if (att.type === 'video') {
        const vkAtt = await uploadVkWallVideoFromBuffer(vkToken, groupId, buffer, 'video.mp4', 'video')
        if (vkAtt) out.push(vkAtt)
      } else if (att.type === 'image') {
        const vkAtt = await uploadVkWallPhotoFromBuffer(vkToken, groupId, buffer)
        if (vkAtt) out.push(vkAtt)
      }
    }
  } catch (err: unknown) {
    logger.warn('[vkChain] buildVkAttachmentsFromMaxMid failed', { maxMid, err })
  }
  return out
}

async function buildVkAttachmentsFromPostRecord(
  vkToken: string,
  groupId: string,
  maxChatId: number,
  maxMid: string,
): Promise<string[]> {
  const chatId = resolveCanonicalChannelChatId(maxChatId) ?? maxChatId
  const post = postStore.findPostByChannelMessage(chatId, maxMid)
  if (!post?.media_attachments?.length) {
    return []
  }
  const out: string[] = []
  for (const att of post.media_attachments) {
    if (out.length >= VK_WALL_ATTACHMENTS_LIMIT) break
    const payload = (att as { payload?: { url?: string } }).payload
    const url = payload?.url?.trim()
    if (!url) continue
    const buffer = await downloadBinary(url)
    if (!buffer) continue
    if (att.type === 'video') {
      const vkAtt = await uploadVkWallVideoFromBuffer(vkToken, groupId, buffer, 'video.mp4', 'video')
      if (vkAtt) out.push(vkAtt)
    } else if (att.type === 'image') {
      const vkAtt = await uploadVkWallPhotoFromBuffer(vkToken, groupId, buffer)
      if (vkAtt) out.push(vkAtt)
    }
  }
  return out
}

async function resolveVkWallAttachments(
  vkToken: string,
  groupId: string,
  maxChatId: number,
  maxMid: string,
  mediaContext?: MaxPostPublishedMediaContext,
): Promise<string[]> {
  if (mediaContext?.tgToken && mediaContext.tgMessages && mediaContext.tgMessages.length > 0) {
    const fromTg = await buildVkAttachmentsFromTgMessages(
      vkToken,
      groupId,
      mediaContext.tgToken,
      mediaContext.tgMessages,
    )
    if (fromTg.length > 0) {
      return fromTg
    }
  }

  const fromPost = await buildVkAttachmentsFromPostRecord(vkToken, groupId, maxChatId, maxMid)
  if (fromPost.length > 0) {
    return fromPost
  }

  const bot = botRef
  if (bot) {
    return buildVkAttachmentsFromMaxMid(bot, vkToken, groupId, maxMid)
  }
  return []
}

function formatVkCommentUsername(fromId: number): string {
  if (fromId > 0) return 'Пользователь ВК'
  return 'Сообщество ВК'
}

let botRef: Bot | null = null
let commentPollTimer: NodeJS.Timeout | null = null
let maxToVkSyncTimer: NodeJS.Timeout | null = null
let started = false

export function setVkChainForwarderBot(bot: Bot): void {
  botRef = bot
}

// ── Публикация поста MAX → VK ────────────────────────────────────────────────

/**
 * Хук, вызываемый из tgChainForwarder после того, как пост опубликован в MAX-канале.
 * Для всех активных VK-связок этого канала публикует тот же текст в VK.
 */
export async function onMaxPostPublished(
  maxChatId: number,
  maxMid: string,
  postText: string,
  mediaContext?: MaxPostPublishedMediaContext,
): Promise<void> {
  const canonicalChatId = resolveCanonicalChannelChatId(maxChatId) ?? maxChatId
  const chains = listVkChainsSync().filter(
    (c) =>
      c.active &&
      c.forward_posts &&
      (Math.abs(c.max_chat_id) === Math.abs(canonicalChatId) ||
        Math.abs(c.max_chat_id) === Math.abs(maxChatId)),
  )
  if (chains.length === 0) return

  for (const chain of chains) {
    await publishPostToVkChain(chain, maxMid, postText, maxChatId, mediaContext)
  }
}

async function publishPostToVkChain(
  chain: VkChainRecord,
  maxMid: string,
  postText: string,
  maxChatId: number,
  mediaContext?: MaxPostPublishedMediaContext,
): Promise<void> {
  try {
    const message = postText.trim() || '\u00a0'
    const attachments = await resolveVkWallAttachments(
      chain.vk_token,
      chain.vk_group_id,
      maxChatId,
      maxMid,
      mediaContext,
    )
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
    logger.info('[vkChain] post published to VK', {
      chainId: chain.id,
      maxMid,
      vkPostId,
      groupId: chain.vk_group_id,
      attachmentCount: attachments.length,
    })
  } catch (err: unknown) {
    await updateVkChain(chain.id, {
      errors_today: (chain.errors_today ?? 0) + 1,
    })
    logger.error('[vkChain] failed to publish post to VK', { chainId: chain.id, maxMid, err })
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
    void syncAllVkCommentsToMax().catch((err: unknown) => {
      logger.error('[vkChain] syncAllVkCommentsToMax error', err)
    })
  }, VK_COMMENT_POLL_INTERVAL_MS)

  maxToVkSyncTimer = setInterval(() => {
    void syncMaxCommentsToVk().catch((err: unknown) => {
      logger.error('[vkChain] syncMaxCommentsToVk error', err)
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
