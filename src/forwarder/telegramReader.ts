import axios from 'axios'
import { logger } from '../utils/logger'

const TG_API = 'https://api.telegram.org/bot'

export class TelegramGetUpdatesConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TelegramGetUpdatesConflictError'
  }
}

export interface TgMessage {
  message_id: number
  text?: string
  caption?: string
  /** Альбом из нескольких фото/видео — отдельные channel_post с одним media_group_id */
  media_group_id?: string
  photo?: { file_id: string; file_size: number }[]
  video?: { file_id: string; mime_type?: string }
  document?: { file_id: string; mime_type?: string; file_name?: string }
  chat: { id: number; username?: string; type?: string }
  from?: { id?: number; first_name?: string; last_name?: string; username?: string }
  reply_to_message?: { message_id: number }
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
      const res = await axios.get(url)
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
    const res = await axios.get(`${TG_API}${token}/getFile`, {
      params: { file_id: fileId },
    })
    const path = res.data?.result?.file_path
    if (!path) return null
    return `https://api.telegram.org/file/bot${token}/${path}`
  } catch {
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
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await axios.get(`${TG_API}${token}/getUpdates`, {
        params: {
          offset,
          timeout: timeoutSec,
          allowed_updates: JSON.stringify(allowed),
        },
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
