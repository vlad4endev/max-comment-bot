import fs from 'node:fs/promises'
import path from 'node:path'

import axios from 'axios'
import FormData from 'form-data'

/** Официальный API MAX (как в @maxhub/max-bot-api). Старый botapi.max.ru/messages/sendMessage даёт 404. */
const MAX_API = 'https://platform-api.max.ru'

function maxAuthHeaders(token: string): Record<string, string> {
  return { Authorization: token.trim() }
}

async function postMessage(
  token: string,
  chatId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await axios.post(`${MAX_API}/messages`, body, {
    params: { chat_id: chatId },
    headers: {
      ...maxAuthHeaders(token),
      'Content-Type': 'application/json',
    },
  })
}

async function uploadBufferToMax(
  token: string,
  type: 'image' | 'video' | 'file',
  buffer: Buffer,
  filename: string,
  contentType: string,
): Promise<string> {
  const slot = await axios.post<{ url: string; token?: string }>(`${MAX_API}/uploads`, null, {
    params: { type },
    headers: maxAuthHeaders(token),
  })
  const uploadUrl = slot.data.url
  const uploadToken = slot.data.token
  const form = new FormData()
  form.append('data', buffer, { filename, contentType })
  await axios.post(uploadUrl, form, { headers: form.getHeaders() })
  if (!uploadToken) {
    throw new Error('MAX upload: missing token in uploads response')
  }
  return uploadToken
}

export async function sendTextToMax(token: string, chatId: string, text: string): Promise<void> {
  await postMessage(token, chatId, { text: text.substring(0, 4096) })
}

export async function sendPhotoFileToMax(
  token: string,
  chatId: string,
  filePath: string,
  caption: string,
): Promise<void> {
  const buffer = await fs.readFile(filePath)
  const name = path.basename(filePath)
  const uploadToken = await uploadBufferToMax(token, 'image', buffer, name, 'image/jpeg')
  await postMessage(token, chatId, {
    text: caption.substring(0, 1024) || '\u00a0',
    attachments: [{ type: 'image', payload: { token: uploadToken } }],
  })
}

export async function sendVideoFileToMax(
  token: string,
  chatId: string,
  filePath: string,
  caption: string,
): Promise<void> {
  const buffer = await fs.readFile(filePath)
  const name = path.basename(filePath)
  const ext = path.extname(name).toLowerCase()
  const contentType =
    ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4'
  const uploadToken = await uploadBufferToMax(token, 'video', buffer, name, contentType)
  await postMessage(token, chatId, {
    text: caption.substring(0, 1024) || '\u00a0',
    attachments: [{ type: 'video', payload: { token: uploadToken } }],
  })
}

export async function sendDocumentFileToMax(
  token: string,
  chatId: string,
  filePath: string,
  caption: string,
  options?: { filename?: string; contentType?: string },
): Promise<void> {
  const buffer = await fs.readFile(filePath)
  const name = options?.filename ?? path.basename(filePath)
  const contentType = options?.contentType ?? 'application/octet-stream'
  const uploadToken = await uploadBufferToMax(token, 'file', buffer, name, contentType)
  await postMessage(token, chatId, {
    text: caption.substring(0, 1024) || '\u00a0',
    attachments: [{ type: 'file', payload: { token: uploadToken } }],
  })
}

export async function sendPhotoToMax(
  token: string,
  chatId: string,
  photoUrl: string,
  caption: string,
): Promise<void> {
  const response = await axios.get(photoUrl, { responseType: 'arraybuffer' })
  const buffer = Buffer.from(response.data)
  const uploadToken = await uploadBufferToMax(
    token,
    'image',
    buffer,
    'photo.jpg',
    'image/jpeg',
  )
  await postMessage(token, chatId, {
    text: caption.substring(0, 1024) || '\u00a0',
    attachments: [{ type: 'image', payload: { token: uploadToken } }],
  })
}

export async function sendVideoToMax(
  token: string,
  chatId: string,
  videoUrl: string,
  caption: string,
): Promise<void> {
  const response = await axios.get(videoUrl, { responseType: 'arraybuffer' })
  const buffer = Buffer.from(response.data)
  const name = guessFilenameFromUrl(videoUrl, 'video.mp4')
  const ext = path.extname(name).toLowerCase()
  const filename = ext === '.mp4' || ext === '.webm' || ext === '.mov' ? name : `${name}.mp4`
  const contentType =
    ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4'
  const uploadToken = await uploadBufferToMax(token, 'video', buffer, filename, contentType)
  await postMessage(token, chatId, {
    text: caption.substring(0, 1024) || '\u00a0',
    attachments: [{ type: 'video', payload: { token: uploadToken } }],
  })
}

export async function sendDocumentToMax(
  token: string,
  chatId: string,
  documentUrl: string,
  caption: string,
  options?: { filename?: string; contentType?: string },
): Promise<void> {
  const response = await axios.get(documentUrl, { responseType: 'arraybuffer' })
  const buffer = Buffer.from(response.data)
  const name = options?.filename ?? guessFilenameFromUrl(documentUrl, 'file.bin')
  const contentType = options?.contentType ?? 'application/octet-stream'
  const uploadToken = await uploadBufferToMax(token, 'file', buffer, name, contentType)
  await postMessage(token, chatId, {
    text: caption.substring(0, 1024) || '\u00a0',
    attachments: [{ type: 'file', payload: { token: uploadToken } }],
  })
}

function guessFilenameFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url)
    const base = path.basename(u.pathname)
    if (base && base !== '/' && base !== '') {
      return decodeURIComponent(base)
    }
  } catch {
    /* ignore */
  }
  return fallback
}
