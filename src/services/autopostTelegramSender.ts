import fs from 'node:fs'
import path from 'node:path'

import axios from 'axios'
import FormData from 'form-data'

import { logger } from '../utils/logger'
import type { AutopostInlineButton, AutopostMediaItem, AutopostRecord } from './autopostStore'

const TG_API = 'https://api.telegram.org'

export interface AutopostSendResult {
  ok: boolean
  /** true, если инлайн-кнопка ушла отдельным сообщением (альбом). */
  buttonSentSeparately?: boolean
  warning?: string
}

function buildInlineKeyboard(button: AutopostInlineButton): {
  inline_keyboard: [[{ text: string; url: string }]]
} {
  return {
    inline_keyboard: [[{ text: button.text.slice(0, 64), url: button.url }]],
  }
}

async function tgPost<T>(
  token: string,
  method: string,
  body: Record<string, unknown> | FormData,
): Promise<T> {
  const url = `${TG_API}/bot${token}/${method}`
  const isForm = body instanceof FormData
  const { data } = await axios.post<{ ok: boolean; description?: string; result?: T }>(url, body, {
    timeout: 120_000,
    headers: isForm ? body.getHeaders() : { 'Content-Type': 'application/json' },
  })
  if (!data.ok) {
    throw new Error(data.description ?? `Telegram ${method} failed`)
  }
  return data.result as T
}

async function sendText(
  token: string,
  chatId: string,
  text: string,
  button: AutopostInlineButton | null,
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: text.slice(0, 4096) || '\u00a0',
  }
  if (button) {
    payload.reply_markup = JSON.stringify(buildInlineKeyboard(button))
  }
  await tgPost(token, 'sendMessage', payload)
}

async function sendSingleMedia(
  token: string,
  chatId: string,
  item: AutopostMediaItem,
  caption: string,
  button: AutopostInlineButton | null,
): Promise<void> {
  const method = item.type === 'video' ? 'sendVideo' : 'sendPhoto'
  const field = item.type === 'video' ? 'video' : 'photo'
  const form = new FormData()
  form.append('chat_id', chatId)
  if (caption.trim()) {
    form.append('caption', caption.slice(0, 1024))
  }
  if (button) {
    form.append('reply_markup', JSON.stringify(buildInlineKeyboard(button)))
  }
  form.append(field, fs.createReadStream(item.path), {
    filename: path.basename(item.path),
  })
  await tgPost(token, method, form)
}

async function sendMediaGroup(
  token: string,
  chatId: string,
  media: AutopostMediaItem[],
  caption: string,
): Promise<void> {
  const form = new FormData()
  form.append('chat_id', chatId)
  const items = media.map((m, index) => {
    const entry: Record<string, unknown> = {
      type: m.type === 'video' ? 'video' : 'photo',
      media: `attach://${m.type}_${index}`,
    }
    if (index === 0 && caption.trim()) {
      entry.caption = caption.slice(0, 1024)
    }
    return entry
  })
  form.append('media', JSON.stringify(items))
  for (let i = 0; i < media.length; i += 1) {
    const m = media[i]
    const field = `${m.type}_${i}`
    form.append(field, fs.createReadStream(m.path), { filename: path.basename(m.path) })
  }
  await tgPost(token, 'sendMediaGroup', form)
}

/**
 * Публикует автопост в Telegram-канал.
 * sendMediaGroup не поддерживает inline-кнопки — при альбоме кнопка уходит отдельным сообщением.
 */
export async function sendAutopostToTelegram(
  token: string,
  post: AutopostRecord,
): Promise<AutopostSendResult> {
  const chatId = post.target_channel_id
  const text = post.text.trim()
  const media = post.media.filter((m) => fs.existsSync(m.path))
  const button = post.inline_button

  if (media.length === 0) {
    await sendText(token, chatId, text, button)
    return { ok: true }
  }

  if (media.length === 1) {
    await sendSingleMedia(token, chatId, media[0], text, button)
    return { ok: true }
  }

  await sendMediaGroup(token, chatId, media, text)
  if (!button) {
    return { ok: true }
  }

  const warning =
    'Инлайн-кнопка не поддерживается в альбоме Telegram — отправлено отдельным сообщением'
  try {
    await sendText(token, chatId, button.text, button)
    return { ok: true, buttonSentSeparately: true, warning }
  } catch (err: unknown) {
    logger.warn('autopost: album sent, separate button message failed', err)
    return { ok: true, buttonSentSeparately: false, warning }
  }
}
