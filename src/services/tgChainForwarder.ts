import { createHash } from 'node:crypto'

import axios from 'axios'
import type { Bot } from '@maxhub/max-bot-api'
import type { AttachmentRequest, ImageAttachmentRequest } from '@maxhub/max-bot-api/types'

import { getTelegramToken } from '../config'
import { getDb } from '../db/database'
import { getTgFileUrl, getTelegramUpdatesWithIds, type TgMessage } from '../forwarder/telegramReader'
import { listTgChains, updateTgChain, type TgChainRecord } from '../api/adminPanelState'
import { assertTelegramPollingReady } from './channelImportService'
import { ensurePostFromChannelMessage } from './channelPostActions'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { telegramChannelMatchesTarget } from '../utils/tgChannelMatch'
import { logger } from '../utils/logger'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Long-poll Telegram for new channel_post (сек). */
const TG_CHAIN_LONG_POLL_SEC = 25
const TG_CHAIN_IDLE_MS = 3_000

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

function markForwarded(chainId: string, messageId: number): void {
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO tg_chain_forwarded (chain_id, tg_message_id) VALUES (?, ?)',
    )
    .run(chainId, messageId)
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
      const image = await bot.api.uploadImage({ url })
      const sent = await bot.api.sendMessageToChat(chatId, messageText, {
        attachments: [image.toJson() as AttachmentRequest],
      })
      return sent.body?.mid ?? null
    }
  }
  if (msg.video?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.video.file_id)
    if (url) {
      const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
      const video = await bot.api.uploadVideo({ source: Buffer.from(res.data) })
      const sent = await bot.api.sendMessageToChat(chatId, messageText, {
        attachments: [video.toJson() as AttachmentRequest],
      })
      return sent.body?.mid ?? null
    }
  }
  if (msg.document?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.document.file_id)
    if (url) {
      const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
      const file = await bot.api.uploadFile({ source: Buffer.from(res.data) })
      const sent = await bot.api.sendMessageToChat(chatId, messageText, {
        attachments: [file.toJson() as AttachmentRequest],
      })
      return sent.body?.mid ?? null
    }
  }
  if (caption.trim()) {
    const sent = await bot.api.sendMessageToChat(chatId, caption.trim())
    return sent.body?.mid ?? null
  }
  return null
}

/** Загружает все фото альбома и собирает одно image-вложение (несколько photos в одном посте MAX). */
async function buildAlbumImageAttachment(
  bot: Bot,
  photoMessages: TgMessage[],
  tgToken: string,
): Promise<AttachmentRequest | null> {
  const photosMap: NonNullable<ImageAttachmentRequest['payload']['photos']> = {}
  let index = 0

  for (const msg of photoMessages) {
    if (!msg.photo?.length) continue
    const largest = msg.photo[msg.photo.length - 1]
    const url = await getTgFileUrl(tgToken, largest.file_id)
    if (!url) continue
    const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
    const uploaded = await bot.api.uploadImage({ source: Buffer.from(res.data) })
    const json = uploaded.toJson() as ImageAttachmentRequest
    const token = json.payload?.token
    if (token) {
      photosMap[String(index)] = { token }
      index++
    }
  }

  if (index === 0) return null
  if (index === 1) {
    return { type: 'image', payload: { token: photosMap['0']!.token } }
  }
  return { type: 'image', payload: { photos: photosMap } }
}

