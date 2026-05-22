import { isMainTelegramBotToken } from './resolveTelegramBotToken'
import { logger } from '../utils/logger'

/** Обработка my_chat_member для основного TG-бота (активация канала, DM с подтверждением). */
export async function processMainTelegramBotMyChatMemberUpdate(
  token: string,
  update: Record<string, unknown>,
): Promise<void> {
  if (!update.my_chat_member || !isMainTelegramBotToken(token)) {
    return
  }
  try {
    const { handleTelegramMyChatMemberUpdate } = await import('./telegramChannelActivation')
    await handleTelegramMyChatMemberUpdate(update)
  } catch (err: unknown) {
    logger.error('processMainTelegramBotMyChatMemberUpdate failed', { err })
  }
}
