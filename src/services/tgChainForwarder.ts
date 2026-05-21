import { createHash } from 'node:crypto'

import axios from 'axios'
import type { Bot } from '@maxhub/max-bot-api'
import type { AttachmentRequest, ImageAttachmentRequest } from '@maxhub/max-bot-api/types'

import { getTelegramToken } from '../config'
import { getDb } from '../db/database'
import {
  type TgChannelUpdate,
  TelegramGetUpdatesConflictError,
  getTgFileUrl,
  getTelegramUpdatesWithIds,
  type TgMessage,
} from '../forwarder/telegramReader'
import { listTgChains, updateTgChain, type TgChainRecord } from '../api/adminPanelState'
import { assertTelegramPollingReady } from './channelImportService'
import { attachAndVerifyCommentsForForwardedPost } from './channelPostPublishGate'
import { postStore } from './postStore'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { telegramChannelMatchesTarget } from '../utils/tgChannelMatch'
import { logger } from '../utils/logger'
import { apiCallWithRetry } from '../utils/maxApiRetry'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Long-poll Telegram for new channel_post (сек). */
const TG_CHAIN_LONG_POLL_SEC = 25
const TG_CHAIN_IDLE_MS = 3_000
/** MIN gap between `sendMessageToChat` to the same MAX channel (API 429). */
const MAX_SEND_INTERVAL_MS = 2_500
const UPLOAD_STAGGER_MS = 450
const TG_CHAIN_MAX_API_RETRIES = 6
/** Буферизация Telegram-альбомов по media_group_id. */
const TG_ALBUM_BUFFER_MS = 900
/** Telegram media group ограничен 10 элементами. */
const TG_ALBUM_MAX_MEDIA_PER_POST = 10

const lastMaxSendAt = new Map<number, number>()
type BufferedAlbum = {
  chain: TgChainRecord
  tgToken: string
  messages: TgMessage[]
  flushAt: number
}
const albumBuffer = new Map<string, BufferedAlbum>()

async function throttleMaxChatSend(chatId: number): Promise<void> {
  const now = Date.now()
  const last = lastMaxSendAt.get(chatId) ?? 0
  const wait = MAX_SEND_INTERVAL_MS - (now - last)
  if (wait > 0) {
    await sleep(wait)
  }
  lastMaxSendAt.set(chatId, Date.now())
}

function maxApi<T>(fn: () => Promise<T>): Promise<T> {
  return apiCallWithRetry(fn, TG_CHAIN_MAX_API_RETRIES)
}

let botRef: Bot | null = null

export function setTgChainForwarderBot(bot: Bot): void {
  botRef = bot
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

function getReaderOffset(tgToken: string): number {
  const row = getDb()
    .prepare('SELECT scan_next_offset FROM tg_chain_reader_offsets WHERE token_key = ?')
    .get(tokenKey(tgToken)) as { scan_next_offset: number } | undefined
  return row?.scan_next_offset ?? 0
}

function setReaderOffset(tgToken: string, offset: number): void {
  getDb()
    .prepare(
      `INSERT INTO tg_chain_reader_offsets (token_key, scan_next_offset) VALUES (?, ?)
       ON CONFLICT(token_key) DO UPDATE SET scan_next_offset = excluded.scan_next_offset`,
    )
    .run(tokenKey(tgToken), offset)
}

function chainSourceKey(chain: TgChainRecord): string {
  if (chain.tg_channel_id && chain.tg_channel_id.trim() !== '') {
    return chain.tg_channel_id.trim()
  }
  const u = chain.tg_username.trim().replace(/^@/, '')
  return u ? `@${u}` : ''
}

function isAlreadyForwarded(chainId: string, messageId: number): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM tg_chain_forwarded WHERE chain_id = ? AND tg_message_id = ?')
    .get(chainId, messageId)
  return !!row
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
}

function resolveTgToken(chain: TgChainRecord): string {
  const fromChain = chain.bot_token?.trim()
  if (fromChain) return fromChain
  return (process.env.TG_READER_BOT_TOKEN || '').trim() || getTelegramToken()
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
    return
  }
  albumBuffer.set(key, {
    chain,
    tgToken,
    messages: [msg],
    flushAt: now + TG_ALBUM_BUFFER_MS,
  })
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

