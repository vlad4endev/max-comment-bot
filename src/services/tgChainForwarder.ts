import axios from 'axios'
import pLimit from 'p-limit'
import type { Bot } from '@maxhub/max-bot-api'
import type { AttachmentRequest, ImageAttachmentRequest } from '@maxhub/max-bot-api/types'

import { isMainTelegramBotToken, resolveTelegramBotToken } from './resolveTelegramBotToken'
import { getDb } from '../db/database'
import { telegramAxios } from '../utils/telegramAxios'
import {
  type TgChannelUpdate,
  TelegramGetUpdatesConflictError,
  getTgFileUrl,
  getTelegramUpdatesWithIds,
  isTelegramGetUpdatesTimeoutError,
  type TgMessage,
} from '../forwarder/telegramReader'
import { listTgChainsSync, updateTgChain, type TgChainRecord } from '../api/adminPanelState'
import { ensureTelegramPollingMode, invalidateTelegramPollingModeCache } from './integrationPlatformClient'
import { attachAndVerifyCommentsForForwardedPost } from './channelPostPublishGate'
import { postStore } from './postStore'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { telegramMessageMatchesTgChain } from '../utils/tgChannelMatch'
import { logger } from '../utils/logger'
import { sendAdminAlert } from '../utils/alertService'
import { apiCallWithRetry } from '../utils/maxApiRetry'
import {
  getTelegramBotUpdatesOffset,
  setTelegramBotUpdatesOffset,
} from './telegramMainBotOffsetStore'
import {
  isTelegramGetUpdatesOwnedByForwarder,
  setTelegramGetUpdatesOwner,
} from './telegramGetUpdatesOwner'
import { processTelegramMiniappBotUpdates } from './telegramMiniappService'
import { upsertPostCommentMapping, resolveDiscussionChatId } from './postCommentMappingStore'
import { ensurePostThreadMapping } from './telegramDiscussionThreadResolver'
import {
  handleDiscussionAutoForward,
  handleTgComment,
  isDiscussionAutoForward,
} from './tgCommentSyncService'
import { publishTelegramPostToVk } from './vkChainForwarder'
import {
  bumpCommentInboundRetry,
  bumpForwardQueueRetry,
  deleteCommentInboundJob,
  deleteForwardQueueJob,
  listDueCommentInboundJobs,
  listDueForwardQueueJobs,
  parseForwardQueueMessages,
  parseInboundCommentMessage,
  upsertCommentInboundJob,
  upsertForwardQueueJob,
} from './tgChainForwardQueue'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Пост намеренно пропущен (старее forward_posts_since) — не пересылать и не ретраить. */
export const TG_FORWARD_SKIPPED_MID = '__skipped__'

/** Long-poll Telegram for new channel_post (сек). */
const TG_CHAIN_LONG_POLL_SEC = 25
/** Пауза только между пустыми тиками; long-poll сам ждёт апдейт. */
const TG_CHAIN_IDLE_MS = 40
/** MIN gap between `sendMessageToChat` to the same MAX channel (API 429). */
const MAX_SEND_INTERVAL_MS = 350
const TG_CHAIN_MAX_API_RETRIES = 6
/** Буферизация Telegram-альбомов по media_group_id (тишина после последнего кадра). */
const TG_ALBUM_BUFFER_MS = 450
/** Telegram media group ограничен 10 элементами. */
const TG_ALBUM_MAX_MEDIA_PER_POST = 10
const MEDIA_DOWNLOAD_TIMEOUT_MS = 90_000
const ALBUM_UPLOAD_CONCURRENCY = 4
const MEDIA_DOWNLOAD_CONCURRENCY = 3
/** Глобальный зазор между send в MAX — чтобы пачка каналов не ловила 429. */
const GLOBAL_MAX_SEND_INTERVAL_MS = 200
const albumUploadLimit = pLimit(ALBUM_UPLOAD_CONCURRENCY)
const mediaDownloadLimit = pLimit(MEDIA_DOWNLOAD_CONCURRENCY)

const lastMaxSendAt = new Map<number, number>()
let lastGlobalMaxSendAt = 0
const channelWorkTails = new Map<number, Promise<void>>()
const commentWorkTails = new Map<string, Promise<void>>()
const inFlightForwardKeys = new Set<string>()
const inFlightCommentKeys = new Set<string>()
type BufferedAlbum = {
  chain: TgChainRecord
  tgToken: string
  messages: TgMessage[]
  flushAt: number
}
const albumBuffer = new Map<string, BufferedAlbum>()

