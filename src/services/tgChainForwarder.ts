import { AsyncLocalStorage } from 'node:async_hooks'

import axios from 'axios'
import FormData from 'form-data'
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
import { markChannelForwardBusy } from './channelForwardBusy'
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
  COMMENT_MAPPING_GIVE_UP_ATTEMPTS,
  COMMENT_MAPPING_RETRY_MS,
  COMMENT_MAPPING_SLOW_AFTER_ATTEMPTS,
  COMMENT_MAPPING_SLOW_RETRY_MS,
  shouldLogCommentMappingRetry,
  deleteCommentInboundJob,
  deleteForwardQueueJob,
  getForwardQueueJob,
  listDueCommentInboundJobs,
  listDueForwardQueueJobs,
  nudgeCommentInboundJobs,
  parseForwardQueueMessages,
  parseInboundCommentMessage,
  upsertCommentInboundJob,
  upsertForwardQueueJob,
  countForwardQueueJobs,
  countCommentInboundJobs,
  summarizeForwardQueueByChain,
  summarizeCommentQueueByChain,
} from './tgChainForwardQueue'
import {
  recordCommentRetry,
  recordCommentSkip,
  recordQueueSnapshot,
  recordTgMaxFail,
  recordTgMaxPartial,
  recordTgMaxReceived,
  recordTgMaxRetry,
  recordTgMaxSkip,
  recordTgMaxSuccess,
  tgChainDisplayName,
} from './chainTransferLog'

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
const TG_ALBUM_BUFFER_MS = 3_200
/** Один кадр с media_group_id почти наверняка неполный альбом — ждём остальные. */
const TG_ALBUM_SINGLE_FRAME_EXTRA_MS = 4_500
const PHOTO_UPLOAD_ATTEMPTS = 3
/** MAX часто отвечает attachment.not.ready, если слать сразу после upload. */
const ALBUM_ATTACH_SETTLE_MS = 700
/** Пауза при 409 getUpdates — короткий retry, без 10с простоя. */
const TG_GETUPDATES_CONFLICT_WAIT_MS = 2_500
/** Как часто снимать due-задачи постов/комментариев с очереди. */
const TG_QUEUE_DRAIN_MS = 400
/** Telegram media group ограничен 10 элементами. */
const TG_ALBUM_MAX_MEDIA_PER_POST = 10
const MEDIA_DOWNLOAD_TIMEOUT_MS = 45_000
const MEDIA_MAX_BYTES = 32 * 1024 * 1024
/** Глобальный потолок, чтобы все связки вместе не забили сеть. */
const GLOBAL_ALBUM_UPLOAD_CONCURRENCY = 8
const GLOBAL_MEDIA_DOWNLOAD_CONCURRENCY = 8
/** На одну связку — отдельно, чтобы тяжёлый альбом не стопорил остальные. */
const CHAIN_ALBUM_UPLOAD_CONCURRENCY = 3
const CHAIN_MEDIA_DOWNLOAD_CONCURRENCY = 2
/** Глобальный зазор между send в MAX — чтобы пачка каналов не ловила 429. */
const GLOBAL_MAX_SEND_INTERVAL_MS = 200
/** getUpdates long-poll 25с; если тик не вернулся дольше — перезапуск только этого токена. */
const TOKEN_POLL_STALE_MS = 90_000
const globalAlbumUploadLimit = pLimit(GLOBAL_ALBUM_UPLOAD_CONCURRENCY)
const globalMediaDownloadLimit = pLimit(GLOBAL_MEDIA_DOWNLOAD_CONCURRENCY)

type ChainWorkStore = { chainId: string }
const chainWorkContext = new AsyncLocalStorage<ChainWorkStore>()
const chainAlbumLimits = new Map<string, ReturnType<typeof pLimit>>()
const chainMediaLimits = new Map<string, ReturnType<typeof pLimit>>()

function limitForChain(
  cache: Map<string, ReturnType<typeof pLimit>>,
  concurrency: number,
  chainId: string | undefined,
): ReturnType<typeof pLimit> | null {
  if (!chainId) {
    return null
  }
  let limit = cache.get(chainId)
  if (!limit) {
    limit = pLimit(concurrency)
    cache.set(chainId, limit)
  }
  return limit
}

function albumUploadLimit<T>(fn: () => Promise<T>): Promise<T> {
  const chainId = chainWorkContext.getStore()?.chainId
  const chainLimit = limitForChain(chainAlbumLimits, CHAIN_ALBUM_UPLOAD_CONCURRENCY, chainId)
  return globalAlbumUploadLimit(() => (chainLimit ? chainLimit(fn) : fn()))
}

const lastMaxSendAt = new Map<number, number>()
let lastGlobalMaxSendAt = 0
const chainWorkTails = new Map<string, Promise<void>>()
const commentWorkTails = new Map<string, Promise<void>>()
const inFlightForwardKeys = new Set<string>()
const inFlightCommentKeys = new Set<string>()
const tokenLastPollAt = new Map<string, number>()
type BufferedAlbum = {
  chain: TgChainRecord
  tgToken: string
  messages: TgMessage[]
  flushAt: number
  singleFrameWaitUsed?: boolean
}
const albumBuffer = new Map<string, BufferedAlbum>()

