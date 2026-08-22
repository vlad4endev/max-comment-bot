/**
 * Классификация ошибок Telegram Bot API и MTProto для синхронизации комментариев.
 */

import axios from 'axios'

export interface TelegramAxiosResponseBody {
  ok: boolean
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
  result?: unknown
}

/** Разбирает тело ответа Telegram из axios-ошибки (HTTP 4xx с JSON `{ ok: false }`). */
export function parseTelegramAxiosResponseBody(err: unknown): TelegramAxiosResponseBody | null {
  if (!axios.isAxiosError(err)) {
    return null
  }
  const data = err.response?.data
  if (typeof data !== 'object' || data === null || !('ok' in data)) {
    return null
  }
  return data as TelegramAxiosResponseBody
}

export function extractTelegramErrorText(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data
    if (typeof data === 'object' && data !== null) {
      if ('description' in data) {
        const description = String((data as { description?: string }).description || '').trim()
        if (description) {
          return description
        }
      }
      if ('error' in data) {
        const nested = (data as { error?: { message?: string } }).error?.message
        if (typeof nested === 'string' && nested.trim()) {
          return nested.trim()
        }
      }
    }
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim()
  }
  if (typeof err === 'object' && err !== null) {
    if ('errorMessage' in err) {
      const rpc = String((err as { errorMessage?: string }).errorMessage || '').trim()
      if (rpc) {
        return rpc
      }
    }
    if ('description' in err) {
      const description = String((err as { description?: string }).description || '').trim()
      if (description) {
        return description
      }
    }
  }
  return String(err ?? '')
}

export function isInvalidTelegramMessageIdError(text: string): boolean {
  const normalized = text.toUpperCase()
  return (
    normalized.includes('MSG_ID_INVALID') ||
    normalized.includes('MESSAGE_ID_INVALID') ||
    normalized.includes('MESSAGE TO REPLY NOT FOUND') ||
    normalized.includes('MESSAGE THREAD NOT FOUND') ||
    normalized.includes('REPLY MESSAGE NOT FOUND') ||
    normalized.includes('MESSAGE NOT FOUND')
  )
}

export function isSendAsPeerInvalidError(text: string): boolean {
  const normalized = text.toUpperCase()
  return (
    normalized.includes('SEND_AS_PEER_INVALID') ||
    normalized.includes('PEER_ID_INVALID') ||
    normalized.includes('USER_BANNED_IN_CHANNEL')
  )
}

export function isTelegramUnauthorizedError(text: string): boolean {
  const normalized = text.toUpperCase()
  return (
    normalized.includes('UNAUTHORIZED') ||
    normalized.includes('401') ||
    normalized.includes('WRONG REMOTE ID') ||
    normalized.includes('TOKEN IS INVALID') ||
    normalized.includes('BOT TOKEN')
  )
}

export function isTelegramForbiddenError(text: string): boolean {
  const normalized = text.toUpperCase()
  if (isTelegramUnauthorizedError(normalized)) {
    return false
  }
  return (
    normalized.includes('FORBIDDEN') ||
    normalized.includes('BOT WAS BLOCKED') ||
    normalized.includes('BOT IS NOT A MEMBER') ||
    normalized.includes('CHAT_WRITE_FORBIDDEN') ||
    normalized.includes('NOT ENOUGH RIGHTS') ||
    normalized.includes('403')
  )
}

export function suggestActionForTelegramSyncError(text: string): string {
  if (isTelegramUnauthorizedError(text)) {
    return 'Токен Telegram бота недействителен. Обновите TG_TOKEN в интеграциях или @BotFather и перезапустите сервис.'
  }
  if (isInvalidTelegramMessageIdError(text)) {
    return 'Проверьте, что у поста в канале есть связанный тред в группе обсуждений. Запустите repair-threads в админке.'
  }
  if (isSendAsPeerInvalidError(text)) {
    return 'Бот/сессия не может писать от имени канала. Проверьте права администратора или переключите tg_discussion_send_as на chat.'
  }
  if (isTelegramForbiddenError(text)) {
    return 'Проверьте токен бота и добавьте бота в канал и группу обсуждений с правами администратора.'
  }
  return 'Проверьте логи и настройки цепочки TG→MAX.'
}