function enqueueChannelWork(maxChatId: number, work: () => Promise<void>): void {
  const prev = channelWorkTails.get(maxChatId) ?? Promise.resolve()
  const next = prev.then(work, work)
  channelWorkTails.set(
    maxChatId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
}

function forwardKey(chainId: string, messages: TgMessage[]): string {
  return `${chainId}:${messages.map((m) => m.message_id).join(',')}`
}

function forwardJobKey(chain: TgChainRecord, messages: TgMessage[]): string {
  const first = messages[0]
  const gid = first?.media_group_id?.trim()
  if (first && gid) {
    return `${chain.id}:${first.chat.id}:${gid}`
  }
  return forwardKey(chain, messages)
}

function persistForwardJob(
  chain: TgChainRecord,
  messages: TgMessage[],
  tgToken: string,
  nextRetryAt: number = Date.now(),
): string {
  const jobKey = forwardJobKey(chain, messages)
  upsertForwardQueueJob({
    jobKey,
    chainId: chain.id,
    tgToken,
    messages,
    nextRetryAt,
  })
  return jobKey
}

function enqueueForward(chain: TgChainRecord, messages: TgMessage[], tgToken: string): void {
  if (messages.length === 0) {
    return
  }
  const jobKey = persistForwardJob(chain, messages, tgToken)
  scheduleForwardJob(chain, messages, tgToken, jobKey)
}

function scheduleForwardJob(
  chain: TgChainRecord,
  messages: TgMessage[],
  tgToken: string,
  jobKey: string,
): void {
  if (inFlightForwardKeys.has(jobKey)) {
    return
  }
  if (messages.every((m) => isAlreadyForwarded(chain.id, m.message_id))) {
    deleteForwardQueueJob(jobKey)
    return
  }
  inFlightForwardKeys.add(jobKey)
  enqueueChannelWork(chain.max_chat_id, async () => {
    try {
      const ok = await processChainMessageGroup(chain, messages, tgToken)
      if (ok) {
        deleteForwardQueueJob(jobKey)
      } else {
        bumpForwardQueueRetry(jobKey, 'MAX publish incomplete')
        logger.warn('[tgChain] forward queued for retry', {
          chainId: chain.id,
          jobKey,
          messageIds: messages.map((m) => m.message_id),
        })
      }
    } catch (err: unknown) {
      bumpForwardQueueRetry(jobKey, err)
      logger.error('[tgChain] forward job failed, will retry', {
        chainId: chain.id,
        jobKey,
        err,
      })
    } finally {
      inFlightForwardKeys.delete(jobKey)
    }
  })
}

function enqueueCommentWork(queueKey: string, work: () => Promise<void>): void {
  const prev = commentWorkTails.get(queueKey) ?? Promise.resolve()
  const next = prev.then(work, work)
  commentWorkTails.set(
    queueKey,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
}

function scheduleInboundComment(
  chain: TgChainRecord,
  message: TgMessage,
  discussionChatId: number,
  jobKey: string,
): void {
  if (inFlightCommentKeys.has(jobKey)) {
    return
  }
  inFlightCommentKeys.add(jobKey)
  const bot = botRef
  if (!bot) {
    bumpCommentInboundRetry(jobKey, 'MAX bot not set')
    inFlightCommentKeys.delete(jobKey)
    return
  }
  enqueueCommentWork(`${chain.id}:${discussionChatId}`, async () => {
    try {
      const result = await handleTgComment(message, chain, bot, discussionChatId)
      if (result === 'retry') {
        bumpCommentInboundRetry(jobKey, 'waiting for post mapping')
        return
      }
      deleteCommentInboundJob(jobKey)
    } catch (err: unknown) {
      bumpCommentInboundRetry(jobKey, err)
    } finally {
      inFlightCommentKeys.delete(jobKey)
    }
  })
}

function drainDueCommentJobs(): void {
  const chains = new Map(listTgChainsSync().map((c) => [c.id, c]))
  for (const job of listDueCommentInboundJobs()) {
    const chain = chains.get(job.chain_id)
    if (!chain) {
      deleteCommentInboundJob(job.job_key)
      continue
    }
    if (!chain.active || !chain.forward_comments) {
      bumpCommentInboundRetry(job.job_key, 'chain inactive or comments off')
      continue
    }
    const message = parseInboundCommentMessage(job.payload)
    if (!message) {
      deleteCommentInboundJob(job.job_key)
      continue
    }
    scheduleInboundComment(chain, message, job.discussion_chat_id, job.job_key)
  }
}

function drainDueForwardJobs(): void {
  const chains = new Map(listTgChainsSync().map((c) => [c.id, c]))
  for (const job of listDueForwardQueueJobs()) {
    const chain = chains.get(job.chain_id)
    if (!chain) {
      deleteForwardQueueJob(job.job_key)
      continue
    }
    if (!chain.active || !chain.forward_posts) {
      bumpForwardQueueRetry(job.job_key, 'chain inactive or posts off')
      continue
    }
    const messages = parseForwardQueueMessages(job.payload)
    if (messages.length === 0) {
      deleteForwardQueueJob(job.job_key)
      continue
    }
    scheduleForwardJob(chain, messages, job.tg_token, job.job_key)
  }
}

async function downloadTgFileBuffer(
  url: string,
  timeoutMs: number = MEDIA_DOWNLOAD_TIMEOUT_MS,
): Promise<Buffer> {
  return mediaDownloadLimit(async () => {
    const res = await telegramAxios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
    })
    return Buffer.from(res.data)
  })
}

/** Время последней активности long-poll / пересылки по chain_id. */
const chainLastActivity = new Map<string, number>()
const chainRestartCount = new Map<string, number>()
const activeForwarders = new Map<string, { stop: () => void }>()

let globalForwarderHandle: { stop: () => void } | null = null

function touchChainActivity(chainId: string): void {
  chainLastActivity.set(chainId, Date.now())
}

async function throttleMaxChatSend(chatId: number): Promise<void> {
  const now = Date.now()
  const globalWait = GLOBAL_MAX_SEND_INTERVAL_MS - (now - lastGlobalMaxSendAt)
  const last = lastMaxSendAt.get(chatId) ?? 0
  const chatWait = MAX_SEND_INTERVAL_MS - (now - last)
  const wait = Math.max(globalWait, chatWait, 0)
  if (wait > 0) {
    await sleep(wait)
  }
  const sentAt = Date.now()
  lastGlobalMaxSendAt = sentAt
  lastMaxSendAt.set(chatId, sentAt)
}

function maxApi<T>(fn: () => Promise<T>): Promise<T> {
  return apiCallWithRetry(fn, TG_CHAIN_MAX_API_RETRIES)
}

let botRef: Bot | null = null

export function setTgChainForwarderBot(bot: Bot): void {
  botRef = bot
}

export function getTgChainForwarderBot(): Bot | null {
  return botRef
}

function getReaderOffset(tgToken: string): number {
  return getTelegramBotUpdatesOffset(tgToken)
}

function setReaderOffset(tgToken: string, offset: number): void {
  setTelegramBotUpdatesOffset(tgToken, offset)
}

/** Long-poll / drain TG updates for main CommentBot (my_chat_member, /start, callbacks). */
export async function syncMainTelegramBotDiscoveryUpdates(
  tgToken: string,
  options?: { timeoutSec?: number; maxPages?: number },
): Promise<number> {
  if (!isMainTelegramBotToken(tgToken)) {
    return 0
  }
  const timeoutSec = options?.timeoutSec ?? 0
  // Живой long-poll уже читает ту же очередь. Повторный getUpdates (timeout=0)
  // даёт 409, сдвигает offset и выкидывает channel_post без пересылки в MAX.
  if (timeoutSec === 0 && isTelegramGetUpdatesOwnedByForwarder(tgToken)) {
    return 0
  }
  let offset = getReaderOffset(tgToken)
  const maxPages = options?.maxPages ?? 8
  let processed = 0

  for (let page = 0; page < maxPages; page++) {
    let batch: TgChannelUpdate[]
    try {
      batch = await getTelegramUpdatesWithIds(tgToken, offset, timeoutSec, {
        includeMiniappBotUpdates: true,
      })
    } catch (err: unknown) {
      if (err instanceof TelegramGetUpdatesConflictError) {
        logger.warn('[tgChain] main bot discovery 409 conflict')
        break
      }
      throw err
    }
    if (batch.length === 0) {
      break
    }

    const rawUpdates = batch
      .map((u) => u.raw)
      .filter((u): u is Record<string, unknown> => !!u)
    if (rawUpdates.length > 0) {
      void processTelegramMiniappBotUpdates(tgToken, rawUpdates, botRef)
    }

    await dispatchChannelUpdatesToChains(tgToken, batch)

    for (const u of batch) {
      offset = Math.max(offset, u.update_id + 1)
      processed += 1
    }
    if (batch.length < 100) {
      break
    }
  }

  if (offset > getReaderOffset(tgToken)) {
    setReaderOffset(tgToken, offset)
  }
  return processed
}

function chainSourceKey(chain: TgChainRecord): string {
  const id = chain.tg_channel_id?.trim()
  if (id) {
    return id
  }
  const u = chain.tg_username?.trim().replace(/^@/, '') ?? ''
  return u ? `@${u}` : ''
}

