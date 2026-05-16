import { config } from '../config'
import { logger } from './logger'

const MAX_START_PAYLOAD_LENGTH = 128

export interface ParsedPayload {
  type: string
  id: string
}

export function generateDeeplink(payload: string, botNickname?: string): string {
  if (payload.length > MAX_START_PAYLOAD_LENGTH) {
    throw new Error(
      `payload не может быть длиннее ${MAX_START_PAYLOAD_LENGTH} символов (сейчас ${payload.length})`,
    )
  }

  const nick = (botNickname ?? config.botNickname).replace(/^@/, '').trim()
  const url = `https://max.ru/${nick}?start=${encodeURIComponent(payload)}`

  logger.debug('Сгенерирован deeplink MAX', {
    botNickname: nick,
    payloadLength: payload.length,
  })

  return url
}

export function parsePayload(payload: string | null): ParsedPayload | null {
  if (payload === null) {
    return null
  }

  const underscore = payload.indexOf('_')
  if (underscore <= 0 || underscore === payload.length - 1) {
    return null
  }

  const type = payload.slice(0, underscore)
  const id = payload.slice(underscore + 1)

  if (type === '' || id === '') {
    return null
  }

  return { type, id }
}

/** Opens bot chat (not Mini App) with admin invite payload `join<abs(channelChatId)>`. */
export function buildBotJoinUrl(channelChatId: number, botNickname?: string): string {
  return generateDeeplink(`join${Math.abs(channelChatId)}`, botNickname)
}
