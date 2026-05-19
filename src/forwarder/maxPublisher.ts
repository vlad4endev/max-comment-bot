import path from 'node:path'

import axios from 'axios'
import FormData from 'form-data'

const MAX_API = 'https://botapi.max.ru'

export async function sendTextToMax(token: string, chatId: string, text: string): Promise<void> {
  await axios.post(`${MAX_API}/messages/sendMessage`, {
    token,
    chat_id: chatId,
    text: text.substring(0, 4096),
  })
}

export async function sendPhotoToMax(
  token: string,
  chatId: string,
  photoUrl: string,
  caption: string,
): Promise<void> {
  // Download photo from Telegram
  const response = await axios.get(photoUrl, { responseType: 'arraybuffer' })
  const buffer = Buffer.from(response.data)

  const form = new FormData()
  form.append('token', token)
  form.append('chat_id', chatId)
  form.append('caption', caption.substring(0, 1024))
  form.append('photo', buffer, { filename: 'photo.jpg', contentType: 'image/jpeg' })

  await axios.post(`${MAX_API}/messages/sendPhoto`, form, {
    headers: form.getHeaders(),
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

  const form = new FormData()
  form.append('token', token)
  form.append('chat_id', chatId)
  form.append('caption', caption.substring(0, 1024))
  form.append('video', buffer, { filename, contentType })

  await axios.post(`${MAX_API}/messages/sendVideo`, form, {
    headers: form.getHeaders(),
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

  const form = new FormData()
  form.append('token', token)
  form.append('chat_id', chatId)
  form.append('caption', caption.substring(0, 1024))
  form.append('document', buffer, { filename: name, contentType })

  await axios.post(`${MAX_API}/messages/sendDocument`, form, {
    headers: form.getHeaders(),
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