function enqueueChainWork(chainId: string, work: () => Promise<void>): void {
  const prev = chainWorkTails.get(chainId) ?? Promise.resolve()
  const run = (): Promise<void> => chainWorkContext.run({ chainId }, work)
  const next = prev.then(run, run)
  chainWorkTails.set(
    chainId,
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
  return forwardKey(chain.id, messages)
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

function chainTitle(chain: TgChainRecord): string {
  return tgChainDisplayName(chain)
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message
  }
  return String(err ?? 'forward failed')
}

function enqueueForward(chain: TgChainRecord, messages: TgMessage[], tgToken: string): void {
  if (messages.length === 0) {
    return
  }
  const jobKey = persistForwardJob(chain, messages, tgToken)
  scheduleForwardJob(chain, messages, tgToken, jobKey)
}

function leftoverUnforwarded(chainId: string, jobKey: string, fallback: TgMessage[]): TgMessage[] {
  const job = getForwardQueueJob(jobKey)
  const latest = job ? parseForwardQueueMessages(job.payload) : fallback
  return latest.filter((m) => !isAlreadyForwarded(chainId, m.message_id))
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
  if (albumBuffer.has(jobKey)) {
    return
  }
  if (messages.every((m) => isAlreadyForwarded(chain.id, m.message_id))) {
    const leftover = leftoverUnforwarded(chain.id, jobKey, messages)
    if (leftover.length === 0) {
      deleteForwardQueueJob(jobKey)
    }
    return
  }
  inFlightForwardKeys.add(jobKey)
  enqueueChainWork(chain.id, async () => {
    let leftover: TgMessage[] = []
    try {
      const job = getForwardQueueJob(jobKey)
      const latest = job ? parseForwardQueueMessages(job.payload) : messages
      const toProcess = latest.length > 0 ? latest : messages
      const ok = await processChainMessageGroup(chain, toProcess, tgToken)
      leftover = leftoverUnforwarded(chain.id, jobKey, toProcess)
      if (leftover.length === 0) {
        deleteForwardQueueJob(jobKey)
      } else if (!ok) {
        leftover = []
        const lastError = 'MAX publish incomplete'
        const attempts = bumpForwardQueueRetry(jobKey, lastError)
        logger.warn('[tgChain] forward queued for retry', {
          chainId: chain.id,
          jobKey,
          messageIds: toProcess.map((m) => m.message_id),
          attempts,
          lastError,
        })
        recordTgMaxRetry({
          chainId: chain.id,
          title: chainTitle(chain),
          messageIds: toProcess.map((m) => m.message_id),
          error: lastError,
          attempts,
          queueDepth: countForwardQueueJobs(),
        })
        if (attempts >= 6) {
          void sendAdminAlert(
            `forward_stuck:${chain.id}`,
            `Перенос постов заблокирован: ${attempts} неудачных попыток публикации в MAX`,
            {
              chainId: chain.id,
              title: chain.max_title,
              jobKey,
              messageIds: toProcess.map((m) => m.message_id),
            },
          )
        }
      }
    } catch (err: unknown) {
      leftover = []
      const lastError = errorText(err)
      const attempts = bumpForwardQueueRetry(jobKey, err)
      logger.warn('[tgChain] forward queued for retry', {
        chainId: chain.id,
        jobKey,
        messageIds: messages.map((m) => m.message_id),
        attempts,
        lastError,
      })
      recordTgMaxFail({
        chainId: chain.id,
        title: chainTitle(chain),
        messageIds: messages.map((m) => m.message_id),
        error: lastError,
        attempts,
      })
      if (attempts >= 6) {
        void sendAdminAlert(
          `forward_stuck:${chain.id}`,
          `Перенос постов заблокирован: ${attempts} ошибок подряд`,
          {
            chainId: chain.id,
            title: chain.max_title,
            jobKey,
            error: lastError,
          },
        )
      }
    } finally {
      inFlightForwardKeys.delete(jobKey)
    }
    if (leftover.length > 0) {
      persistForwardJob(chain, leftover, tgToken, Date.now())
      scheduleForwardJob(chain, leftover, tgToken, jobKey)
    }
  })
}

function enqueueCommentWork(queueKey: string, chainId: string, work: () => Promise<void>): void {
  const prev = commentWorkTails.get(queueKey) ?? Promise.resolve()
  const run = (): Promise<void> => chainWorkContext.run({ chainId }, work)
  const next = prev.then(run, run)
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
    void sendAdminAlert(
      'max_bot_missing',
      'MAX-бот не инициализирован — перенос комментариев остановлен',
    )
    return
  }
  enqueueCommentWork(`${chain.id}:${discussionChatId}`, chain.id, async () => {
    try {
      const result = await handleTgComment(message, chain, bot, discussionChatId)
      if (result === 'retry') {
        const attempts = bumpCommentInboundRetry(
          jobKey,
          'waiting for post mapping',
          (nextAttempts) =>
            nextAttempts >= COMMENT_MAPPING_SLOW_AFTER_ATTEMPTS
              ? COMMENT_MAPPING_SLOW_RETRY_MS
              : COMMENT_MAPPING_RETRY_MS,
        )
        if (shouldLogCommentMappingRetry(attempts)) {
          recordCommentRetry({
            chainId: chain.id,
            title: chainTitle(chain),
            messageId: message.message_id,
            error: 'waiting for post mapping',
            attempts,
          })
        }
        if (attempts >= COMMENT_MAPPING_GIVE_UP_ATTEMPTS) {
          deleteCommentInboundJob(jobKey)
          recordCommentSkip({
            chainId: chain.id,
            title: chainTitle(chain),
            messageId: message.message_id,
            reason: 'пост в MAX так и не появился (нет маппинга)',
          })
        }
        return
      }
      deleteCommentInboundJob(jobKey)
    } catch (err: unknown) {
      const attempts = bumpCommentInboundRetry(jobKey, err)
      recordCommentRetry({
        chainId: chain.id,
        title: chainTitle(chain),
        messageId: message.message_id,
        error: errorText(err),
        attempts,
      })
      if (attempts >= 8) {
        void sendAdminAlert(
          `comment_stuck:${chain.id}`,
          `Перенос комментариев заблокирован: ${attempts} ошибок подряд`,
          {
            chainId: chain.id,
            title: chain.max_title,
            jobKey,
            error: err instanceof Error ? err.message : String(err),
          },
        )
      }
    } finally {
      inFlightCommentKeys.delete(jobKey)
    }
  })
}