/** Минимальная метка времени TG-поста (мс) для пересылки; null = без ограничения. */
function resolveForwardPostsSinceMs(chain: TgChainRecord): number | null {
  if (!chain.forward_posts) {
    return null
  }
  const iso = chain.forward_posts_since?.trim() || chain.created_at?.trim() || ''
  if (!iso) {
    return null
  }
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) {
    return null
  }
  // Небольшой запас на рассинхрон часов TG и сервера.
  return ms - 120_000
}

function isTgPostTooOldForForward(chain: TgChainRecord, message: TgMessage): boolean {
  const sinceMs = resolveForwardPostsSinceMs(chain)
  if (sinceMs === null) {
    return false
  }
  const msgDateSec = message.date
  if (typeof msgDateSec !== 'number' || !Number.isFinite(msgDateSec)) {
    return false
  }
  return msgDateSec * 1000 < sinceMs
}

function isAlreadyForwarded(chainId: string, messageId: number): boolean {
  const row = getDb()
    .prepare('SELECT max_message_mid FROM tg_chain_forwarded WHERE chain_id = ? AND tg_message_id = ?')
    .get(chainId, messageId) as { max_message_mid: string | null } | undefined
  const mid = row?.max_message_mid?.trim()
  return Boolean(mid)
}

type ForwardedRecord = {
  max_message_mid: string | null
  tg_media_group_id: string | null
  album_chunk_index: number | null
  tg_payload: string | null
}

function getForwardedRecord(chainId: string, messageId: number): ForwardedRecord | null {
  const row = getDb()
    .prepare(
      `SELECT max_message_mid, tg_media_group_id, album_chunk_index, tg_payload
       FROM tg_chain_forwarded
       WHERE chain_id = ? AND tg_message_id = ?`,
    )
    .get(chainId, messageId) as ForwardedRecord | undefined
  return row ?? null
}

function listForwardedAlbumChunk(
  chainId: string,
  mediaGroupId: string,
  chunkIndex: number,
): Array<{ tg_message_id: number; tg_payload: string | null }> {
  return getDb()
    .prepare(
      `SELECT tg_message_id, tg_payload
       FROM tg_chain_forwarded
       WHERE chain_id = ? AND tg_media_group_id = ? AND album_chunk_index = ?
       ORDER BY tg_message_id ASC`,
    )
    .all(chainId, mediaGroupId, chunkIndex) as Array<{ tg_message_id: number; tg_payload: string | null }>
}

function syncTgMetadataOnForwardedPost(
  maxChatId: number,
  maxMid: string,
  chain: TgChainRecord,
  tgMessage: TgMessage,
): void {
  const chatId = resolveCanonicalChannelChatId(maxChatId) ?? maxChatId
  const post = postStore.findPostByChannelMessage(chatId, maxMid.trim())
  if (!post) {
    return
  }
  postStore.savePost({
    ...post,
    tg_msg_id: tgMessage.message_id,
    tg_channel_id: chain.tg_channel_id?.trim() || String(tgMessage.chat.id),
  })
}

function markForwarded(
  chainId: string,
  message: TgMessage,
  maxMid: string | null,
  chunkIndex: number | null,
): void {
  const mediaGroupId = message.media_group_id?.trim() || null
  const payload = JSON.stringify(message)
  getDb()
    .prepare(
      `INSERT INTO tg_chain_forwarded
       (chain_id, tg_message_id, max_message_mid, tg_media_group_id, album_chunk_index, tg_payload)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain_id, tg_message_id) DO UPDATE SET
         max_message_mid = excluded.max_message_mid,
         tg_media_group_id = excluded.tg_media_group_id,
         album_chunk_index = excluded.album_chunk_index,
         tg_payload = excluded.tg_payload`,
    )
    .run(chainId, message.message_id, maxMid, mediaGroupId, chunkIndex, payload)

  // Синхронизация комментариев: дублируем маппинг в post_comment_mapping
  if (maxMid) {
    upsertPostCommentMapping(chainId, message.message_id, maxMid, message.chat?.id ?? null)
    const chain = listTgChainsSync().find((c) => c.id === chainId)
    if (chain?.forward_comments) {
      void ensurePostThreadMapping(maxMid).catch((err: unknown) => {
        logger.warn('[tgChain] ensurePostThreadMapping failed', { chainId, maxMid, err })
      })
    }
  }
}

/** Токен TG-бота для опроса channel_post. Пустой bot_token в связке = основной CommentBot (как в miniapp), не reader. */
function resolveTgToken(chain: TgChainRecord): string {
  const fromChain = chain.bot_token?.trim()
  if (fromChain) return fromChain
  return resolveTelegramBotToken()
}

function pickAlbumCaption(messages: TgMessage[], addSignature: boolean): string {
  for (const m of messages) {
    const raw = (m.caption || m.text || '').trim()
    if (raw) {
      return addSignature ? `${raw}\n\n— TG` : raw
    }
  }
  return ''
}

function buildAlbumBufferKey(chain: TgChainRecord, msg: TgMessage): string | null {
  const gid = msg.media_group_id?.trim()
  if (!gid) return null
  return `${chain.id}:${msg.chat.id}:${gid}`
}

/**
 * Складывает сообщение media group в буфер и продлевает окно ожидания,
 * чтобы собрать альбом целиком даже при раздельных батчах getUpdates.
 */
function queueAlbumMessage(chain: TgChainRecord, tgToken: string, msg: TgMessage): void {
  const key = buildAlbumBufferKey(chain, msg)
  if (!key) return
  const now = Date.now()
  const existing = albumBuffer.get(key)
  if (existing) {
    if (!existing.messages.some((m) => m.message_id === msg.message_id)) {
      existing.messages.push(msg)
      existing.messages.sort((a, b) => a.message_id - b.message_id)
    }
    existing.flushAt = now + TG_ALBUM_BUFFER_MS
    persistForwardJob(chain, existing.messages, tgToken, existing.flushAt)
    return
  }
  const entry: BufferedAlbum = {
    chain,
    tgToken,
    messages: [msg],
    flushAt: now + TG_ALBUM_BUFFER_MS,
  }
  albumBuffer.set(key, entry)
  persistForwardJob(chain, entry.messages, tgToken, entry.flushAt)
}

function getAlbumBufferDelayMs(now: number = Date.now(), tgToken?: string): number | null {
  let minDelay: number | null = null
  for (const entry of albumBuffer.values()) {
    if (tgToken && entry.tgToken !== tgToken) continue
    const delay = Math.max(0, entry.flushAt - now)
    if (minDelay === null || delay < minDelay) {
      minDelay = delay
    }
  }
  return minDelay
}

function takeReadyAlbumEntries(now: number = Date.now(), tgToken?: string): BufferedAlbum[] {
  const ready: BufferedAlbum[] = []
  for (const [key, entry] of albumBuffer.entries()) {
    if (tgToken && entry.tgToken !== tgToken) continue
    if (entry.flushAt <= now) {
      ready.push(entry)
      albumBuffer.delete(key)
    }
  }
  ready.sort((a, b) => a.messages[0]!.message_id - b.messages[0]!.message_id)
  return ready
}

