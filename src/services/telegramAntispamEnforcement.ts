import { getChannelExtrasSync, restrictAntispamUser } from '../api/adminPanelState'
import type { AntispamEvaluation } from './antispamService'
import { callTelegramBotApi } from '../utils/telegramRateLimiter'
import { logger } from '../utils/logger'

/** Ограничение на время после обычного спама (удаление / флуд). */
export const TG_ANTISPAM_MUTE_SECONDS = 3600

/** Ограничение после бана (delete_and_ban, blacklist). */
export const TG_ANTISPAM_BAN_MUTE_SECONDS = 86_400

const MUTE_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
} as const

export interface TelegramAntispamEnforcementInput {
  token: string
  chatId: number
  messageId: number
  /** Telegram user id для restrictChatMember; null — только удаление. */
  telegramUserId: number | null
  channelChatId: number
  evaluation: AntispamEvaluation
}

function shouldDeleteMessage(evaluation: AntispamEvaluation): boolean {
  if (evaluation.outcome === 'block' || evaluation.outcome === 'ban') {
    return true
  }
  const action = evaluation.action
  return action === 'delete' || action === 'captcha' || action === 'delete_and_ban'
}

function shouldRestrictUser(evaluation: AntispamEvaluation, autoMute: boolean): boolean {
  if (!autoMute) {
    return false
  }
  if (evaluation.outcome === 'ban') {
    return true
  }
  return evaluation.action === 'delete_and_ban'
}

function muteDurationSeconds(evaluation: AntispamEvaluation): number {
  if (evaluation.outcome === 'ban' || evaluation.action === 'delete_and_ban') {
    return TG_ANTISPAM_BAN_MUTE_SECONDS
  }
  return TG_ANTISPAM_MUTE_SECONDS
}

async function deleteTelegramMessage(
  token: string,
  chatId: number,
  messageId: number,
): Promise<boolean> {
  const data = await callTelegramBotApi<{ ok: boolean; description?: string }>(
    token,
    'deleteMessage',
    { chat_id: chatId, message_id: messageId },
    { method: 'deleteMessage', chatId },
  )
  if (!data.ok) {
    logger.warn('[antispam/tg] deleteMessage failed', {
      chatId,
      messageId,
      description: data.description ?? null,
    })
    return false
  }
  return true
}

async function restrictTelegramUser(
  token: string,
  chatId: number,
  userId: number,
  durationSeconds: number,
): Promise<boolean> {
  const untilDate = Math.floor(Date.now() / 1000) + durationSeconds
  const data = await callTelegramBotApi<{ ok: boolean; description?: string }>(
    token,
    'restrictChatMember',
    {
      chat_id: chatId,
      user_id: userId,
      permissions: MUTE_PERMISSIONS,
      until_date: untilDate,
    },
    { method: 'restrictChatMember', chatId },
  )
  if (!data.ok) {
    logger.warn('[antispam/tg] restrictChatMember failed', {
      chatId,
      userId,
      untilDate,
      description: data.description ?? null,
    })
    return false
  }
  return true
}

/**
 * Удаляет спам-сообщение в TG-обсуждении и при необходимости ограничивает автора.
 */
export async function enforceTelegramAntispamAction(
  input: TelegramAntispamEnforcementInput,
): Promise<{ deleted: boolean; restricted: boolean }> {
  const { token, chatId, messageId, telegramUserId, channelChatId, evaluation } = input
  const extras = getChannelExtrasSync(channelChatId)

  let deleted = false
  let restricted = false

  if (shouldDeleteMessage(evaluation)) {
    deleted = await deleteTelegramMessage(token, chatId, messageId)
  }

  const restrict = shouldRestrictUser(evaluation, extras.auto_mute)
  if (restrict && telegramUserId != null && telegramUserId > 0) {
    const duration = muteDurationSeconds(evaluation)
    restricted = await restrictTelegramUser(token, chatId, telegramUserId, duration)
    if (restricted) {
      try {
        await restrictAntispamUser(telegramUserId)
      } catch (err: unknown) {
        logger.warn('[antispam/tg] restrictAntispamUser db failed', { telegramUserId, err })
      }
    }
  }

  logger.info('[antispam/tg] enforced', {
    chatId,
    messageId,
    telegramUserId,
    channelChatId,
    outcome: evaluation.outcome,
    action: evaluation.action,
    spamScore: evaluation.spamScore,
    deleted,
    restricted,
    autoMute: extras.auto_mute,
  })

  return { deleted, restricted }
}
