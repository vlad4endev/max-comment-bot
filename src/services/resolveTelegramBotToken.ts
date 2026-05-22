import { getTelegramToken } from '../config'
import { integrationsStore } from './integrationsStore'

/** Токен основного CommentBot в Telegram (integrations или TG_TOKEN). */
export function resolveTelegramBotToken(): string {
  const integ = integrationsStore.getTelegramIntegration()
  const fromInteg = integ?.token?.trim() ?? ''
  if (fromInteg) {
    return fromInteg
  }
  return getTelegramToken().trim()
}

export function isMainTelegramBotToken(token: string): boolean {
  const main = resolveTelegramBotToken()
  if (!main) {
    return false
  }
  return token.trim() === main
}