function chunkAlbumMessages(messages: TgMessage[]): TgMessage[][] {
  if (messages.length <= TG_ALBUM_MAX_MEDIA_PER_POST) return [messages]
  const chunks: TgMessage[][] = []
  for (let i = 0; i < messages.length; i += TG_ALBUM_MAX_MEDIA_PER_POST) {
    chunks.push(messages.slice(i, i + TG_ALBUM_MAX_MEDIA_PER_POST))
  }
  return chunks
}

/** Разбивает апдейты: одиночные посты и альбомы (несколько channel_post с media_group_id). */
function groupChannelPostsForForward(posts: TgMessage[]): TgMessage[][] {
  const singles: TgMessage[] = []
  const albums = new Map<string, TgMessage[]>()

  for (const msg of posts) {
    const gid = msg.media_group_id?.trim()
    if (gid) {
      const key = `${msg.chat.id}:${gid}`
      const list = albums.get(key) ?? []
      list.push(msg)
      albums.set(key, list)
    } else {
      singles.push(msg)
    }
  }

  const out: TgMessage[][] = singles.map((m) => [m])
  for (const list of albums.values()) {
    list.sort((a, b) => a.message_id - b.message_id)
    out.push(list)
  }
  return out
}

/** Публикует одно TG-сообщение в MAX; caption — явная подпись (для альбома только у первого кадра). */
async function forwardOneTgMessageToMax(
  bot: Bot,
  msg: TgMessage,
  tgToken: string,
  maxChatId: number,
  caption: string,
): Promise<string | null> {
  const chatId = resolveCanonicalChannelChatId(maxChatId) ?? maxChatId
  const messageText = caption.trim() || '\u00a0'
  const hasMedia = Boolean(msg.photo?.length || msg.video?.file_id || msg.document?.file_id)

  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]
    const url = await getTgFileUrl(tgToken, largest.file_id)
    if (url) {
      let image: { toJson(): unknown }
      try {
        const fileBuf = await downloadTgFileBuffer(url, 120_000)
        image = await maxApi(() => bot.api.uploadImage({ source: fileBuf }))
      } catch (err: unknown) {
        logger.warn('[tgChain] binary photo upload failed, fallback to url', {
          messageId: msg.message_id,
          err,
        })
        image = await maxApi(() => bot.api.uploadImage({ url }))
      }
      await throttleMaxChatSend(chatId)
      const sent = await maxApi(() =>
        bot.api.sendMessageToChat(chatId, messageText, {
          attachments: [image.toJson() as AttachmentRequest],
        }),
      )
      return sent.body?.mid ?? null
    }
    logger.warn('[tgChain] photo forward skipped: no TG file url', { messageId: msg.message_id })
  }
  if (msg.video?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.video.file_id)
    if (url) {
      const videoBuf = await downloadTgFileBuffer(url)
      const video = await maxApi(() => bot.api.uploadVideo({ source: videoBuf }))
      await throttleMaxChatSend(chatId)
      const sent = await maxApi(() =>
        bot.api.sendMessageToChat(chatId, messageText, {
          attachments: [video.toJson() as AttachmentRequest],
        }),
      )
      return sent.body?.mid ?? null
    }
  }
  if (msg.document?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.document.file_id)
    if (url) {
      const fileBuf = await downloadTgFileBuffer(url)
      const file = await maxApi(() => bot.api.uploadFile({ source: fileBuf }))
      await throttleMaxChatSend(chatId)
      const sent = await maxApi(() =>
        bot.api.sendMessageToChat(chatId, messageText, {
          attachments: [file.toJson() as AttachmentRequest],
        }),
      )
      return sent.body?.mid ?? null
    }
  }
  if (!hasMedia && caption.trim()) {
    await throttleMaxChatSend(chatId)
    const sent = await maxApi(() => bot.api.sendMessageToChat(chatId, caption.trim()))
    return sent.body?.mid ?? null
  }
  return null
}

/** Загружает одно TG-фото в MAX (тот же путь, что и для одиночного поста — через URL). */
async function uploadTgPhotoAttachment(
  bot: Bot,
  tgToken: string,
  fileId: string,
): Promise<ImageAttachmentRequest | null> {
  const url = await getTgFileUrl(tgToken, fileId)
  if (!url) return null
  let uploaded: { toJson(): unknown } | null = null
  try {
    // Prefer binary upload so MAX returns token-based image payloads.
    // Those can be safely merged into one album attachment (`payload.photos`).
    const fileBuf = await downloadTgFileBuffer(url)
    uploaded = await maxApi(() => bot.api.uploadImage({ source: fileBuf }))
  } catch (err: unknown) {
    logger.warn('[tgChain] album: binary image upload failed, fallback to url upload', {
      fileId,
      err,
    })
    uploaded = await maxApi(() => bot.api.uploadImage({ url }))
  }
  const json = uploaded.toJson() as ImageAttachmentRequest
  if (json.type !== 'image' || !json.payload) {
    return null
  }
  const { token, url: imageUrl, photos } = json.payload
  if (token || imageUrl || (photos && Object.keys(photos).length > 0)) {
    return json
  }
  return null
}

function mergeAlbumImageAttachments(images: ImageAttachmentRequest[]): AttachmentRequest[] {
  const out: AttachmentRequest[] = []
  for (const img of images) {
    const payload = img.payload
    if (!payload) continue
    if (payload.token) {
      out.push({ type: 'image', payload: { token: payload.token } })
      continue
    }
    if (payload.url) {
      out.push({ type: 'image', payload: { url: payload.url } })
      continue
    }
    if (payload.photos) {
      for (const photo of Object.values(payload.photos)) {
        if (photo?.token) {
          out.push({ type: 'image', payload: { token: photo.token } })
        }
      }
    }
  }
  return out
}

/** Загружает все фото альбома для одного поста MAX. */
async function buildAlbumImageAttachments(
  bot: Bot,
  photoMessages: TgMessage[],
  tgToken: string,
): Promise<AttachmentRequest[]> {
  const uploaded = await Promise.all(
    photoMessages.map((msg) =>
      albumUploadLimit(async (): Promise<ImageAttachmentRequest | null> => {
        if (!msg.photo?.length) return null
        const largest = msg.photo[msg.photo.length - 1]!
        return uploadTgPhotoAttachment(bot, tgToken, largest.file_id)
      }),
    ),
  )
  return mergeAlbumImageAttachments(
    uploaded.filter((att): att is ImageAttachmentRequest => att !== null),
  )
}

