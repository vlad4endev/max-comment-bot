/**
 * Классификация ошибок Telegram Bot API и MTProto для синхронизации комментариев.
 */

export function extractTelegramErrorText(err: unknown): string {
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

export function isTelegramForbiddenError(text: string): boolean {
  const normalized = text.toUpperCase()
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
