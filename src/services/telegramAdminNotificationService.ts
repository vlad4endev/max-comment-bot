import axios from 'axios'

import { getTelegramToken } from '../config'
import { logger } from '../utils/logger'
import { integrationsStore } from './integrationsStore'
import { listTelegramChatAdministrators } from './integrationPlatformClient'
import { buildTelegramMiniappUrl } from './telegramMiniappAuth'
import { buildTelegramOpenPanelButton } from '../utils/telegramMiniAppUrl'

const TG_API = 'https://api.telegram.org'

function preview80(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length <= 80) {
    return t
  }
  return `${t.slice(0, 80)}…`
}

function resolveTelegramSourceChannelsForMaxChat(maxChatId: number): string[] {
  const targetAbs = Math.abs(maxChatId)
  const out = new Set<string>()
  for (const flow of integrationsStore.getFlows()) {
    if (!flow.enabled) {
      continue
    }
    if (flow.source.platform !== 'telegram' || flow.destination.platform !== 'max') {
      continue
    }
    const dest = Number.parseInt(flow.destination.channelId, 10)
    if (!Number.isFinite(dest) || Math.abs(dest) !== targetAbs) {
      continue
    }
    const sourceChannel = flow.source.channelId?.trim() || flow.source.channelUsername?.trim() || ''
    if (sourceChannel !== '') {
      out.add(sourceChannel)
    }
  }
  return [...out]
}

async function tgSendMessage(
  token: string,
  chatId: number,
  text: string,
  miniAppUrl: string,
): Promise<void> {
  const openBtn = buildTelegramOpenPanelButton(miniAppUrl)
  await axios.post(
    `${TG_API}/bot${token}/sendMessage`,
    {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [[openBtn]],
      },
    },
    { timeout: 20_000 },
  )
}

export async function notifyTelegramAdminsNewMiniappComment(input: {
  commentId: string
  maxChannelChatId: number
  postText: string
  channelTitle: string
  username: string
  commentText: string
  commentPhotoUrls?: string[]
  postId: string
  messageMid?: string
}): Promise<void> {
  await integrationsStore.load()
  const token = getTelegramToken()
  if (!token) {
    return
  }
  const targetChannels = resolveTelegramSourceChannelsForMaxChat(input.maxChannelChatId)
  if (targetChannels.length === 0) {
    return
  }
  const postExcerpt = preview80(input.postText)
  const textPart = input.commentText.trim()
  const photoCount = Array.isArray(input.commentPhotoUrls) ? input.commentPhotoUrls.length : 0
  const commentPreview =
    textPart !== ''
      ? textPart
      : photoCount > 0
        ? `📷 Фото: ${photoCount}`
        : 'без текста'
  const photoSuffix = photoCount > 0 ? `\n📷 Фото: ${photoCount}` : ''
  const message = `📌 Новый комментарий
Пост: «${postExcerpt}»
Канал: ${input.channelTitle}
👤 ${input.username}: ${commentPreview}${photoSuffix}`

  for (const tgChannelId of targetChannels) {
    const admins = await listTelegramChatAdministrators(token, tgChannelId)
    const recipients = admins.filter((a) => a.startedBot).map((a) => a.userId)
    for (const recipientId of recipients) {
      const url = buildTelegramMiniappUrl({
        postId: input.postId,
        maxChatId: input.maxChannelChatId,
        messageMid: input.messageMid,
        telegramUserId: recipientId,
      })
      if (!url) {
        logger.warn('notifyTelegramAdminsNewMiniappComment: MINI_APP_URL не задан, TG-кнопка пропущена', {
          commentId: input.commentId,
          recipientId,
        })
        continue
      }
      try {
        await tgSendMessage(token, recipientId, message, url)
      } catch (err: unknown) {
        logger.warn('notifyTelegramAdminsNewMiniappComment: sendMessage failed', {
          commentId: input.commentId,
          recipientId,
          tgChannelId,
          err,
        })
      }
    }
  }
}