async function buildAlbumAttachments(
  bot: Bot,
  messages: TgMessage[],
  tgToken: string,
): Promise<AttachmentRequest[]> {
  const photoMessages = messages.filter((m) => m.photo && m.photo.length > 0)
  const attachments: AttachmentRequest[] = []

  const imageAtts = await buildAlbumImageAttachments(bot, photoMessages, tgToken)
  attachments.push(...imageAtts)

  if (photoMessages.length > 0 && imageAtts.length === 0) {
    logger.error('[tgChain] album: photos failed to upload', {
      photoCount: photoMessages.length,
      messageIds: messages.map((m) => m.message_id),
    })
    return []
  }

  const extraMedia = messages.filter((m) => !m.photo?.length && (m.video?.file_id || m.document?.file_id))
  const extraAtts = await Promise.all(
    extraMedia.map((msg) =>
      albumUploadLimit(async (): Promise<AttachmentRequest | null> => {
        if (msg.video?.file_id) {
          const url = await getTgFileUrl(tgToken, msg.video.file_id)
          if (!url) return null
          const videoBuf = await downloadTgFileBuffer(url)
          const video = await maxApi(() => bot.api.uploadVideo({ source: videoBuf }))
          return video.toJson() as AttachmentRequest
        }
        if (msg.document?.file_id) {
          const url = await getTgFileUrl(tgToken, msg.document.file_id)
          if (!url) return null
          const fileBuf = await downloadTgFileBuffer(url)
          const file = await maxApi(() => bot.api.uploadFile({ source: fileBuf }))
          return file.toJson() as AttachmentRequest
        }
        return null
      }),
    ),
  )
  for (const att of extraAtts) {
    if (att) attachments.push(att)
  }

  return attachments
}

async function buildSingleMessageAttachments(
  bot: Bot,
  msg: TgMessage,
  tgToken: string,
): Promise<AttachmentRequest[]> {
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]
    const url = await getTgFileUrl(tgToken, largest.file_id)
    if (!url) return []
    const image = await maxApi(() => bot.api.uploadImage({ url }))
    return [image.toJson() as AttachmentRequest]
  }
  if (msg.video?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.video.file_id)
    if (!url) return []
    const videoBuf = await downloadTgFileBuffer(url)
    const video = await maxApi(() => bot.api.uploadVideo({ source: videoBuf }))
    return [video.toJson() as AttachmentRequest]
  }
  if (msg.document?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.document.file_id)
    if (!url) return []
    const fileBuf = await downloadTgFileBuffer(url)
    const file = await maxApi(() => bot.api.uploadFile({ source: fileBuf }))
    return [file.toJson() as AttachmentRequest]
  }
  return []
}

/** Альбом TG → один пост MAX (все фото в одном сообщении, как в Telegram). */
async function forwardAlbumToMax(
  bot: Bot,
  messages: TgMessage[],
  tgToken: string,
  maxChatId: number,
  caption: string,
): Promise<string | null> {
  const chatId = resolveCanonicalChannelChatId(maxChatId) ?? maxChatId
  const messageText = caption.trim() || '\u00a0'
  const attachments = await buildAlbumAttachments(bot, messages, tgToken)

  if (attachments.length === 0) {
    return null
  }

  await throttleMaxChatSend(chatId)
  const sent = await maxApi(() =>
    bot.api.sendMessageToChat(chatId, messageText, {
      attachments: attachments.length > 0 ? attachments : undefined,
    }),
  )
  return sent.body?.mid ?? null
}

function parseBufferedTgPayload(payload: string | null): TgMessage | null {
  if (!payload) return null
  try {
    return JSON.parse(payload) as TgMessage
  } catch {
    return null
  }
}

async function loadInlineKeyboardAttachment(
  bot: Bot,
  maxMid: string,
): Promise<AttachmentRequest | null> {
  try {
    const message = await maxApi(() => bot.api.getMessage(maxMid))
    const keyboard = message.body.attachments?.find((att) => att.type === 'inline_keyboard')
    return (keyboard as AttachmentRequest | undefined) ?? null
  } catch {
    return null
  }
}

function firstImageUrlFromAttachments(attachments: AttachmentRequest[]): string | undefined {
  for (const att of attachments) {
    if (att.type === 'image') {
      const payload = (att as { payload?: { url?: string } }).payload
      if (payload?.url && payload.url.trim() !== '') {
        return payload.url
      }
    }
  }
  return undefined
}

async function editMaxMessageFromTelegram(
  bot: Bot,
  maxMid: string,
  text: string,
  attachments: AttachmentRequest[],
): Promise<void> {
  if (attachments.length === 0) {
    await maxApi(() => bot.api.editMessage(maxMid, { text: text.trim() || '\u00a0' }))
    return
  }
  const keyboard = await loadInlineKeyboardAttachment(bot, maxMid)
  const nextAttachments = keyboard ? [...attachments, keyboard] : attachments
  await maxApi(() =>
    bot.api.editMessage(maxMid, {
      text: text.trim() || '\u00a0',
      attachments: nextAttachments,
    }),
  )
}

function syncStoredPostAfterEdit(
  maxChatId: number,
  maxMid: string,
  text: string,
  attachments: AttachmentRequest[],
): void {
  const chatId = resolveCanonicalChannelChatId(maxChatId) ?? maxChatId
  const post = postStore.findPostByChannelMessage(chatId, maxMid)
  if (!post) return
  postStore.savePost({
    ...post,
    text: text.trim(),
    photo_url: attachments.length > 0 ? firstImageUrlFromAttachments(attachments) : post.photo_url,
    media_attachments: attachments.length > 0 ? attachments : post.media_attachments,
    timestamp: new Date().toISOString(),
  })
}