function drainDueCommentJobs(): void {
  const chains = new Map(listTgChainsSync().map((c) => [c.id, c]))
  for (const job of listDueCommentInboundJobs()) {
    try {
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
    } catch (err: unknown) {
      logger.error('[tgChain] drain comment job failed — other chains continue', {
        chainId: job.chain_id,
        jobKey: job.job_key,
        err,
      })
    }
  }
}

function drainDueForwardJobs(): void {
  flushReadyAlbums()
  const chains = new Map(listTgChainsSync().map((c) => [c.id, c]))
  for (const job of listDueForwardQueueJobs()) {
    try {
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
      if (albumBuffer.has(job.job_key)) {
        continue
      }
      scheduleForwardJob(chain, messages, job.tg_token, job.job_key)
    } catch (err: unknown) {
      logger.error('[tgChain] drain forward job failed — other chains continue', {
        chainId: job.chain_id,
        jobKey: job.job_key,
        err,
      })
    }
  }
}

async function downloadTgFileBuffer(
  url: string,
  timeoutMs: number = MEDIA_DOWNLOAD_TIMEOUT_MS,
): Promise<Buffer> {
  const chainId = chainWorkContext.getStore()?.chainId
  const chainLimit = limitForChain(chainMediaLimits, CHAIN_MEDIA_DOWNLOAD_CONCURRENCY, chainId)
  return globalMediaDownloadLimit(async () => {
    const download = async (): Promise<Buffer> => {
      const res = await telegramAxios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        maxContentLength: MEDIA_MAX_BYTES,
        maxBodyLength: MEDIA_MAX_BYTES,
      })
      const buf = Buffer.from(res.data)
      await new Promise<void>((resolve) => setImmediate(resolve))
      return buf
    }
    return chainLimit ? chainLimit(download) : download()
  })
}

function compactUnknown(value: unknown, maxLen = 240): string {
  try {
    const text = JSON.stringify(value)
    if (!text) return String(value)
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text
  } catch {
    return String(value)
  }
}

function tokenFromUploadUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    for (const key of ['token', 'tk', 'upload_token']) {
      const value = parsed.searchParams.get(key)?.trim()
      if (value) return value
    }
  } catch {
    /* ignore */
  }
  return null
}

function tokenFromUnknown(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.token === 'string' && record.token.trim()) return record.token.trim()
  if (record.photos && typeof record.photos === 'object') {
    const entries = Object.values(record.photos as Record<string, unknown>)
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const token = tokenFromUnknown(entries[i])
      if (token) return token
    }
  }
  if (record.payload && typeof record.payload === 'object') {
    return tokenFromUnknown(record.payload)
  }
  return null
}

function guessImageUploadMeta(
  url: string,
  buffer: Buffer,
): { filename: string; contentType: string } {
  const magic = buffer.subarray(0, 12)
  if (magic.length >= 3 && magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46) {
    return { filename: 'photo.gif', contentType: 'image/gif' }
  }
  if (magic.length >= 8 && magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47) {
    return { filename: 'photo.png', contentType: 'image/png' }
  }
  if (
    magic.length >= 12 &&
    magic[0] === 0x52 &&
    magic[1] === 0x49 &&
    magic[2] === 0x46 &&
    magic[3] === 0x46 &&
    magic[8] === 0x57 &&
    magic[9] === 0x45 &&
    magic[10] === 0x42 &&
    magic[11] === 0x50
  ) {
    return { filename: 'photo.webp', contentType: 'image/webp' }
  }
  const fromPath = url.split('/').pop()?.split('?')[0]
  if (fromPath && /\.(jpe?g|png|gif|webp|heic|bmp|tiff?)$/i.test(fromPath)) {
    const ext = fromPath.slice(fromPath.lastIndexOf('.') + 1).toLowerCase()
    const contentType =
      ext === 'png'
        ? 'image/png'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'webp'
            ? 'image/webp'
            : ext === 'heic'
              ? 'image/heic'
              : ext === 'bmp'
                ? 'image/bmp'
                : ext.startsWith('tif')
                  ? 'image/tiff'
                  : 'image/jpeg'
    return { filename: fromPath, contentType }
  }
  return { filename: 'photo.jpg', contentType: 'image/jpeg' }
}