/** Альбом TG → один пост MAX (все фото в одном сообщении, как в Telegram). */
async function forwardAlbumToMax(
  bot: Bot,
  messages: TgMessage[],
  tgToken: string,
  maxChatId: number,
  addSignature: boolean,
): Promise<string | null> {
  const chatId = resolveCanonicalChannelChatId(maxChatId) ?? maxChatId
  const caption = pickAlbumCaption(messages, addSignature)
  const messageText = caption.trim() || '\u00a0'

  const photoMessages = messages.filter((m) => m.photo && m.photo.length > 0)
  const attachments: AttachmentRequest[] = []

  const imageAtt = await buildAlbumImageAttachment(bot, photoMessages, tgToken)
  if (imageAtt) {
    attachments.push(imageAtt)
  }

  for (const msg of messages) {
    if (msg.photo?.length) continue
    if (msg.video?.file_id) {
      const url = await getTgFileUrl(tgToken, msg.video.file_id)
      if (url) {
        const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
        const video = await bot.api.uploadVideo({ source: Buffer.from(res.data) })
        attachments.push(video.toJson() as AttachmentRequest)
      }
    } else if (msg.document?.file_id) {
      const url = await getTgFileUrl(tgToken, msg.document.file_id)
      if (url) {
        const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
        const file = await bot.api.uploadFile({ source: Buffer.from(res.data) })
        attachments.push(file.toJson() as AttachmentRequest)
      }
    }
  }

  if (attachments.length === 0 && !caption.trim()) {
    return null
  }

  const sent = await bot.api.sendMessageToChat(chatId, messageText, {
    attachments: attachments.length > 0 ? attachments : undefined,
  })
  return sent.body?.mid ?? null
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
  if (!botRef) {
    throw new Error('MAX bot not initialized (setTgChainForwarderBot)')
  }

  const isAlbum = pending.length > 1 || Boolean(pending[0]?.media_group_id)
  const attachComments = chain.add_comments_button !== false

  try {
    let published = 0
    let resultMid: string | null = null
    if (isAlbum) {
      resultMid = await forwardAlbumToMax(
        botRef,
        pending,
        tgToken,
        chain.max_chat_id,
        chain.add_signature,
      )
      if (resultMid) {
        published = 1
        if (attachComments) {
          const chatId = resolveCanonicalChannelChatId(chain.max_chat_id) ?? chain.max_chat_id
          await ensurePostFromChannelMessage(botRef, chatId, resultMid)
        }
      }
    } else {
      const msg = pending[0]
      let caption = (msg.caption || msg.text || '').trim()
      if (chain.add_signature && caption) {
        caption = `${caption}\n\n— TG`
      }
      resultMid = await forwardOneTgMessageToMax(
        botRef,
        msg,
        tgToken,
        chain.max_chat_id,
        caption,
      )
      if (resultMid) {
        published = 1
        if (attachComments) {
          const chatId = resolveCanonicalChannelChatId(chain.max_chat_id) ?? chain.max_chat_id
          await ensurePostFromChannelMessage(botRef, chatId, resultMid)
        }
      }
    }

    for (const msg of pending) {
      markForwarded(chain.id, msg.message_id)
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

    await sleep(800 + Math.random() * 400)
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

export async function runTgChainsOnce(): Promise<boolean> {
  if (!botRef) {
    logger.warn('[tgChain] MAX bot not set — skip tick')
    return false
  }

  const chains = (await listTgChains()).filter(
    (c) => c.active && c.forward_posts && chainSourceKey(c) !== '',
  )
  if (chains.length === 0) {
    return false
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

  let receivedAny = false

  for (const [tgToken, group] of tokenGroups) {
    const pollErr = await assertTelegramPollingReady(tgToken)
    if (pollErr) {
      logger.warn('[tgChain] telegram polling not ready', { err: pollErr })
      continue
    }

    const offset = getReaderOffset(tgToken)
    const batch = await getTelegramUpdatesWithIds(tgToken, offset, TG_CHAIN_LONG_POLL_SEC)
    let nextOffset = offset

    const channelPosts: TgMessage[] = []
    for (const u of batch) {
      receivedAny = true
      nextOffset = Math.max(nextOffset, u.update_id + 1)
      if (u.channel_post) {
        channelPosts.push(u.channel_post)
      }
    }

    for (const chain of group) {
      const sourceKey = chainSourceKey(chain)
      const forChain = channelPosts.filter((m) => telegramChannelMatchesTarget(m.chat, sourceKey))
      const chainGroups = groupChannelPostsForForward(forChain)
      for (const msgs of chainGroups) {
        await processChainMessageGroup(chain, msgs, tgToken)
      }
    }

    if (nextOffset > offset) {
      setReaderOffset(tgToken, nextOffset)
    }
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
          await sleep(TG_CHAIN_IDLE_MS)
        }
      } catch (err: unknown) {
        logger.error('[tgChain] loop error', err)
        await sleep(TG_CHAIN_IDLE_MS)
      }
    }
  }
  void loop()
}
