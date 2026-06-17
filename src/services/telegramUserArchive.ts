import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Api, TelegramClient } from 'telegram'
import type { EntityLike } from 'telegram/define'
import { FloodWaitError, SlowModeWaitError } from 'telegram/errors'
import { StringSession } from 'telegram/sessions'

import { logger } from '../utils/logger'
import { normalizeTelegramChannelKey } from '../utils/tgChannelMatch'
import type { StagedPayload } from './channelImportService'
import { resolveMtprotoCredentials, isMtprotoSessionReady } from './mtprotoConfigStore'

const MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000
const ARCHIVE_FETCH_TIMEOUT_MS = 20 * 60_000
const ARCHIVE_STEP_DELAY_MS = 1200

export type ArchivePost = { messageId: number; payload: StagedPayload }

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Таймаут (${label})`)), ms)
    promise
      .then((v) => {
        clearTimeout(timer)
        resolve(v)
      })
      .catch((e: unknown) => {
        clearTimeout(timer)
        reject(e)
      })
  })
}

function telegramRpcMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'object' && err !== null && 'errorMessage' in err) {
    const rpc = String((err as { errorMessage?: string }).errorMessage || '')
    if (rpc === 'CHANNEL_PRIVATE') {
      return 'Канал закрыт: user-аккаунт должен быть подписан на канал'
    }
    if (rpc === 'USERNAME_NOT_OCCUPIED' || rpc === 'USERNAME_INVALID') {
      return 'Канал не найден по username — проверьте @ или укажите -100… id'
    }
    if (rpc === 'FLOOD_WAIT') {
      return 'Telegram просит подождать (FLOOD_WAIT) — повторите через минуту'
    }
    if (rpc) return rpc
  }
  return 'Ошибка Telegram MTProto'
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function floodWaitSeconds(err: unknown): number | null {
  if (err instanceof FloodWaitError || err instanceof SlowModeWaitError) {
    return Number.isFinite(err.seconds) ? Math.max(1, Math.ceil(err.seconds)) : null
  }
  if (typeof err === 'object' && err !== null && 'seconds' in err) {
    const seconds = Number((err as { seconds?: unknown }).seconds)
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.max(1, Math.ceil(seconds))
    }
  }
  const msg = err instanceof Error ? err.message : String(err)
  const match = /FLOOD_WAIT_?(\d+)/i.exec(msg)
  if (match?.[1]) {
    return Math.max(1, Number(match[1]))
  }
  return null
}

async function withFloodWaitRetry<T>(
  jobId: number,
  label: string,
  run: () => Promise<T>,
  maxRetries: number = 5,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await run()
    } catch (err: unknown) {
      const waitSeconds = floodWaitSeconds(err)
      if (!waitSeconds || attempt >= maxRetries) {
        throw err
      }
      logger.warn('[telegramUserArchive] FLOOD_WAIT, жду и продолжаю', {
        jobId,
        label,
        attempt: attempt + 1,
        waitSeconds,
      })
      await sleep((waitSeconds + 1) * 1000)
    }
  }
  throw new Error('unexpected flood-wait retry state')
}

export function telegramUserArchiveConfigured(): boolean {
  return isMtprotoSessionReady()
}

export function getTelegramUserApiId(): number | null {
  return resolveMtprotoCredentials().apiId
}

export function getTelegramUserApiHash(): string {
  return resolveMtprotoCredentials().apiHash
}

export function getTelegramUserSession(): string {
  return resolveMtprotoCredentials().session
}

/** Подключение MTProto user-сессии (импорт TG→MAX, отправка в обсуждения от канала). */
export async function connectTelegramUserClient(): Promise<TelegramClient> {
  return createUserClient()
}

export async function resolveTelegramChannelEntity(
  client: TelegramClient,
  channelKey: string,
): Promise<EntityLike> {
  return resolveChannelEntity(client, channelKey)
}

async function createUserClient(): Promise<TelegramClient> {
  const apiId = getTelegramUserApiId()
  const apiHash = getTelegramUserApiHash()
  const session = getTelegramUserSession()
  if (apiId === null || !apiHash || !session) {
    throw new Error(
      'Не настроен user-аккаунт: войдите в MTProto в админке (TG→MAX или Импорт TG→MAX) или задайте TG_API_ID, TG_API_HASH, TG_USER_SESSION в .env',
    )
  }
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
  })
  await client.connect()
  if (!(await client.checkAuthorization())) {
    await client.disconnect()
    throw new Error('Сессия MTProto недействительна — войдите заново в админке')
  }
  return client
}

function messageCaption(msg: { message?: string }): string {
  const text = typeof msg.message === 'string' ? msg.message.trim() : ''
  return text
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180)
}

async function mapMessageToPayload(
  client: TelegramClient,
  msg: Api.Message,
  tmpDir: string,
  jobId: number,
): Promise<StagedPayload | null> {
  const caption = messageCaption(msg)
  const media = msg.media

  if (!media) {
    return caption ? { kind: 'text', text: caption } : null
  }

  if (media instanceof Api.MessageMediaPhoto) {
    const localPath = path.join(tmpDir, `${msg.id}-photo.jpg`)
    logger.info('[telegramUserArchive] Скачиваю фото из Telegram', { jobId, messageId: msg.id })
    await withTimeout(
      client.downloadMedia(msg, { outputFile: localPath }),
      MEDIA_DOWNLOAD_TIMEOUT_MS,
      'скачивание фото',
    )
    logger.info('[telegramUserArchive] Фото скачано', { jobId, messageId: msg.id, localPath })
    return { kind: 'photo', caption, localPath }
  }

  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document
    if (doc instanceof Api.Document) {
      const mime = doc.mimeType || 'application/octet-stream'
      const fileName =
        doc.attributes?.find((a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename)
          ?.fileName || `file-${msg.id}`
      const localPath = path.join(tmpDir, `${msg.id}-${sanitizeFileName(fileName)}`)
      logger.info('[telegramUserArchive] Скачиваю документ/видео из Telegram', {
        jobId,
        messageId: msg.id,
        fileName,
      })
      await withTimeout(
        client.downloadMedia(msg, { outputFile: localPath }),
        MEDIA_DOWNLOAD_TIMEOUT_MS,
        'скачивание документа',
      )
      logger.info('[telegramUserArchive] Файл скачан', {
        jobId,
        messageId: msg.id,
        localPath,
      })
      if (mime.startsWith('video/')) {
        return { kind: 'video', caption, localPath }
      }
      return {
        kind: 'document',
        caption,
        localPath,
        fileName,
        mimeType: mime,
      }
    }
  }

  return caption ? { kind: 'text', text: caption } : null
}

function groupedIdKey(msg: Api.Message): string | null {
  if (!msg.groupedId) return null
  try {
    return msg.groupedId.toString()
  } catch {
    return String(msg.groupedId)
  }
}

function isMediaPayload(
  payload: StagedPayload,
): payload is
  | { kind: 'photo'; caption: string; localPath?: string }
  | { kind: 'video'; caption: string; localPath?: string }
  | { kind: 'document'; caption: string; localPath?: string; fileName?: string; mimeType?: string } {
  return payload.kind === 'photo' || payload.kind === 'video' || payload.kind === 'document'
}

function collectPayloadPaths(payload: StagedPayload): string[] {
  if (payload.kind === 'album') {
    return payload.items.map((item) => item.localPath)
  }
  if ('localPath' in payload && payload.localPath) {
    return [payload.localPath]
  }
  return []
}

type ArchiveMessageGroup = { messageId: number; groupedId: string | null; items: Api.Message[] }

function buildArchiveMessageGroups(messages: Api.Message[]): ArchiveMessageGroup[] {
  const groups: ArchiveMessageGroup[] = []
  const albumIndexByGroupId = new Map<string, number>()
  for (const msg of messages) {
    if (!msg || typeof msg.id !== 'number') continue
    const groupedId = groupedIdKey(msg)
    if (!groupedId) {
      groups.push({ messageId: msg.id, groupedId: null, items: [msg] })
      continue
    }
    const existingIndex = albumIndexByGroupId.get(groupedId)
    if (existingIndex === undefined) {
      groups.push({ messageId: msg.id, groupedId, items: [msg] })
      albumIndexByGroupId.set(groupedId, groups.length - 1)
      continue
    }
    groups[existingIndex].items.push(msg)
  }
  return groups
}

async function mapGroupToPost(
  client: TelegramClient,
  group: ArchiveMessageGroup,
  tmpDir: string,
  jobId: number,
): Promise<ArchivePost | null> {
  if (group.items.length === 1) {
    const payload = await mapMessageToPayload(client, group.items[0], tmpDir, jobId)
    return payload ? { messageId: group.messageId, payload } : null
  }

  logger.info('[telegramUserArchive] Обрабатываю альбом groupedId', {
    jobId,
    groupedId: group.groupedId,
    parts: group.items.length,
  })

  const albumItems: {
    kind: 'photo' | 'video' | 'document'
    localPath: string
    fileName?: string
    mimeType?: string
  }[] = []
  let caption = ''
  const createdFiles: string[] = []
  try {
    for (const item of group.items) {
      const payload = await mapMessageToPayload(client, item, tmpDir, jobId)
      if (!payload) continue
      if (isMediaPayload(payload) && payload.localPath) {
        albumItems.push({
          kind: payload.kind,
          localPath: payload.localPath,
          fileName: payload.kind === 'document' ? payload.fileName : undefined,
          mimeType: payload.kind === 'document' ? payload.mimeType : undefined,
        })
        createdFiles.push(payload.localPath)
      }
      if (!caption) {
        const c = payload.kind === 'text' ? payload.text : payload.caption
        if (c?.trim()) caption = c.trim()
      }
    }
  } catch (err) {
    for (const filePath of createdFiles) {
      await fs.rm(filePath, { force: true }).catch(() => {})
    }
    throw err
  }

  if (albumItems.length === 0) {
    return caption ? { messageId: group.messageId, payload: { kind: 'text', text: caption } } : null
  }
  return {
    messageId: group.messageId,
    payload: {
      kind: 'album',
      caption,
      items: albumItems,
    },
  }
}

async function resolveChannelEntity(client: TelegramClient, channelKey: string): Promise<EntityLike> {
  const normalized = normalizeTelegramChannelKey(channelKey)
  const candidates = [normalized, normalized.replace(/^@/, '')].filter(
    (v, i, a) => v && a.indexOf(v) === i,
  )
  let lastErr: unknown
  for (const key of candidates) {
    try {
      return (await client.getEntity(key)) as EntityLike
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(telegramRpcMessage(lastErr))
}

export async function fetchChannelArchiveForImport(
  channelKey: string,
  limit: number,
  jobId: number,
  onPost?: (post: ArchivePost) => Promise<void>,
): Promise<number> {
  const run = async (): Promise<number> => {
    const client = await createUserClient()
    const tmpDir = path.join(os.tmpdir(), 'maxcomment-import', String(jobId))
    await fs.mkdir(tmpDir, { recursive: true })

    try {
      const entity = await resolveChannelEntity(client, channelKey)
      const messages = await client.getMessages(entity, { limit, reverse: true })
      if (!messages.length) {
        throw new Error(
          'В канале нет доступных сообщений. User-аккаунт должен быть участником/админом канала.',
        )
      }

      let staged = 0
      let scanned = 0
      const groups = buildArchiveMessageGroups(messages as Api.Message[])
      logger.info('[telegramUserArchive] Сообщения сгруппированы перед импортом', {
        jobId,
        messages: messages.length,
        groups: groups.length,
      })

      for (const group of groups) {
        scanned += group.items.length
        let post: ArchivePost | null = null
        try {
          post = await withFloodWaitRetry(
            jobId,
            `group:${group.groupedId ?? group.messageId}`,
            async () => mapGroupToPost(client, group, tmpDir, jobId),
          )
        } catch (err: unknown) {
          logger.warn('[telegramUserArchive] skip message/group', {
            jobId,
            messageId: group.messageId,
            groupedId: group.groupedId,
            err: err instanceof Error ? err.message : String(err),
          })
          const caption =
            group.items.map((m) => messageCaption(m)).find((text) => text.length > 0) || ''
          if (caption) {
            post = { messageId: group.messageId, payload: { kind: 'text', text: caption } }
          }
        }
        if (!post) continue
        logger.info('[telegramUserArchive] Пост подготовлен, передаю в staging', {
          jobId,
          messageId: post.messageId,
          payloadKind: post.payload.kind,
          groupedId: group.groupedId,
        })
        if (onPost) {
          await onPost(post)
        }
        if (!onPost) {
          for (const localPath of collectPayloadPaths(post.payload)) {
            await fs.rm(localPath, { force: true }).catch(() => {})
          }
        }
        staged += 1
        await sleep(ARCHIVE_STEP_DELAY_MS)
      }

      logger.info('[telegramUserArchive] fetched', {
        channelKey,
        limit,
        jobId,
        scanned,
        staged,
      })
      if (staged === 0) {
        throw new Error(
          `Просмотрено сообщений: ${scanned}, подходящих постов: 0 (пустые или неподдерживаемый формат).`,
        )
      }
      return staged
    } finally {
      await client.disconnect()
    }
  }

  return withTimeout(run(), ARCHIVE_FETCH_TIMEOUT_MS, 'загрузка архива')
}
