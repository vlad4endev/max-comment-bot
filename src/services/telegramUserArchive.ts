import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Api, TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'

import { logger } from '../utils/logger'
import type { StagedPayload } from './channelImportService'

export function telegramUserArchiveConfigured(): boolean {
  return getTelegramUserApiId() !== null && getTelegramUserApiHash() !== '' && getTelegramUserSession() !== ''
}

export function getTelegramUserApiId(): number | null {
  const raw = (process.env.TG_API_ID || '').trim()
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

export function getTelegramUserApiHash(): string {
  return (process.env.TG_API_HASH || '').trim()
}

export function getTelegramUserSession(): string {
  return (process.env.TG_USER_SESSION || '').trim()
}

async function createUserClient(): Promise<TelegramClient> {
  const apiId = getTelegramUserApiId()
  const apiHash = getTelegramUserApiHash()
  const session = getTelegramUserSession()
  if (apiId === null || !apiHash || !session) {
    throw new Error(
      'Не настроен user-аккаунт: задайте TG_API_ID, TG_API_HASH и TG_USER_SESSION (скрипт npm run tg:user-login)',
    )
  }
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
  })
  await client.connect()
  if (!(await client.checkAuthorization())) {
    await client.disconnect()
    throw new Error('TG_USER_SESSION недействителен — выполните npm run tg:user-login')
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

  const downloaded = await client.downloadMedia(msg, {})
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

export async function fetchChannelArchiveForImport(
  channelKey: string,
  limit: number,
  jobId: number,
): Promise<Array<{ messageId: number; payload: StagedPayload }>> {
  const client = await createUserClient()
  const tmpDir = path.join(os.tmpdir(), 'maxcomment-import', String(jobId))
  await fs.mkdir(tmpDir, { recursive: true })

  try {
    const entity = await client.getEntity(channelKey)
    const messages = await client.getMessages(entity, { limit, reverse: true })
    const out: Array<{ messageId: number; payload: StagedPayload }> = []

    for (const msg of messages) {
      if (!msg || typeof msg.id !== 'number') continue
      const payload = await mapMessageToPayload(client, msg as Api.Message, tmpDir)
      if (!payload) continue
      out.push({ messageId: msg.id, payload })
    }

    logger.info('[telegramUserArchive] fetched', {
      channelKey,
      limit,
      jobId,
      count: out.length,
    })
    return out
  } finally {
    await client.disconnect()
  }
}