/**
 * Upload a TG photo buffer to MAX with a real image filename.
 * The official SDK names Buffer uploads with a UUID (no extension), and MAX
 * then returns `File extension is forbidden` without throwing — albums became empty.
 */
async function uploadImageBufferToMax(bot: Bot, buffer: Buffer, url: string): Promise<string> {
  const { filename, contentType } = guessImageUploadMeta(url, buffer)
  return maxApi(async () => {
    const slot = await bot.api.raw.uploads.getUploadUrl({ type: 'image' })
    const form = new FormData()
    form.append('data', buffer, { filename, contentType })
    const uploaded = await axios.post<unknown>(slot.url, form, {
      headers: form.getHeaders(),
      timeout: MEDIA_DOWNLOAD_TIMEOUT_MS,
      maxContentLength: MEDIA_MAX_BYTES,
      maxBodyLength: MEDIA_MAX_BYTES,
    })
    const token =
      tokenFromUnknown(uploaded.data) ??
      (typeof slot.token === 'string' && slot.token.trim() ? slot.token.trim() : null) ??
      tokenFromUploadUrl(slot.url)
    if (token) return token
    throw new Error(`MAX image upload: no token (${compactUnknown(uploaded.data)})`)
  })
}

function scheduleCommentAttach(
  bot: Bot,
  chain: TgChainRecord,
  maxMid: string,
  caption: string,
): void {
  void attachAndVerifyCommentsForForwardedPost(bot, chain.max_chat_id, maxMid, {
    chainId: chain.id,
    knownCaption: caption,
  }).catch((err: unknown) => {
    logger.warn('[tgChain] background comment attach failed', {
      chainId: chain.id,
      maxMid,
      err,
    })
  })
}

/** Время последней активности long-poll / пересылки по chain_id. */
const chainLastActivity = new Map<string, number>()
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

  if (maxMid && maxMid !== TG_FORWARD_SKIPPED_MID) {
    nudgeCommentInboundJobs(chainId)
  }

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
    if (entry.flushAt > now) continue
    const onlyOneFrame = entry.messages.length === 1 && Boolean(entry.messages[0]?.media_group_id)
    if (onlyOneFrame && !entry.singleFrameWaitUsed) {
      entry.singleFrameWaitUsed = true
      entry.flushAt = now + TG_ALBUM_SINGLE_FRAME_EXTRA_MS
      persistForwardJob(entry.chain, entry.messages, entry.tgToken, entry.flushAt)
      continue
    }
    ready.push(entry)
    albumBuffer.delete(key)
  }
  ready.sort((a, b) => a.messages[0]!.message_id - b.messages[0]!.message_id)
  return ready
}

function albumExpectedMediaCount(messages: TgMessage[]): number {
  return messages.filter(
    (m) => Boolean(m.photo?.length) || Boolean(m.video?.file_id) || Boolean(m.document?.file_id),
  ).length
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
    const image = await uploadTgPhotoAttachment(bot, tgToken, largest.file_id)
    if (image) {
      await throttleMaxChatSend(chatId)
      const sent = await maxApi(() =>
        bot.api.sendMessageToChat(chatId, messageText, {
          attachments: [image],
        }),
      )
      return sent.body?.mid ?? null
    }
    logger.warn('[tgChain] photo forward skipped: upload failed', { messageId: msg.message_id })
  }
  if (msg.video?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.video.file_id)
    if (url) {
      try {
        const videoBuf = await downloadTgFileBuffer(url)
        const video = await maxApi(() => bot.api.uploadVideo({ source: videoBuf }))
        await throttleMaxChatSend(chatId)
        const sent = await maxApi(() =>
          bot.api.sendMessageToChat(chatId, messageText, {
            attachments: [video.toJson() as AttachmentRequest],
          }),
        )
        return sent.body?.mid ?? null
      } catch (err: unknown) {
        logger.warn('[tgChain] video upload failed — sending caption if any', {
          messageId: msg.message_id,
          err,
        })
      }
    }
  }
  if (msg.document?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.document.file_id)
    if (url) {
      try {
        const fileBuf = await downloadTgFileBuffer(url)
        const file = await maxApi(() => bot.api.uploadFile({ source: fileBuf }))
        await throttleMaxChatSend(chatId)
        const sent = await maxApi(() =>
          bot.api.sendMessageToChat(chatId, messageText, {
            attachments: [file.toJson() as AttachmentRequest],
          }),
        )
        return sent.body?.mid ?? null
      } catch (err: unknown) {
        logger.warn('[tgChain] document upload failed — sending caption if any', {
          messageId: msg.message_id,
          err,
        })
      }
    }
  }
  // Text-only posts, or media upload failed: still publish caption so the queue does not stall.
  // (Previously `!hasMedia` blocked caption after video/doc failure — log said "sending caption" but returned null.)
  if (caption.trim()) {
    await throttleMaxChatSend(chatId)
    const sent = await maxApi(() => bot.api.sendMessageToChat(chatId, caption.trim()))
    return sent.body?.mid ?? null
  }
  if (hasMedia) {
    logger.warn('[tgChain] media forward failed and caption empty — nothing to publish', {
      messageId: msg.message_id,
      hasPhoto: Boolean(msg.photo?.length),
      hasVideo: Boolean(msg.video?.file_id),
      hasDocument: Boolean(msg.document?.file_id),
    })
  }
  return null
}