function takeReadyAlbumEntries(now: number = Date.now()): BufferedAlbum[] {
  const ready: BufferedAlbum[] = []
  for (const [key, entry] of albumBuffer.entries()) {
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

  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]
    const url = await getTgFileUrl(tgToken, largest.file_id)
    if (url) {
      const image = await maxApi(() => bot.api.uploadImage({ url }))
      await throttleMaxChatSend(chatId)
      const sent = await maxApi(() =>
        bot.api.sendMessageToChat(chatId, messageText, {
          attachments: [image.toJson() as AttachmentRequest],
        }),
      )
      return sent.body?.mid ?? null
    }
  }
  if (msg.video?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.video.file_id)
    if (url) {
      const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
      const video = await maxApi(() => bot.api.uploadVideo({ source: Buffer.from(res.data) }))
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
      const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
      const file = await maxApi(() => bot.api.uploadFile({ source: Buffer.from(res.data) }))
      await throttleMaxChatSend(chatId)
      const sent = await maxApi(() =>
        bot.api.sendMessageToChat(chatId, messageText, {
          attachments: [file.toJson() as AttachmentRequest],
        }),
      )
      return sent.body?.mid ?? null
    }
  }
  if (caption.trim()) {
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
    const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
    uploaded = await maxApi(() => bot.api.uploadImage({ source: Buffer.from(res.data) }))
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

/**
 * Собирает вложения альбома: при нескольких token — один image с `photos`,
 * при url (типично для uploadImage({ url })) — отдельные image-вложения.
 */
function mergeAlbumImageAttachments(images: ImageAttachmentRequest[]): AttachmentRequest[] {
  if (images.length === 0) return []
  if (images.length === 1) return [images[0]!]

  const photosMap: NonNullable<ImageAttachmentRequest['payload']['photos']> = {}
  let tokenCount = 0
  let hasUrlOnly = false

  for (const img of images) {
    const p = img.payload
    if (p?.token) {
      photosMap[String(tokenCount)] = { token: p.token }
      tokenCount++
    } else if (p?.url) {
      hasUrlOnly = true
    } else if (p?.photos) {
      for (const entry of Object.values(p.photos)) {
        if (entry?.token) {
          photosMap[String(tokenCount)] = { token: entry.token }
          tokenCount++
        }
      }
    }
  }

  if (tokenCount > 1 && !hasUrlOnly) {
    return [{ type: 'image', payload: { photos: photosMap } }]
  }
  if (tokenCount === 1 && !hasUrlOnly) {
    return [{ type: 'image', payload: { token: photosMap['0']!.token } }]
  }
  return images
}

/** Загружает все фото альбома для одного поста MAX. */
async function buildAlbumImageAttachments(
  bot: Bot,
  photoMessages: TgMessage[],
  tgToken: string,
): Promise<AttachmentRequest[]> {
  const uploaded: ImageAttachmentRequest[] = []

  for (let i = 0; i < photoMessages.length; i += 1) {
    const msg = photoMessages[i]!
    if (!msg.photo?.length) continue
    const largest = msg.photo[msg.photo.length - 1]!
    const att = await uploadTgPhotoAttachment(bot, tgToken, largest.file_id)
    if (att) {
      uploaded.push(att)
    }
    if (i < photoMessages.length - 1) {
      await sleep(UPLOAD_STAGGER_MS)
    }
  }

  return mergeAlbumImageAttachments(uploaded)
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

  for (const msg of messages) {
    if (msg.photo?.length) continue
    if (msg.video?.file_id) {
      const url = await getTgFileUrl(tgToken, msg.video.file_id)
      if (url) {
        const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
        const video = await maxApi(() => bot.api.uploadVideo({ source: Buffer.from(res.data) }))
        attachments.push(video.toJson() as AttachmentRequest)
        await sleep(UPLOAD_STAGGER_MS)
      }
    } else if (msg.document?.file_id) {
      const url = await getTgFileUrl(tgToken, msg.document.file_id)
      if (url) {
        const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
        const file = await maxApi(() => bot.api.uploadFile({ source: Buffer.from(res.data) }))
        attachments.push(file.toJson() as AttachmentRequest)
        await sleep(UPLOAD_STAGGER_MS)
      }
    }
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
    const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
    const video = await maxApi(() => bot.api.uploadVideo({ source: Buffer.from(res.data) }))
    return [video.toJson() as AttachmentRequest]
  }
  if (msg.document?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.document.file_id)
    if (!url) return []
    const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
    const file = await maxApi(() => bot.api.uploadFile({ source: Buffer.from(res.data) }))
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
  const sourceKey = chainSourceKey(chain)
  if (!telegramChannelMatchesTarget(msg.chat, sourceKey)) return
  const mapping = getForwardedRecord(chain.id, msg.message_id)
  if (!mapping?.max_message_mid) {
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
    const maxMid = mapping.max_message_mid
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
): Promise<void> {
  const sourceKey = chainSourceKey(chain)
  const pending = messages.filter(
    (m) =>
      telegramChannelMatchesTarget(m.chat, sourceKey) && !isAlreadyForwarded(chain.id, m.message_id),
  )
  if (pending.length === 0) {
    return
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
            })
          }
          if (keepPublished) {
            published += 1
            for (const msg of chunk) {
              markForwarded(chain.id, msg, maxMid, i)
            }
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
          })
        }
        if (keepPublished) {
          published = 1
          markForwarded(chain.id, msg, maxMid, null)
        } else {
          logger.warn('[tgChain] post not marked forwarded — comment gate rollback, TG retry later', {
            chainId: chain.id,
            maxMessageMid: resultMid,
            tgMessageId: msg.message_id,
          })
        }
      }
    }

    // Если публикация не удалась, всё равно сохраняем payload по TG id:
    // это позволит позже корректно обработать edited_channel_post.
    for (const msg of pending) {
      const existing = getForwardedRecord(chain.id, msg.message_id)
      if (!existing) {
        markForwarded(chain.id, msg, null, null)
      }
    }

    if (published > 0) {
      const forwardedToday = chain.forwarded_today + published
      chain.forwarded_today = forwardedToday
      await updateTgChain(chain.id, { forwarded_today: forwardedToday })
      logger.info('[tgChain] forwarded', {
        chainId: chain.id,
        from: sourceKey,
        to: chain.max_chat_id,
        published,
        album: isAlbum,
        maxMessageMid: resultMid,
        photoCount: isAlbum ? pending.filter((m) => m.photo?.length).length : undefined,
        messageIds: pending.map((m) => m.message_id),
      })
    }

    await sleep(1_500 + Math.random() * 500)
  } catch (err: unknown) {
    const axiosDetail =
      axios.isAxiosError(err) && err.response
        ? { status: err.response.status, data: err.response.data }
        : undefined
    logger.error('[tgChain] forward failed', {
      chainId: chain.id,
      from: sourceKey,
      to: chain.max_chat_id,
      messageIds: pending.map((m) => m.message_id),
      err,
      axiosDetail,
    })
    const errorsToday = chain.errors_today + 1
    chain.errors_today = errorsToday
    await updateTgChain(chain.id, { errors_today: errorsToday })
  }
}

