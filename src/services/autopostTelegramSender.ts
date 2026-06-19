import fs from 'node:fs'
import path from 'node:path'

import axios from 'axios'
import FormData from 'form-data'

import { prepareMessengerHtmlText } from '../utils/messengerHtml'
import { logger } from '../utils/logger'
import type { AutopostInlineKeyboard, AutopostMediaItem, AutopostRecord } from './autopostStore'

const TG_API = 'https://api.telegram.org'

export interface AutopostSendResult {
  ok: boolean
  /** true, если инлайн-кнопка ушла отдельным сообщением (альбом). */
  buttonSentSeparately?: boolean
  warning?: string
}

function resolveKeyboard(post: AutopostRecord): AutopostInlineKeyboard | null {
  if (post.inline_buttons?.length) return post.inline_buttons
  if (post.inline_button) return [[post.inline_button]]
  return null
}

function buildInlineKeyboard(keyboard: AutopostInlineKeyboard): {
  inline_keyboard: { text: string; url: string }[][]
} {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((btn) => ({ text: btn.text.slice(0, 64), url: btn.url })),
    ),
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
  keyboard: AutopostInlineKeyboard | null,
): Promise<void> {
  const prepared = prepareMessengerHtmlText(text)
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: prepared.text.slice(0, 4096) || '\u00a0',
  }
  if (prepared.parseMode) {
    payload.parse_mode = prepared.parseMode
  }
  if (keyboard?.length) {
    payload.reply_markup = JSON.stringify(buildInlineKeyboard(keyboard))
  }
  await tgPost(token, 'sendMessage', payload)
}

async function sendSingleMedia(
  token: string,
  chatId: string,
  item: AutopostMediaItem,
  caption: string,
  keyboard: AutopostInlineKeyboard | null,
): Promise<void> {
  const method = item.type === 'video' ? 'sendVideo' : 'sendPhoto'
  const field = item.type === 'video' ? 'video' : 'photo'
  const form = new FormData()
  form.append('chat_id', chatId)
  if (caption.trim()) {
    const prepared = prepareMessengerHtmlText(caption)
    form.append('caption', prepared.text.slice(0, 1024))
    if (prepared.parseMode) {
      form.append('parse_mode', prepared.parseMode)
    }
  }
  if (keyboard?.length) {
    form.append('reply_markup', JSON.stringify(buildInlineKeyboard(keyboard)))
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
      const prepared = prepareMessengerHtmlText(caption)
      entry.caption = prepared.text.slice(0, 1024)
      if (prepared.parseMode) {
        entry.parse_mode = prepared.parseMode
      }
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
 * sendMediaGroup не поддерживает inline-кнопки — при альбоме кнопки уходят отдельным сообщением.
 */
export async function sendAutopostToTelegram(
  token: string,
  post: AutopostRecord,
): Promise<AutopostSendResult> {
  const chatId = post.target_channel_id
  const text = post.text.trim()
  const media = post.media.filter((m) => fs.existsSync(m.path))
  const keyboard = resolveKeyboard(post)

  if (media.length === 0) {
    await sendText(token, chatId, text, keyboard)
    return { ok: true }
  }

  if (media.length === 1) {
    await sendSingleMedia(token, chatId, media[0], text, keyboard)
    return { ok: true }
  }

  await sendMediaGroup(token, chatId, media, text)
  if (!keyboard?.length) {
    return { ok: true }
  }

  const warning =
    'Инлайн-кнопки не поддерживаются в альбоме Telegram — отправлены отдельным сообщением'
  try {
    await sendText(token, chatId, '\u00a0', keyboard)
    return { ok: true, buttonSentSeparately: true, warning }
  } catch (err: unknown) {
    logger.warn('autopost: album sent, separate button message failed', err)
    return { ok: true, buttonSentSeparately: false, warning }
  }
}