/** Загружает одно TG-фото в MAX и возвращает token-based вложение для альбома. */
async function uploadTgPhotoAttachment(
  bot: Bot,
  tgToken: string,
  fileId: string,
  opts?: { requireToken?: boolean },
): Promise<ImageAttachmentRequest | null> {
  const requireToken = opts?.requireToken === true
  let lastErr: unknown
  let lastUrl: string | null = null
  for (let attempt = 1; attempt <= PHOTO_UPLOAD_ATTEMPTS; attempt += 1) {
    const url = await getTgFileUrl(tgToken, fileId)
    if (!url) {
      lastErr = new Error('no TG file url')
      logger.warn('[tgChain] photo: no TG file url', {
        fileIdSuffix: fileId.slice(-8),
        attempt,
      })
      if (attempt < PHOTO_UPLOAD_ATTEMPTS) {
        await sleep(400 * attempt)
      }
      continue
    }
    lastUrl = url
    try {
      const fileBuf = await downloadTgFileBuffer(url)
      const token = await uploadImageBufferToMax(bot, fileBuf, url)
      return { type: 'image', payload: { token } }
    } catch (err: unknown) {
      lastErr = err
      logger.warn('[tgChain] binary image upload failed', {
        fileIdSuffix: fileId.slice(-8),
        attempt,
        err,
      })
      if (attempt < PHOTO_UPLOAD_ATTEMPTS) {
        await sleep(400 * attempt)
      }
    }
  }
  if (requireToken) {
    throw lastErr instanceof Error ? lastErr : new Error('photo upload failed')
  }
  if (lastUrl) {
    logger.warn('[tgChain] binary image upload failed, fallback to url', {
      fileIdSuffix: fileId.slice(-8),
      err: lastErr,
    })
    return { type: 'image', payload: { url: lastUrl } }
  }
  return null
}

function mergeAlbumImageAttachments(images: ImageAttachmentRequest[]): AttachmentRequest[] {
  const out: AttachmentRequest[] = []
  for (const img of images) {
    const token = tokenFromUnknown(img.payload)
    if (token) {
      out.push({ type: 'image', payload: { token } })
      continue
    }
    if (img.payload?.url) {
      out.push({ type: 'image', payload: { url: img.payload.url } })
    }
  }
  return out
}

/** Загружает все фото альбома для одного поста MAX. URL-fallback запрещён — MAX тогда оставляет одно фото. */
async function buildAlbumImageAttachments(
  bot: Bot,
  photoMessages: TgMessage[],
  tgToken: string,
): Promise<AttachmentRequest[]> {
  const uploaded = await Promise.all(
    photoMessages.map((msg) =>
      albumUploadLimit(async (): Promise<ImageAttachmentRequest> => {
        if (!msg.photo?.length) {
          throw new Error(`album photo missing on message ${msg.message_id}`)
        }
        const largest = msg.photo[msg.photo.length - 1]!
        const att = await uploadTgPhotoAttachment(bot, tgToken, largest.file_id, {
          requireToken: true,
        })
        if (!att) {
          throw new Error(`album photo upload failed (${msg.message_id})`)
        }
        const token = tokenFromUnknown(att.payload)
        if (!token) {
          throw new Error(`album photo has no MAX token (${msg.message_id})`)
        }
        return { type: 'image', payload: { token } }
      }),
    ),
  )
  return mergeAlbumImageAttachments(uploaded)
}

