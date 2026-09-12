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
  /** Основной токен (первый кандидат на deleteMessage / restrict). */
  token: string
  /** Запасные токены, если у основного нет прав в группе обсуждения. */
  fallbackTokens?: string[]
  chatId: number
  messageId: number
  /** Telegram user id для restrictChatMember; null — только удаление. */
  telegramUserId: number | null
  channelChatId: number
  evaluation: AntispamEvaluation
}

function uniqueTokens(primary: string, fallbacks: string[] = []): string[] {
  const out: string[] = []
  for (const raw of [primary, ...fallbacks]) {
    const token = raw.trim()
    if (token && !out.includes(token)) {
      out.push(token)
    }
  }
  return out
}

function shouldDeleteMessage(evaluation: AntispamEvaluation): boolean {
  if (evaluation.outcome === 'block' || evaluation.outcome === 'ban') {
    return true
  }
  const action = evaluation.action
  return (
    action === 'delete' ||
    action === 'captcha' ||
    action === 'delete_and_ban' ||
    action === 'blacklist' ||
    action === 'restricted'
  )
}

function shouldRestrictUser(evaluation: AntispamEvaluation, autoMute: boolean): boolean {
  if (!autoMute) {
    return false
  }
  if (evaluation.outcome === 'ban' || evaluation.outcome === 'block') {
    return true
  }
  return (
    evaluation.action === 'delete' ||
    evaluation.action === 'captcha' ||
    evaluation.action === 'delete_and_ban' ||
    evaluation.action === 'blacklist' ||
    evaluation.action === 'restricted'
  )
}

function muteDurationSeconds(evaluation: AntispamEvaluation): number {
  if (
    evaluation.outcome === 'ban' ||
    evaluation.action === 'delete_and_ban' ||
    evaluation.action === 'blacklist' ||
    evaluation.action === 'restricted'
  ) {
    return TG_ANTISPAM_BAN_MUTE_SECONDS
  }
  return TG_ANTISPAM_MUTE_SECONDS
}

function isMessageAlreadyGone(description?: string): boolean {
  const text = (description ?? '').toLowerCase()
  return (
    text.includes('message to delete not found') ||
    text.includes('message not found') ||
    text.includes('message_id_invalid')
  )
}

async function deleteTelegramMessage(
  token: string,
  chatId: number,
  messageId: number,
): Promise<'deleted' | 'gone' | 'failed'> {
  const data = await callTelegramBotApi<{ ok: boolean; description?: string }>(
    token,
    'deleteMessage',
    { chat_id: chatId, message_id: messageId },
    { method: 'deleteMessage', chatId },
  )
  if (data.ok) {
    return 'deleted'
  }
  if (isMessageAlreadyGone(data.description)) {
    return 'gone'
  }
  logger.warn('[antispam/tg] deleteMessage failed', {
    chatId,
    messageId,
    description: data.description ?? null,
  })
  return 'failed'
}

async function deleteTelegramMessageWithFallbacks(
  tokens: string[],
  chatId: number,
  messageId: number,
): Promise<{ deleted: boolean; tokenUsed: string | null }> {
  let lastToken: string | null = null
  for (const token of tokens) {
    lastToken = token
    try {
      const result = await deleteTelegramMessage(token, chatId, messageId)
      if (result === 'deleted' || result === 'gone') {
        return { deleted: true, tokenUsed: token }
      }
    } catch (err: unknown) {
      logger.warn('[antispam/tg] deleteMessage threw', { chatId, messageId, err })
    }
  }
  logger.warn('[antispam/tg] deleteMessage exhausted tokens', {
    chatId,
    messageId,
    tokenCount: tokens.length,
    lastTokenHint: lastToken ? `${lastToken.slice(0, 8)}…` : null,
  })
  return { deleted: false, tokenUsed: null }
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

async function restrictTelegramUserWithFallbacks(
  tokens: string[],
  chatId: number,
  userId: number,
  durationSeconds: number,
  preferredToken: string | null,
): Promise<boolean> {
  const ordered = preferredToken
    ? uniqueTokens(preferredToken, tokens)
    : tokens
  for (const token of ordered) {
    try {
      if (await restrictTelegramUser(token, chatId, userId, durationSeconds)) {
        return true
      }
    } catch (err: unknown) {
      logger.warn('[antispam/tg] restrictChatMember threw', { chatId, userId, err })
    }
  }
  return false
}

/**
 * Удаляет спам-сообщение в TG-обсуждении и при необходимости ограничивает автора.
 */
export async function enforceTelegramAntispamAction(
  input: TelegramAntispamEnforcementInput,
): Promise<{ deleted: boolean; restricted: boolean }> {
  const { token, fallbackTokens, chatId, messageId, telegramUserId, channelChatId, evaluation } =
    input
  const extras = getChannelExtrasSync(channelChatId)
  const tokens = uniqueTokens(token, fallbackTokens ?? [])

  let deleted = false
  let restricted = false
  let tokenUsed: string | null = null

  if (shouldDeleteMessage(evaluation)) {
    const result = await deleteTelegramMessageWithFallbacks(tokens, chatId, messageId)
    deleted = result.deleted
    tokenUsed = result.tokenUsed
  }

  const restrict = shouldRestrictUser(evaluation, extras.auto_mute)
  if (restrict && telegramUserId != null && telegramUserId > 0) {
    const duration = muteDurationSeconds(evaluation)
    restricted = await restrictTelegramUserWithFallbacks(
      tokens,
      chatId,
      telegramUserId,
      duration,
      tokenUsed,
    )
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
    tokenCount: tokens.length,
  })

  return { deleted, restricted }
}