async function processEditedChainMessage(
  chain: TgChainRecord,
  msg: TgMessage,
  tgToken: string,
): Promise<void> {
  if (!telegramMessageMatchesTgChain(msg.chat, chain)) return
  const mapping = getForwardedRecord(chain.id, msg.message_id)
  const mappedMid = mapping?.max_message_mid?.trim()
  if (!mapping || !mappedMid || mappedMid === TG_FORWARD_SKIPPED_MID) {
    logger.info('[tgChain] skip edit: original post was not forwarded', {
      chainId: chain.id,
      tgMessageId: msg.message_id,
    })
    return
  }
  const bot = botRef
  if (!bot) {
    throw new Error('MAX bot not initialized (setTgChainForwarderBot)')
  }

  try {
    const isAlbum = Boolean(msg.media_group_id?.trim() || mapping.tg_media_group_id?.trim())
    const maxMid = mappedMid
    if (isAlbum) {
      const mediaGroupId = (msg.media_group_id?.trim() || mapping.tg_media_group_id?.trim()) ?? ''
      const chunkIndex = mapping.album_chunk_index ?? 0
      markForwarded(chain.id, msg, maxMid, chunkIndex)
      const rows = listForwardedAlbumChunk(chain.id, mediaGroupId, chunkIndex)
      const rebuilt = rows
        .map((row) => parseBufferedTgPayload(row.tg_payload))
        .filter((item): item is TgMessage => Boolean(item))
      if (!rebuilt.some((item) => item.message_id === msg.message_id)) {
        rebuilt.push(msg)
      }
      rebuilt.sort((a, b) => a.message_id - b.message_id)
      const caption = pickAlbumCaption(rebuilt, chain.add_signature)
      const attachments = await buildAlbumAttachments(bot, rebuilt, tgToken)
      if (attachments.length === 0 && caption.trim() === '') {
        return
      }
      await editMaxMessageFromTelegram(bot, maxMid, caption, attachments)
      syncStoredPostAfterEdit(chain.max_chat_id, maxMid, caption, attachments)
      logger.info('[tgChain] edited album synced', {
        chainId: chain.id,
        tgMessageId: msg.message_id,
        maxMessageMid: maxMid,
        mediaGroupId,
        chunkIndex,
      })
      return
    }

    const caption = (() => {
      const raw = (msg.caption || msg.text || '').trim()
      if (chain.add_signature && raw) return `${raw}\n\n— TG`
      return raw
    })()
    const attachments = await buildSingleMessageAttachments(bot, msg, tgToken)
    if (attachments.length === 0 && caption.trim() === '') {
      return
    }
    markForwarded(chain.id, msg, maxMid, null)
    await editMaxMessageFromTelegram(bot, maxMid, caption, attachments)
    syncStoredPostAfterEdit(chain.max_chat_id, maxMid, caption, attachments)
    logger.info('[tgChain] edited post synced', {
      chainId: chain.id,
      tgMessageId: msg.message_id,
      maxMessageMid: maxMid,
    })
  } catch (err: unknown) {
    const axiosDetail =
      axios.isAxiosError(err) && err.response
        ? { status: err.response.status, data: err.response.data }
        : undefined
    logger.error('[tgChain] edit sync failed', {
      chainId: chain.id,
      tgMessageId: msg.message_id,
      err,
      axiosDetail,
    })
    const errorsToday = chain.errors_today + 1
    chain.errors_today = errorsToday
    await updateTgChain(chain.id, { errors_today: errorsToday })
  }
}

async function processChainMessageGroup(
  chain: TgChainRecord,
  messages: TgMessage[],
  tgToken: string,
): Promise<boolean> {
  const pending = messages.filter((m) => {
    if (!telegramMessageMatchesTgChain(m.chat, chain)) {
      return false
    }
    if (isAlreadyForwarded(chain.id, m.message_id)) {
      return false
    }
    if (isTgPostTooOldForForward(chain, m)) {
      markForwarded(chain.id, m, TG_FORWARD_SKIPPED_MID, null)
      logger.info('[tgChain] skip old TG post (before forward_posts_since)', {
        chainId: chain.id,
        tgMessageId: m.message_id,
        tgDate: m.date ?? null,
        forwardPostsSince: chain.forward_posts_since ?? chain.created_at,
      })
      return false
    }
    return true
  })
  if (pending.length === 0) {
    return true
  }
  const bot = botRef
  if (!bot) {
    throw new Error('MAX bot not initialized (setTgChainForwarderBot)')
  }

  const isAlbum = pending.length > 1 || Boolean(pending[0]?.media_group_id)
  const attachComments = chain.add_comments_button !== false

  try {
    let published = 0
    let resultMid: string | null = null
    if (isAlbum) {
      // Для media group > 10 отправляем несколькими постами (по 10 вложений).
      // Подпись Telegram переносим только в первый чанк, чтобы текст не дублировался.
      const ordered = [...pending].sort((a, b) => a.message_id - b.message_id)
      const chunks = chunkAlbumMessages(ordered)
      const firstCaption = pickAlbumCaption(ordered, chain.add_signature)
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i]!
        const chunkCaption = i === 0 ? firstCaption : ''
        resultMid = await forwardAlbumToMax(
          bot,
          chunk,
          tgToken,
          chain.max_chat_id,
          chunkCaption,
        )
        if (typeof resultMid === 'string' && resultMid.trim() !== '') {
          const maxMid = resultMid.trim()
          let keepPublished = true
          if (attachComments) {
            keepPublished = await attachAndVerifyCommentsForForwardedPost(bot, chain.max_chat_id, maxMid, {
              chainId: chain.id,
              knownCaption: chunkCaption,
            })
          }
          if (keepPublished) {
            published += 1
            for (const msg of chunk) {
              markForwarded(chain.id, msg, maxMid, i)
              syncTgMetadataOnForwardedPost(chain.max_chat_id, maxMid, chain, msg)
            }
            void publishTelegramPostToVk({
              maxChatId: chain.max_chat_id,
              maxMid,
              tgToken,
              tgMessages: chunk,
            }).catch((err: unknown) => {
              logger.warn('[tgChain] VK publish (album) failed', { chainId: chain.id, maxMid, err })
            })
          } else {
            logger.warn('[tgChain] chunk not marked forwarded — comment gate rollback, TG retry later', {
              chainId: chain.id,
              maxMessageMid: maxMid,
              chunkIndex: i,
            })
          }
        }
      }
    } else {
      const msg = pending[0]
      let caption = (msg.caption || msg.text || '').trim()
      if (chain.add_signature && caption) {
        caption = `${caption}\n\n— TG`
      }
      resultMid = await forwardOneTgMessageToMax(
        bot,
        msg,
        tgToken,
        chain.max_chat_id,
        caption,
      )
      if (typeof resultMid === 'string' && resultMid.trim() !== '') {
        const maxMid = resultMid.trim()
        let keepPublished = true
        if (attachComments) {
          keepPublished = await attachAndVerifyCommentsForForwardedPost(bot, chain.max_chat_id, maxMid, {
            chainId: chain.id,
            knownCaption: caption,
          })
        }
        if (keepPublished) {
          published = 1
          markForwarded(chain.id, msg, maxMid, null)
          syncTgMetadataOnForwardedPost(chain.max_chat_id, maxMid, chain, msg)
          void publishTelegramPostToVk({
            maxChatId: chain.max_chat_id,
            maxMid,
            tgToken,
            tgMessages: [msg],
          }).catch((err: unknown) => {
            logger.warn('[tgChain] VK publish (single) failed', { chainId: chain.id, maxMid, err })
          })
        } else {
          logger.warn('[tgChain] post not marked forwarded — comment gate rollback, TG retry later', {
            chainId: chain.id,
            maxMessageMid: resultMid,
            tgMessageId: msg.message_id,
          })
        }
      }
    }

    if (published > 0) {
      const forwardedToday = chain.forwarded_today + published
      chain.forwarded_today = forwardedToday
      touchChainActivity(chain.id)
      await updateTgChain(chain.id, { forwarded_today: forwardedToday })
      const tgDateSec = pending[0]?.date
      logger.info('[tgChain] forwarded', {
        chainId: chain.id,
        from: chainSourceKey(chain),
        to: chain.max_chat_id,
        published,
        album: isAlbum,
        maxMessageMid: resultMid,
        photoCount: isAlbum ? pending.filter((m) => m.photo?.length).length : undefined,
        messageIds: pending.map((m) => m.message_id),
        lagMs:
          typeof tgDateSec === 'number' && Number.isFinite(tgDateSec)
            ? Date.now() - tgDateSec * 1000
            : undefined,
      })
    }
    const remaining = pending.filter((m) => !isAlreadyForwarded(chain.id, m.message_id))
    return remaining.length === 0
  } catch (err: unknown) {
    const axiosDetail =
      axios.isAxiosError(err) && err.response
        ? { status: err.response.status, data: err.response.data }
        : undefined
    logger.error('[tgChain] forward failed', {
      chainId: chain.id,
      from: chainSourceKey(chain),
      to: chain.max_chat_id,
      messageIds: pending.map((m) => m.message_id),
      err,
      axiosDetail,
    })
    const errorsToday = chain.errors_today + 1
    chain.errors_today = errorsToday
    await updateTgChain(chain.id, { errors_today: errorsToday })
    return false
  }
}