async function uploadAlbumExtraAttachment(
  bot: Bot,
  msg: TgMessage,
  tgToken: string,
): Promise<AttachmentRequest> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= PHOTO_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      if (msg.video?.file_id) {
        const url = await getTgFileUrl(tgToken, msg.video.file_id)
        if (!url) throw new Error(`no TG video url (${msg.message_id})`)
        const videoBuf = await downloadTgFileBuffer(url)
        const video = await maxApi(() => bot.api.uploadVideo({ source: videoBuf }))
        return video.toJson() as AttachmentRequest
      }
      if (msg.document?.file_id) {
        const url = await getTgFileUrl(tgToken, msg.document.file_id)
        if (!url) throw new Error(`no TG document url (${msg.message_id})`)
        const fileBuf = await downloadTgFileBuffer(url)
        const file = await maxApi(() => bot.api.uploadFile({ source: fileBuf }))
        return file.toJson() as AttachmentRequest
      }
      throw new Error(`album extra media missing on message ${msg.message_id}`)
    } catch (err: unknown) {
      lastErr = err
      logger.warn('[tgChain] album extra media upload failed', {
        messageId: msg.message_id,
        attempt,
        err,
      })
      if (attempt < PHOTO_UPLOAD_ATTEMPTS) {
        await sleep(400 * attempt)
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('album extra media upload failed')
}

async function buildAlbumAttachments(
  bot: Bot,
  messages: TgMessage[],
  tgToken: string,
): Promise<AttachmentRequest[]> {
  const photoMessages = messages.filter((m) => m.photo && m.photo.length > 0)
  const extraMedia = messages.filter(
    (m) => !m.photo?.length && (m.video?.file_id || m.document?.file_id),
  )
  const expected = albumExpectedMediaCount(messages)
  const attachments: AttachmentRequest[] = []

  if (photoMessages.length > 0) {
    const imageAtts = await buildAlbumImageAttachments(bot, photoMessages, tgToken)
    attachments.push(...imageAtts)
  }

  if (extraMedia.length > 0) {
    const extraAtts = await Promise.all(
      extraMedia.map((msg) => albumUploadLimit(() => uploadAlbumExtraAttachment(bot, msg, tgToken))),
    )
    attachments.push(...extraAtts)
  }

  if (attachments.length !== expected) {
    throw new Error(
      `MAX album incomplete: uploaded ${attachments.length}/${expected} (${messages.map((m) => m.message_id).join(', ')})`,
    )
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
    const image = await uploadTgPhotoAttachment(bot, tgToken, largest!.file_id)
    return image ? [image] : []
  }
  if (msg.video?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.video.file_id)
    if (!url) return []
    try {
      const videoBuf = await downloadTgFileBuffer(url)
      const video = await maxApi(() => bot.api.uploadVideo({ source: videoBuf }))
      return [video.toJson() as AttachmentRequest]
    } catch (err: unknown) {
      logger.warn('[tgChain] edit/single video skipped', { messageId: msg.message_id, err })
      return []
    }
  }
  if (msg.document?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.document.file_id)
    if (!url) return []
    try {
      const fileBuf = await downloadTgFileBuffer(url)
      const file = await maxApi(() => bot.api.uploadFile({ source: fileBuf }))
      return [file.toJson() as AttachmentRequest]
    } catch (err: unknown) {
      logger.warn('[tgChain] edit/single document skipped', { messageId: msg.message_id, err })
      return []
    }
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
  const expected = albumExpectedMediaCount(messages)

  if (attachments.length === 0 || attachments.length !== expected) {
    throw new Error(
      `MAX album: uploaded ${attachments.length}/${expected} (${messages.map((m) => m.message_id).join(', ')})`,
    )
  }

  await sleep(ALBUM_ATTACH_SETTLE_MS)
  await throttleMaxChatSend(chatId)
  const sent = await maxApi(() =>
    bot.api.sendMessageToChat(chatId, messageText, {
      attachments,
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
      recordTgMaxSkip({
        chainId: chain.id,
        title: chainTitle(chain),
        messageId: m.message_id,
        reason: 'пост старше даты начала переноса',
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
  markChannelForwardBusy(chain.max_chat_id, 45_000)

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
          published += 1
          for (const msg of chunk) {
            markForwarded(chain.id, msg, maxMid, i)
            syncTgMetadataOnForwardedPost(chain.max_chat_id, maxMid, chain, msg)
          }
          if (attachComments) {
            scheduleCommentAttach(bot, chain, maxMid, chunkCaption)
          }
          void publishTelegramPostToVk({
            maxChatId: chain.max_chat_id,
            maxMid,
            tgToken,
            tgMessages: chunk,
          }).catch((err: unknown) => {
            logger.warn('[tgChain] VK publish (album) failed', { chainId: chain.id, maxMid, err })
          })
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
        published = 1
        markForwarded(chain.id, msg, maxMid, null)
        syncTgMetadataOnForwardedPost(chain.max_chat_id, maxMid, chain, msg)
        if (attachComments) {
          scheduleCommentAttach(bot, chain, maxMid, caption)
        }
        void publishTelegramPostToVk({
          maxChatId: chain.max_chat_id,
          maxMid,
          tgToken,
          tgMessages: [msg],
        }).catch((err: unknown) => {
          logger.warn('[tgChain] VK publish (single) failed', { chainId: chain.id, maxMid, err })
        })
      }
    }

    if (published > 0) {
      const forwardedToday = chain.forwarded_today + published
      chain.forwarded_today = forwardedToday
      touchChainActivity(chain.id)
      await updateTgChain(chain.id, { forwarded_today: forwardedToday })
      drainDueCommentJobs()
    }
    const remaining = pending.filter((m) => !isAlreadyForwarded(chain.id, m.message_id))
    const tgDateSec = pending[0]?.date
    const lagMs =
      typeof tgDateSec === 'number' && Number.isFinite(tgDateSec)
        ? Date.now() - tgDateSec * 1000
        : undefined
    if (remaining.length > 0 && published > 0) {
      recordTgMaxPartial({
        chainId: chain.id,
        title: chainTitle(chain),
        messageIds: pending.map((m) => m.message_id),
        published,
        remaining: remaining.length,
      })
    } else if (published > 0) {
      recordTgMaxSuccess({
        chainId: chain.id,
        title: chainTitle(chain),
        messageIds: pending.map((m) => m.message_id),
        published,
        album: isAlbum,
        maxMid: resultMid,
        lagMs,
      })
    }
    return remaining.length === 0
    } catch (err: unknown) {
      const errorsToday = chain.errors_today + 1
      chain.errors_today = errorsToday
      await updateTgChain(chain.id, { errors_today: errorsToday })
      if (axios.isAxiosError(err) && err.response?.status) {
        throw new Error(`HTTP ${err.response.status}: ${errorText(err)}`, { cause: err })
      }
      throw err
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
    const resolved = await Promise.allSettled(
      commentChains.map(async (chain) => {
        const discussionChatId = await resolveDiscussionChatId(tgToken, chain)
        return { chainId: chain.id, discussionChatId }
      }),
    )
    for (const result of resolved) {
      if (result.status === 'fulfilled') {
        discussionChatByChain.set(result.value.chainId, result.value.discussionChatId)
        continue
      }
      logger.warn('[tgChain] resolveDiscussionChatId failed', { err: result.reason })
    }
  }

  await Promise.all(
    group.map(async (chain) => {
      try {
        await dispatchUpdatesForChain(chain, tgToken, {
          channelPosts,
          editedChannelPosts,
          editedMessages,
          discussionMessages,
          discussionChatId: discussionChatByChain.get(chain.id) ?? null,
        })
      } catch (err: unknown) {
        logger.error('[tgChain] dispatch failed for chain — others continue', {
          chainId: chain.id,
          title: chain.max_title,
          err,
        })
        void sendAdminAlert(
          `dispatch:${chain.id}`,
          `Сбой разбора апдейтов связки «${chainTitle(chain)}» — остальные связки продолжают работу`,
          {
            chainId: chain.id,
            title: chain.max_title,
            error: errorText(err),
          },
        )
      }
    }),
  )
}

async function dispatchUpdatesForChain(
  chain: TgChainRecord,
  tgToken: string,
  batch: {
    channelPosts: TgMessage[]
    editedChannelPosts: TgMessage[]
    editedMessages: TgMessage[]
    discussionMessages: TgMessage[]
    discussionChatId: number | null
  },
): Promise<void> {
  const sourceKey = chainSourceKey(chain)
  const forChain = batch.channelPosts.filter((m) => telegramMessageMatchesTgChain(m.chat, chain))
  if (batch.channelPosts.length > 0 && forChain.length === 0) {
    logger.debug('[tgChain] channel_post batch did not match chain', {
      chainId: chain.id,
      sourceKey,
      tg_channel_id: chain.tg_channel_id ?? null,
      tg_username: chain.tg_username ?? null,
      sampleChatId: batch.channelPosts[0]?.chat?.id,
      sampleUsername: batch.channelPosts[0]?.chat?.username ?? null,
    })
  }
  if (forChain.length > 0) {
    const first = forChain[0]
    const tgDateSec = first?.date
    recordTgMaxReceived({
      chainId: chain.id,
      title: chainTitle(chain),
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

  const editedForChain = batch.editedChannelPosts.filter((m) =>
    telegramMessageMatchesTgChain(m.chat, chain),
  )
  for (const edited of editedForChain) {
    enqueueChainWork(chain.id, () => processEditedChainMessage(chain, edited, tgToken))
  }
  const editedMessagesForChain = batch.editedMessages.filter((m) =>
    telegramMessageMatchesTgChain(m.chat, chain),
  )
  for (const edited of editedMessagesForChain) {
    enqueueChainWork(chain.id, () => processEditedChainMessage(chain, edited, tgToken))
  }

  if (!chain.forward_comments || batch.discussionMessages.length === 0) {
    return
  }
  const discussionChatId = batch.discussionChatId
  if (discussionChatId == null) {
    return
  }
  for (const msg of batch.discussionMessages) {
    if (msg.chat.id !== discussionChatId) {
      continue
    }
    if (isDiscussionAutoForward(msg)) {
      handleDiscussionAutoForward(msg, chain.id)
      continue
    }
    if (!msg.reply_to_message && !(typeof msg.message_thread_id === 'number' && msg.message_thread_id > 0)) {
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

async function runTgChainsForToken(tgToken: string, abortSignal?: AbortSignal): Promise<boolean> {
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
      signal: abortSignal,
    })
  } catch (err: unknown) {
    if (err instanceof TelegramGetUpdatesConflictError) {
      invalidateTelegramPollingModeCache(tgToken)
      await sleep(TG_GETUPDATES_CONFLICT_WAIT_MS)
      return receivedAny
    }
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      invalidateTelegramPollingModeCache(tgToken)
      logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 2.5s')
      await sleep(TG_GETUPDATES_CONFLICT_WAIT_MS)
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
  try {
    await dispatchChannelUpdatesToChains(tgToken, batch)
  } catch (err: unknown) {
    logger.error('[tgChain] dispatch batch failed — offset still advances, next tick continues', {
      tokenHint: tgToken.slice(-6),
      err,
    })
  }

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
  const pollAbort = new AbortController()
  setTelegramGetUpdatesOwner(tgToken, true)
  tokenLastPollAt.set(tgToken, Date.now())
  void ensureTelegramPollingMode(tgToken)
  for (const chain of listActiveForwardChains()) {
    if (resolveTgToken(chain) === tgToken) {
      touchChainActivity(chain.id)
    }
  }
  const loop = async () => {
    while (!stopped) {
      try {
        const hadUpdates = await runTgChainsForToken(tgToken, pollAbort.signal)
        tokenLastPollAt.set(tgToken, Date.now())
        if (stopped) {
          break
        }
        if (!hadUpdates) {
          const albumDelayMs = getAlbumBufferDelayMs(Date.now(), tgToken)
          if (albumDelayMs === null) {
            await sleep(TG_CHAIN_IDLE_MS)
          } else {
            await sleep(Math.min(TG_CHAIN_IDLE_MS, Math.max(15, albumDelayMs)))
          }
        }
      } catch (err: unknown) {
        tokenLastPollAt.set(tgToken, Date.now())
        if (stopped || pollAbort.signal.aborted) {
          break
        }
        if (err instanceof TelegramGetUpdatesConflictError) {
          invalidateTelegramPollingModeCache(tgToken)
          logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 2.5s')
          await sleep(TG_GETUPDATES_CONFLICT_WAIT_MS)
          continue
        }
        if (axios.isAxiosError(err) && err.response?.status === 409) {
          invalidateTelegramPollingModeCache(tgToken)
          logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 2.5s')
          await sleep(TG_GETUPDATES_CONFLICT_WAIT_MS)
          continue
        }
        if (isTelegramGetUpdatesTimeoutError(err)) {
          logger.debug('[tgChain] getUpdates idle timeout, retrying', {
            tokenHint: tgToken.slice(-6),
          })
          continue
        }
        logger.error('[tgChain] loop error', { err, tokenHint: tgToken.slice(-6) })
        await sendAdminAlert(
          'forwarder_crash',
          'Форвардер получил ошибку и продолжает опрос — перенос не остановлен',
          {
            error: String(err),
          },
        )
        await sleep(1_000)
      }
    }
  }
  void loop()
  return {
    stop: () => {
      stopped = true
      pollAbort.abort()
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
      maybeLogForwardQueueHealth()
    }
  }, TG_QUEUE_DRAIN_MS)
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
      const staleTokens: string[] = []
      for (const token of tokenLoops.keys()) {
        const lastPoll = tokenLastPollAt.get(token)
        if (lastPoll == null) {
          continue
        }
        if (now - lastPoll > TOKEN_POLL_STALE_MS) {
          staleTokens.push(token)
        }
      }
      for (const token of staleTokens) {
        const silentMs = now - (tokenLastPollAt.get(token) ?? now)
        logger.warn('[tgChain] watchdog: token poll stale, restarting this token only', {
          tokenHint: token.slice(-6),
          silentMs,
        })
        await sendAdminAlert(
          `token_poll_stale:${token.slice(-8)}`,
          'Опрос Telegram завис — перезапускаю только этот токен, остальные связки не трогаю',
          { tokenHint: token.slice(-6), silentMs },
        )
        await restartTokenPollLoop(token)
      }
    })().catch((err: unknown) => {
      logger.warn('[tgChain] watchdog error', { err })
    })
  }, 30 * 1000)
}

export function getTgChainForwarderRuntime(): {
  poll_loops: number
  in_flight_forwards: number
  in_flight_comments: number
  album_buffer: number
  channel_work_queues: number
  chain_work_queues: number
  comment_work_queues: number
  last_activity: Record<string, number>
} {
  const last_activity: Record<string, number> = {}
  for (const [chainId, ts] of chainLastActivity) {
    last_activity[chainId] = ts
  }
  return {
    poll_loops: tokenLoops.size,
    in_flight_forwards: inFlightForwardKeys.size,
    in_flight_comments: inFlightCommentKeys.size,
    album_buffer: albumBuffer.size,
    channel_work_queues: chainWorkTails.size,
    chain_work_queues: chainWorkTails.size,
    comment_work_queues: commentWorkTails.size,
    last_activity,
  }
}

let lastQueueHealthLogAt = 0
let lastQueueNonEmpty = false

function maybeLogForwardQueueHealth(): void {
  const now = Date.now()
  if (now - lastQueueHealthLogAt < 30_000) {
    return
  }
  const postCount = countForwardQueueJobs()
  const commentCount = countCommentInboundJobs()
  const queueEmpty = postCount === 0 && commentCount === 0
  if (queueEmpty && !lastQueueNonEmpty) {
    return
  }
  lastQueueHealthLogAt = now
  lastQueueNonEmpty = !queueEmpty
  const postSummary = [...summarizeForwardQueueByChain().values()]
  const commentSummary = [...summarizeCommentQueueByChain().values()]
  const oldestCreated = [...postSummary, ...commentSummary]
    .map((s) => s.oldestCreatedAt)
    .filter((n): n is number => n != null && n > 0)
  const oldestWaitMs = oldestCreated.length > 0 ? now - Math.min(...oldestCreated) : null
  const stuck =
    postSummary.filter((s) => s.maxAttempts >= 6).reduce((n, s) => n + s.count, 0) +
    commentSummary.filter((s) => s.maxAttempts >= 8).reduce((n, s) => n + s.count, 0)
  recordQueueSnapshot({
    posts: postCount,
    comments: commentCount,
    oldestWaitMs,
    stuck,
  })
}

export function startTgChainForwarder(): void {
  if (loopStarted) return
  loopStarted = true
  startTgChainWatchdog()
  logger.info('[tgChain] forwarder started (per-chain workers, per-token long-poll)')
  startForwarderLoop()
}
