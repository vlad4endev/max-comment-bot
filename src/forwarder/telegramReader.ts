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
  chat: { id: number; username?: string }
}

export interface TgChannelUpdate {
  update_id: number
  channel_post?: TgMessage
  edited_channel_post?: TgMessage
  edited_message?: TgMessage
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
): Promise<TgChannelUpdate[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await axios.get(`${TG_API}${token}/getUpdates`, {
        params: {
          offset,
          timeout: timeoutSec,
          allowed_updates: JSON.stringify(['channel_post', 'edited_channel_post', 'edited_message']),
        },
      })
      const updates = res.data?.result || []
      return updates
        .filter(
          (u: any) =>
            typeof u.update_id === 'number' &&
            (u.channel_post || u.edited_channel_post || u.edited_message),
        )
        .map((u: any) => ({
          update_id: u.update_id as number,
          channel_post: u.channel_post as TgMessage | undefined,
          edited_channel_post: u.edited_channel_post as TgMessage | undefined,
          edited_message: u.edited_message as TgMessage | undefined,
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