function flushReadyAlbums(tgToken?: string): boolean {
  const ready = takeReadyAlbumEntries(Date.now(), tgToken)
  if (ready.length === 0) return false
  for (const entry of ready) {
    enqueueForward(entry.chain, entry.messages, entry.tgToken)
  }
  return true
}

function listActiveForwardChains(): TgChainRecord[] {
  return listTgChainsSync().filter(
    (c) => c.active && (c.forward_posts || c.forward_comments) && chainSourceKey(c) !== '',
  )
}

function collectTokensToPoll(): string[] {
  const tokens = new Set<string>()
  for (const chain of listActiveForwardChains()) {
    const token = resolveTgToken(chain)
    if (token) tokens.add(token)
  }
  const mainToken = resolveTelegramBotToken()
  if (mainToken && isMainTelegramBotToken(mainToken)) {
    tokens.add(mainToken)
  }
  return [...tokens]
}

async function dispatchChannelUpdatesToChains(tgToken: string, batch: TgChannelUpdate[]): Promise<void> {
  const group = listActiveForwardChains().filter((c) => resolveTgToken(c) === tgToken)
  if (group.length === 0) {
    return
  }

  const channelPosts: TgMessage[] = []
  const editedChannelPosts: TgMessage[] = []
  const editedMessages: TgMessage[] = []
  const discussionMessages: TgMessage[] = []
  for (const u of batch) {
    if (u.channel_post) {
      channelPosts.push(u.channel_post)
    }
    if (u.edited_channel_post) {
      editedChannelPosts.push(u.edited_channel_post)
    }
    if (u.edited_message) {
      editedMessages.push(u.edited_message)
    }
    if (u.message) {
      discussionMessages.push(u.message)
    }
  }

  const discussionChatByChain = new Map<string, number | null>()
  if (discussionMessages.length > 0) {
    const commentChains = group.filter((c) => c.forward_comments)
    await Promise.all(
      commentChains.map(async (chain) => {
        discussionChatByChain.set(chain.id, await resolveDiscussionChatId(tgToken, chain))
      }),
    )
  }

  for (const chain of group) {
    const sourceKey = chainSourceKey(chain)
    const forChain = channelPosts.filter((m) => telegramMessageMatchesTgChain(m.chat, chain))
    if (channelPosts.length > 0 && forChain.length === 0) {
      logger.debug('[tgChain] channel_post batch did not match chain', {
        chainId: chain.id,
        sourceKey,
        tg_channel_id: chain.tg_channel_id ?? null,
        tg_username: chain.tg_username ?? null,
        sampleChatId: channelPosts[0]?.chat?.id,
        sampleUsername: channelPosts[0]?.chat?.username ?? null,
      })
    }
    if (forChain.length > 0) {
      const first = forChain[0]
      const tgDateSec = first?.date
      logger.info('[tgChain] received', {
        chainId: chain.id,
        messageIds: forChain.map((m) => m.message_id),
        lagMs:
          typeof tgDateSec === 'number' && Number.isFinite(tgDateSec)
            ? Date.now() - tgDateSec * 1000
            : undefined,
      })
    }
    const chainGroups = groupChannelPostsForForward(forChain)
    for (const msgs of chainGroups) {
      const isMediaGroup = msgs.length > 1 || Boolean(msgs[0]?.media_group_id)
      if (isMediaGroup) {
        for (const msg of msgs) {
          queueAlbumMessage(chain, tgToken, msg)
        }
        continue
      }
      enqueueForward(chain, msgs, tgToken)
    }

    const editedForChain = editedChannelPosts.filter((m) =>
      telegramMessageMatchesTgChain(m.chat, chain),
    )
    for (const edited of editedForChain) {
      enqueueChannelWork(chain.max_chat_id, () => processEditedChainMessage(chain, edited, tgToken))
    }
    const editedMessagesForChain = editedMessages.filter((m) =>
      telegramMessageMatchesTgChain(m.chat, chain),
    )
    for (const edited of editedMessagesForChain) {
      enqueueChannelWork(chain.max_chat_id, () => processEditedChainMessage(chain, edited, tgToken))
    }

    if (chain.forward_comments && discussionMessages.length > 0) {
      const discussionChatId = discussionChatByChain.get(chain.id) ?? null
      if (discussionChatId == null) {
        continue
      }
      for (const msg of discussionMessages) {
        if (msg.chat.id !== discussionChatId) {
          continue
        }
        if (isDiscussionAutoForward(msg)) {
          handleDiscussionAutoForward(msg, chain.id)
          continue
        }
        if (!msg.reply_to_message) {
          continue
        }
        const jobKey = upsertCommentInboundJob({
          chainId: chain.id,
          discussionChatId,
          message: msg,
        })
        scheduleInboundComment(chain, msg, discussionChatId, jobKey)
      }
    }
  }
}

async function runTgChainsForToken(tgToken: string): Promise<boolean> {
  let receivedAny = flushReadyAlbums(tgToken)
  if (!botRef) {
    logger.warn('[tgChain] MAX bot not set — skip tick')
    return receivedAny
  }

  const group = listActiveForwardChains().filter((c) => resolveTgToken(c) === tgToken)
  if (group.length === 0) {
    if (isMainTelegramBotToken(tgToken)) {
      const n = await syncMainTelegramBotDiscoveryUpdates(tgToken, {
        timeoutSec: TG_CHAIN_LONG_POLL_SEC,
      })
      if (n > 0) {
        receivedAny = true
      }
    }
    return receivedAny
  }

  const offset = getReaderOffset(tgToken)
  const includeMiniappBotUpdates = isMainTelegramBotToken(tgToken)
  const includeDiscussionMessages = group.some((c) => c.forward_comments)
  let batch: TgChannelUpdate[]
  try {
    const pendingAlbumDelayMs = getAlbumBufferDelayMs(Date.now(), tgToken)
    const timeoutSec =
      pendingAlbumDelayMs === null
        ? TG_CHAIN_LONG_POLL_SEC
        : Math.max(0, Math.min(TG_CHAIN_LONG_POLL_SEC, Math.ceil(pendingAlbumDelayMs / 1000)))
    batch = await getTelegramUpdatesWithIds(tgToken, offset, timeoutSec, {
      includeMiniappBotUpdates,
      includeDiscussionMessages,
    })
  } catch (err: unknown) {
    if (err instanceof TelegramGetUpdatesConflictError) {
      invalidateTelegramPollingModeCache(tgToken)
      await sleep(10_000)
      return receivedAny
    }
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      invalidateTelegramPollingModeCache(tgToken)
      logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s')
      await sleep(10_000)
      return receivedAny
    }
    throw err
  }
  let nextOffset = offset

  for (const u of batch) {
    receivedAny = true
    nextOffset = Math.max(nextOffset, u.update_id + 1)
  }

  // Сначала очередь постов, потом миниапп: иначе callback/FLOOD_WAIT держит getUpdates.
  await dispatchChannelUpdatesToChains(tgToken, batch)

  if (includeMiniappBotUpdates) {
    const rawUpdates = batch
      .map((u) => u.raw)
      .filter((u): u is Record<string, unknown> => !!u)
    if (rawUpdates.length > 0) {
      void processTelegramMiniappBotUpdates(tgToken, rawUpdates, botRef)
    }
  }

  if (nextOffset > offset) {
    setReaderOffset(tgToken, nextOffset)
  }

  for (const chain of group) {
    touchChainActivity(chain.id)
  }

  if (flushReadyAlbums(tgToken)) {
    receivedAny = true
  }

  return receivedAny
}