async function flushReadyAlbums(): Promise<boolean> {
  const ready = takeReadyAlbumEntries()
  if (ready.length === 0) return false
  for (const entry of ready) {
    await processChainMessageGroup(entry.chain, entry.messages, entry.tgToken)
  }
  return true
}

export async function runTgChainsOnce(): Promise<boolean> {
  // Сначала освобождаем альбомы, чей таймер буфера уже истёк.
  let receivedAny = await flushReadyAlbums()
  if (!botRef) {
    logger.warn('[tgChain] MAX bot not set — skip tick')
    return receivedAny
  }

  const chains = (await listTgChains()).filter(
    (c) => c.active && c.forward_posts && chainSourceKey(c) !== '',
  )
  if (chains.length === 0) {
    return receivedAny
  }

  const tokenByChain = new Map<string, string>()
  for (const chain of chains) {
    const t = resolveTgToken(chain)
    if (!t) {
      logger.warn('[tgChain] no TG token for chain', { chainId: chain.id })
      continue
    }
    tokenByChain.set(chain.id, t)
  }

  const tokenGroups = new Map<string, TgChainRecord[]>()
  for (const chain of chains) {
    const token = tokenByChain.get(chain.id)
    if (!token) continue
    const list = tokenGroups.get(token) ?? []
    list.push(chain)
    tokenGroups.set(token, list)
  }

  for (const [tgToken, group] of tokenGroups) {
    const pollErr = await assertTelegramPollingReady(tgToken)
    if (pollErr) {
      logger.warn('[tgChain] telegram polling not ready', { err: pollErr })
      continue
    }

    const offset = getReaderOffset(tgToken)
    let batch: TgChannelUpdate[]
    try {
      // При ожидающемся flush альбома не блокируемся длинным long-poll.
      const pendingAlbumDelayMs = getAlbumBufferDelayMs(Date.now(), tgToken)
      const timeoutSec =
        pendingAlbumDelayMs === null
          ? TG_CHAIN_LONG_POLL_SEC
          : Math.max(0, Math.min(TG_CHAIN_LONG_POLL_SEC, Math.ceil(pendingAlbumDelayMs / 1000)))
      batch = await getTelegramUpdatesWithIds(tgToken, offset, timeoutSec)
    } catch (err: unknown) {
      if (err instanceof TelegramGetUpdatesConflictError) {
        await sleep(10_000)
        continue
      }
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s')
        await sleep(10_000)
        continue
      }
      throw err
    }
    let nextOffset = offset

    const channelPosts: TgMessage[] = []
    const editedChannelPosts: TgMessage[] = []
    const editedMessages: TgMessage[] = []
    for (const u of batch) {
      receivedAny = true
      nextOffset = Math.max(nextOffset, u.update_id + 1)
      if (u.channel_post) {
        channelPosts.push(u.channel_post)
      }
      if (u.edited_channel_post) {
        editedChannelPosts.push(u.edited_channel_post)
      }
      if (u.edited_message) {
        editedMessages.push(u.edited_message)
      }
    }

    for (const chain of group) {
      const sourceKey = chainSourceKey(chain)
      const forChain = channelPosts.filter((m) => telegramChannelMatchesTarget(m.chat, sourceKey))
      const chainGroups = groupChannelPostsForForward(forChain)
      for (const msgs of chainGroups) {
        const isMediaGroup = msgs.length > 1 || Boolean(msgs[0]?.media_group_id)
        if (isMediaGroup) {
          for (const msg of msgs) {
            queueAlbumMessage(chain, tgToken, msg)
          }
          continue
        }
        await processChainMessageGroup(chain, msgs, tgToken)
      }

      const editedForChain = editedChannelPosts.filter((m) =>
        telegramChannelMatchesTarget(m.chat, sourceKey),
      )
      for (const edited of editedForChain) {
        await processEditedChainMessage(chain, edited, tgToken)
      }
      const editedMessagesForChain = editedMessages.filter((m) =>
        telegramChannelMatchesTarget(m.chat, sourceKey),
      )
      for (const edited of editedMessagesForChain) {
        await processEditedChainMessage(chain, edited, tgToken)
      }
    }

    if (nextOffset > offset) {
      setReaderOffset(tgToken, nextOffset)
    }
  }

  if (await flushReadyAlbums()) {
    receivedAny = true
  }

  return receivedAny
}

let loopStarted = false

export function startTgChainForwarder(): void {
  if (loopStarted) return
  loopStarted = true
  logger.info('[tgChain] forwarder started (long-poll channel_post)')
  const loop = async () => {
    while (true) {
      try {
        const hadUpdates = await runTgChainsOnce()
        if (!hadUpdates) {
          const albumDelayMs = getAlbumBufferDelayMs()
          if (albumDelayMs === null) {
            await sleep(TG_CHAIN_IDLE_MS)
          } else {
            // Не спим дольше, чем осталось до ближайшего flush альбома.
            await sleep(Math.min(TG_CHAIN_IDLE_MS, Math.max(50, albumDelayMs)))
          }
        }
      } catch (err: unknown) {
        if (err instanceof TelegramGetUpdatesConflictError) {
          logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s')
          await sleep(10_000)
          continue
        }
        if (axios.isAxiosError(err) && err.response?.status === 409) {
          logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s')
          await sleep(10_000)
          continue
        }
        logger.error('[tgChain] loop error', err)
        await sleep(TG_CHAIN_IDLE_MS)
      }
    }
  }
  void loop()
}
