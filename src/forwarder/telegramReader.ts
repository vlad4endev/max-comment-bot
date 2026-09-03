import axios from 'axios'

import { telegramAxios, telegramPollAxios } from '../utils/telegramAxios'
import { logger } from '../utils/logger'

const TG_API = 'https://api.telegram.org/bot'

function collectErrorText(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let i = 0; i < 5 && current != null; i += 1) {
    if (typeof current === 'string') {
      parts.push(current)
      break
    }
    if (typeof current !== 'object') {
      parts.push(String(current))
      break
    }
    const record = current as {
      name?: unknown
      message?: unknown
      code?: unknown
      cause?: unknown
      errors?: unknown
    }
    if (typeof record.name === 'string') parts.push(record.name)
    if (typeof record.message === 'string') parts.push(record.message)
    if (typeof record.code === 'string') parts.push(record.code)
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors) {
        parts.push(collectErrorText(nested))
      }
    }
    current = record.cause
  }
  return parts.join(' ')
}

const TRANSIENT_NETWORK_RE =
  /ETIMEDOUT|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|EPIPE|EPROTO|ERR_CANCELED|UND_ERR_|socket hang up|other side closed|TLS handshake|canceled|aborted|AggregateError/i

/** Таймаут/обрыв long-poll getUpdates — не авария, а пустой тик. */
export function isTelegramGetUpdatesTimeoutError(err: unknown): boolean {
  return isTelegramTransientNetworkError(err)
}

/** Временный сетевой сбой до Telegram (прокси, TLS, DNS) — цикл должен продолжить опрос. */
export function isTelegramTransientNetworkError(err: unknown): boolean {
  if (axios.isCancel(err)) {
    return true
  }
  if (axios.isAxiosError(err)) {
    const code = err.code ?? ''
    if (
      code === 'ERR_CANCELED' ||
      code === 'ECONNABORTED' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'ENETUNREACH' ||
      code === 'ECONNREFUSED'
    ) {
      return true
    }
    if (err.name === 'CanceledError' || err.message === 'canceled') {
      return true
    }
  }
  if (err instanceof Error) {
    const name = err.name
    const msg = err.message.toLowerCase()
    if (name === 'CanceledError' || name === 'AbortError' || name === 'AggregateError') {
      return true
    }
    if (msg === 'canceled' || msg.includes('aborted') || msg.includes('etimedout')) {
      return true
    }
  }
  return TRANSIENT_NETWORK_RE.test(collectErrorText(err))
}

export class TelegramGetUpdatesConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TelegramGetUpdatesConflictError'
  }
}

export interface TgReplyToMessage {
  message_id: number
  reply_to_message?: TgReplyToMessage
  forward_from_message_id?: number
  is_automatic_forward?: boolean
  forward_origin?: {
    type?: string
    chat?: { id: number }
    message_id?: number
  }
  sender_chat?: { id: number; title?: string; username?: string }
}

export interface TgMessage {
  message_id: number
  /** Unix time (seconds) when the message was sent in Telegram. */
  date?: number
  text?: string
  caption?: string
  /** Альбом из нескольких фото/видео — отдельные channel_post с одним media_group_id */
  media_group_id?: string
  photo?: { file_id: string; file_size: number }[]
  video?: { file_id: string; mime_type?: string }
  document?: { file_id: string; mime_type?: string; file_name?: string }
  chat: { id: number; username?: string; type?: string }
  from?: { id?: number; first_name?: string; last_name?: string; username?: string }
  reply_to_message?: TgReplyToMessage
  sender_chat?: { id: number; title?: string; username?: string }
  forward_from_message_id?: number
  forward_from_chat?: { id: number }
  is_automatic_forward?: boolean
  forward_origin?: {
    type?: string
    chat?: { id: number }
    message_id?: number
  }
}

export interface TgChannelUpdate {
  update_id: number
  channel_post?: TgMessage
  edited_channel_post?: TgMessage
  edited_message?: TgMessage
  message?: TgMessage
  my_chat_member?: Record<string, unknown>
  callback_query?: Record<string, unknown>
  raw?: Record<string, unknown>
}

export async function getTgUpdates(token: string, offset: number = 0): Promise<TgMessage[]> {
  const url = `${TG_API}${token}/getUpdates?offset=${offset}&timeout=10&allowed_updates=["channel_post"]`
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await telegramPollAxios.get(url)
      const updates = res.data?.result || []
      return updates
        .filter((u: any) => u.channel_post)
        .map((u: any) => u.channel_post)
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s', {
          offset,
          attempt,
        })
        await new Promise((r) => setTimeout(r, 10_000))
        continue
      }
      throw err
    }
  }
  throw new TelegramGetUpdatesConflictError('telegram getUpdates conflict (409)')
}

export async function getTgFileUrl(token: string, fileId: string): Promise<string | null> {
  try {
    const res = await telegramAxios.get(`${TG_API}${token}/getFile`, {
      params: { file_id: fileId },
      timeout: 15_000,
    })
    const path = res.data?.result?.file_path
    if (!path) {
      logger.warn('[tg] getFile: empty file_path', { fileIdSuffix: fileId.slice(-8) })
      return null
    }
    return `https://api.telegram.org/file/bot${token}/${path}`
  } catch (err: unknown) {
    logger.warn('[tg] getFile failed', {
      fileIdSuffix: fileId.slice(-8),
      status: axios.isAxiosError(err) ? err.response?.status : undefined,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** Сырые апдейты с `update_id` — для корректного offset при опросе. */
export async function getTelegramUpdatesWithIds(
  token: string,
  offset: number,
  timeoutSec: number = 0,
  options?: { includeMiniappBotUpdates?: boolean; includeDiscussionMessages?: boolean },
): Promise<TgChannelUpdate[]> {
  const allowed = ['channel_post', 'edited_channel_post', 'edited_message']
  if (options?.includeMiniappBotUpdates) {
    allowed.push('message', 'my_chat_member', 'callback_query')
  } else if (options?.includeDiscussionMessages) {
    allowed.push('message')
  }
  const requestTimeoutMs = Math.max(25_000, (timeoutSec + 20) * 1000)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await telegramPollAxios.get(`${TG_API}${token}/getUpdates`, {
        params: {
          offset,
          timeout: timeoutSec,
          limit: 100,
          allowed_updates: JSON.stringify(allowed),
        },
        timeout: requestTimeoutMs,
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      const updates = res.data?.result || []
      return updates
        .filter((u: any) => typeof u.update_id === 'number')
        .map((u: any) => ({
          update_id: u.update_id as number,
          channel_post: u.channel_post as TgMessage | undefined,
          edited_channel_post: u.edited_channel_post as TgMessage | undefined,
          edited_message: u.edited_message as TgMessage | undefined,
          message: u.message as TgMessage | undefined,
          my_chat_member: u.my_chat_member as Record<string, unknown> | undefined,
          callback_query: u.callback_query as Record<string, unknown> | undefined,
          raw: u as Record<string, unknown>,
        }))
    } catch (err: unknown) {
      if (isTelegramGetUpdatesTimeoutError(err)) {
        return []
      }
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s', {
          offset,
          attempt,
        })
        await new Promise((r) => setTimeout(r, 10_000))
        continue
      }
      throw err
    }
  }
  throw new TelegramGetUpdatesConflictError('telegram getUpdates conflict (409)')
}
