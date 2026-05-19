import axios from 'axios'

const TG_API = 'https://api.telegram.org/bot'

export interface TgMessage {
  message_id: number
  text?: string
  caption?: string
  photo?: { file_id: string; file_size: number }[]
  video?: { file_id: string; mime_type?: string }
  document?: { file_id: string; mime_type?: string; file_name?: string }
  chat: { id: number; username?: string }
}

export async function getTgUpdates(token: string, offset: number = 0): Promise<TgMessage[]> {
  const url = `${TG_API}${token}/getUpdates?offset=${offset}&timeout=10&allowed_updates=["channel_post"]`
  const res = await axios.get(url)
  const updates = res.data?.result || []
  return updates
    .filter((u: any) => u.channel_post)
    .map((u: any) => u.channel_post)
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
): Promise<Array<{ update_id: number; channel_post: TgMessage }>> {
  const res = await axios.get(`${TG_API}${token}/getUpdates`, {
    params: {
      offset,
      timeout: timeoutSec,
      allowed_updates: JSON.stringify(['channel_post']),
    },
  })
  const updates = res.data?.result || []
  return updates
    .filter((u: any) => u.channel_post && typeof u.update_id === 'number')
    .map((u: any) => ({ update_id: u.update_id as number, channel_post: u.channel_post as TgMessage }))
}
