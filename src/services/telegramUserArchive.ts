import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Api, TelegramClient } from 'telegram'
import type { EntityLike } from 'telegram/define'
import { StringSession } from 'telegram/sessions'

import { logger } from '../utils/logger'
import { normalizeTelegramChannelKey } from '../utils/tgChannelMatch'
import type { StagedPayload } from './channelImportService'
import { resolveMtprotoCredentials } from './mtprotoConfigStore'

const MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000
const ARCHIVE_FETCH_TIMEOUT_MS = 20 * 60_000

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

export function telegramUserArchiveConfigured(): boolean {
  const { apiId, apiHash, session } = resolveMtprotoCredentials()
  return apiId !== null && apiHash !== '' && session !== ''
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

async function createUserClient(): Promise<TelegramClient> {
  const apiId = getTelegramUserApiId()
  const apiHash = getTelegramUserApiHash()
  const session = getTelegramUserSession()
  if (apiId === null || !apiHash || !session) {
    throw new Error(
      'Не настроен user-аккаунт: укажите MTProto в админке (Импорт TG→MAX) или TG_API_ID, TG_API_HASH, TG_USER_SESSION в .env',
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

async function mapMessageToPayload(
  client: TelegramClient,
  msg: Api.Message,
  tmpDir: string,
): Promise<StagedPayload | null> {
  const caption = messageCaption(msg)
  const media = msg.media

  if (!media) {
    return caption ? { kind: 'text', text: caption } : null
  }

  const downloaded = await withTimeout(
    client.downloadMedia(msg, {}),
    MEDIA_DOWNLOAD_TIMEOUT_MS,
    'скачивание медиа',
  )
  if (!downloaded || !Buffer.isBuffer(downloaded)) {
    return caption ? { kind: 'text', text: caption } : null
  }

  if (media instanceof Api.MessageMediaPhoto) {
    const localPath = path.join(tmpDir, `${msg.id}-photo.jpg`)
    await fs.writeFile(localPath, downloaded)
    return { kind: 'photo', caption, localPath }
  }

  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document
    if (doc instanceof Api.Document) {
      const mime = doc.mimeType || 'application/octet-stream'
      const fileName =
        doc.attributes?.find((a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename)
          ?.fileName || `file-${msg.id}`
      const localPath = path.join(tmpDir, `${msg.id}-${fileName}`)
      await fs.writeFile(localPath, downloaded)
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
      for (const msg of messages) {
        if (!msg || typeof msg.id !== 'number') continue
        scanned += 1
        let payload: StagedPayload | null = null
        try {
          payload = await mapMessageToPayload(client, msg as Api.Message, tmpDir)
        } catch (err: unknown) {
          logger.warn('[telegramUserArchive] skip message', {
            jobId,
            messageId: msg.id,
            err: err instanceof Error ? err.message : String(err),
          })
          const caption = messageCaption(msg as Api.Message)
          if (caption) {
            payload = { kind: 'text', text: caption }
          }
        }
        if (!payload) continue
        const post: ArchivePost = { messageId: msg.id, payload }
        if (onPost) {
          await onPost(post)
        }
        staged += 1
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
