import fs from 'node:fs'

import { config } from '../config'
import {
  sendMediaAlbumFilesToMax,
  sendPhotoFileToMax,
  sendTextToMax,
  sendVideoFileToMax,
  type MaxSendOptions,
} from '../forwarder/maxPublisher'
import type { AutopostInlineButton, AutopostMediaItem, AutopostRecord } from './autopostStore'
import type { AutopostSendResult } from './autopostTelegramSender'

function toMaxButton(button: AutopostInlineButton | null): MaxSendOptions['button'] | undefined {
  if (!button) return undefined
  return { text: button.text, url: button.url }
}

function existingMedia(media: AutopostMediaItem[]): AutopostMediaItem[] {
  return media.filter((m) => fs.existsSync(m.path))
}

/**
 * Публикует автопост в MAX-канал (HTML + медиа + инлайн-кнопка).
 */
export async function sendAutopostToMax(
  token: string,
  post: AutopostRecord,
): Promise<AutopostSendResult> {
  const chatId = post.target_channel_id
  const text = post.text.trim()
  const media = existingMedia(post.media)
  const sendOpts: MaxSendOptions = { button: toMaxButton(post.inline_button) }

  if (media.length === 0) {
    await sendTextToMax(token, chatId, text, sendOpts)
    return { ok: true }
  }

  if (media.length === 1) {
    const item = media[0]
    if (item.type === 'video') {
      await sendVideoFileToMax(token, chatId, item.path, text, sendOpts)
    } else {
      await sendPhotoFileToMax(token, chatId, item.path, text, sendOpts)
    }
    return { ok: true }
  }

  await sendMediaAlbumFilesToMax(
    token,
    chatId,
    text,
    media.map((m) => ({
      type: m.type === 'video' ? 'video' : 'image',
      filePath: m.path,
    })),
    sendOpts,
  )
  return { ok: true }
}

export function resolveMaxToken(): string | null {
  const token = config.BOT_TOKEN.trim()
  return token || null
}
