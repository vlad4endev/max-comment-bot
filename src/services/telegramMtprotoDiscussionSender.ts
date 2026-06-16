/**
 * Отправка комментариев в TG-обсуждение от имени канала или чата (sendAs).
 * Bot API не умеет публиковать от канала/чата — только MTProto user-сессия.
 */

import { Api } from 'telegram'
import { generateRandomLong } from 'telegram/Helpers'

import { logger } from '../utils/logger'
import {
  connectTelegramUserClient,
  resolveTelegramChannelEntity,
  telegramUserArchiveConfigured,
} from './telegramUserArchive'

export type DiscussionSendAsMode = 'channel' | 'chat'

export function mtprotoDiscussionSenderConfigured(): boolean {
  return telegramUserArchiveConfigured()
}

function extractMessageIdFromUpdates(updates: Api.TypeUpdates): number | null {
  if (updates instanceof Api.UpdateShortSentMessage) {
    return updates.id
  }
  if (updates instanceof Api.Updates || updates instanceof Api.UpdatesCombined) {
    for (const update of updates.updates) {
      if (
        update instanceof Api.UpdateNewMessage ||
        update instanceof Api.UpdateNewChannelMessage
      ) {
        const msg = update.message
        if (msg instanceof Api.Message && typeof msg.id === 'number') {
          return msg.id
        }
      }
    }
  }
  return null
}

/**
 * Публикует сообщение в чат обсуждений от имени канала или самой группы обсуждений.
 *
 * - `channel` — подпись канала (как «ответ от канала» в комментариях)
 * - `chat` — от имени группы обсуждений (как «анонимный админ» в TG)
 */
export async function sendDiscussionMessageAsPeer(
  mode: DiscussionSendAsMode,
  discussionChatId: number,
  channelKey: string | null,
  text: string,
  replyToMessageId: number,
): Promise<number | null> {
  if (!telegramUserArchiveConfigured()) {
    return null
  }

  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }

  const client = await connectTelegramUserClient()
  try {
    const discussionPeer = await client.getInputEntity(discussionChatId)
    let sendAsPeer = discussionPeer
    if (mode === 'channel') {
      if (!channelKey) {
        return null
      }
      const channelEntity = await resolveTelegramChannelEntity(client, channelKey)
      sendAsPeer = await client.getInputEntity(channelEntity)
    }

    const updates = await client.invoke(
      new Api.messages.SendMessage({
        peer: discussionPeer,
        message: trimmed,
        replyTo: new Api.InputReplyToMessage({ replyToMsgId: replyToMessageId }),
        randomId: generateRandomLong(),
        sendAs: sendAsPeer,
      }),
    )

    const messageId = extractMessageIdFromUpdates(updates)
    if (messageId != null) {
      logger.info('[telegramMtprotoDiscussionSender] sent with sendAs', {
        mode,
        discussionChatId,
        channelKey,
        replyToMessageId,
        messageId,
      })
    }
    return messageId
  } finally {
    await client.disconnect()
  }
}

/** @deprecated используйте sendDiscussionMessageAsPeer */
export async function sendDiscussionMessageAsChannel(
  discussionChatId: number,
  channelKey: string,
  text: string,
  replyToMessageId: number,
): Promise<number | null> {
  return sendDiscussionMessageAsPeer(
    'channel',
    discussionChatId,
    channelKey,
    text,
    replyToMessageId,
  )
}