export async function runTgChainsOnce(): Promise<boolean> {
  const tokens = collectTokensToPoll()
  if (tokens.length === 0) {
    return false
  }
  const results = await Promise.all(tokens.map((token) => runTgChainsForToken(token)))
  return results.some(Boolean)
}

let loopStarted = false
let watchdogStarted = false
const tokenLoops = new Map<string, { stop: () => void }>()

async function restartTokenPollLoop(tgToken: string): Promise<void> {
  const existing = tokenLoops.get(tgToken)
  if (existing) {
    existing.stop()
    tokenLoops.delete(tgToken)
  }
  await sleep(400)
  if (!tokenLoops.has(tgToken) && collectTokensToPoll().includes(tgToken)) {
    tokenLoops.set(tgToken, startTokenPollLoop(tgToken))
    logger.info('[tgChain] watchdog: token poll loop restarted', { tokenHint: tgToken.slice(-6) })
  }
}

function startTokenPollLoop(tgToken: string): { stop: () => void } {
  let stopped = false
  setTelegramGetUpdatesOwner(tgToken, true)
  void ensureTelegramPollingMode(tgToken)
  for (const chain of listActiveForwardChains()) {
    if (resolveTgToken(chain) === tgToken) {
      touchChainActivity(chain.id)
    }
  }
  const loop = async () => {
    while (!stopped) {
      try {
        const hadUpdates = await runTgChainsForToken(tgToken)
        if (!hadUpdates) {
          const albumDelayMs = getAlbumBufferDelayMs(Date.now(), tgToken)
          if (albumDelayMs === null) {
            await sleep(TG_CHAIN_IDLE_MS)
          } else {
            await sleep(Math.min(TG_CHAIN_IDLE_MS, Math.max(15, albumDelayMs)))
          }
        }
      } catch (err: unknown) {
        if (err instanceof TelegramGetUpdatesConflictError) {
          invalidateTelegramPollingModeCache(tgToken)
          logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s')
          await sleep(10_000)
          continue
        }
        if (axios.isAxiosError(err) && err.response?.status === 409) {
          invalidateTelegramPollingModeCache(tgToken)
          logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s')
          await sleep(10_000)
          continue
        }
        if (isTelegramGetUpdatesTimeoutError(err)) {
          logger.debug('[tgChain] getUpdates idle timeout, retrying', {
            tokenHint: tgToken.slice(-6),
          })
          continue
        }
        logger.error('[tgChain] loop error', { err, tokenHint: tgToken.slice(-6) })
        await sendAdminAlert('forwarder_crash', 'Форвардер упал с ошибкой', {
          error: String(err),
        })
        await sleep(1_000)
      }
    }
  }
  void loop()
  return {
    stop: () => {
      stopped = true
      setTelegramGetUpdatesOwner(tgToken, false)
    },
  }
}

function syncTokenPollLoops(): void {
  const tokens = new Set(collectTokensToPoll())
  for (const [token, handle] of tokenLoops) {
    if (!tokens.has(token)) {
      handle.stop()
      tokenLoops.delete(token)
    }
  }
  for (const token of tokens) {
    if (!tokenLoops.has(token)) {
      tokenLoops.set(token, startTokenPollLoop(token))
      logger.info('[tgChain] token poll loop started', { tokenHint: token.slice(-6) })
    }
  }
}

function startForwarderLoop(): void {
  if (globalForwarderHandle) {
    return
  }
  let stopped = false
  syncTokenPollLoops()
  const supervisor = setInterval(() => {
    if (!stopped) {
      syncTokenPollLoops()
      drainDueForwardJobs()
      drainDueCommentJobs()
    }
  }, 2_000)
  drainDueForwardJobs()
  drainDueCommentJobs()
  globalForwarderHandle = {
    stop: () => {
      stopped = true
      clearInterval(supervisor)
      for (const handle of tokenLoops.values()) {
        handle.stop()
      }
      tokenLoops.clear()
    },
  }
  activeForwarders.set('__global__', globalForwarderHandle)
}

function startTgChainWatchdog(): void {
  if (watchdogStarted) return
  watchdogStarted = true
  setInterval(() => {
    void (async () => {
      const now = Date.now()
      const silentThresholdMs = 2 * 60 * 1000

      for (const chain of listTgChainsSync()) {
        if (!chain.forward_posts || !chain.active) continue

        const lastSeen = chainLastActivity.get(chain.id)
        if (!lastSeen) continue

        const silentMs = now - lastSeen
        if (silentMs > silentThresholdMs) {
          const restarts = chainRestartCount.get(chain.id) ?? 0
          const token = resolveTgToken(chain)
          if (!token) {
            continue
          }
          logger.warn('[tgChain] watchdog: chain silent, restarting token poll', {
            chainId: chain.id,
            title: chain.max_title,
            silentMinutes: Math.round(silentMs / 60000),
            restartCount: restarts + 1,
          })
          await sendAdminAlert(
            'chain_silent',
            `Цепочка молчит ${Math.round(silentMs / 60000)} мин`,
            {
              chainId: chain.id,
              title: chain.max_title,
            },
          )
          chainRestartCount.set(chain.id, restarts + 1)
          chainLastActivity.set(chain.id, now)
          await restartTokenPollLoop(token)
        }
      }
    })().catch((err: unknown) => {
      logger.warn('[tgChain] watchdog error', { err })
    })
  }, 30 * 1000)
}

export function startTgChainForwarder(): void {
  if (loopStarted) return
  loopStarted = true
  startTgChainWatchdog()
  logger.info('[tgChain] forwarder started (per-token long-poll, async publish)')
  startForwarderLoop()
}
