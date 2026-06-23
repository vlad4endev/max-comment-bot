/** Токен отдельного Telegram-бота только для антиспама в группах обсуждений. */
export function resolveTelegramAntispamBotToken(): string {
  return (process.env.TG_ANTISPAM_BOT_TOKEN ?? '').trim()
}

export function isTelegramAntispamBotConfigured(): boolean {
  return resolveTelegramAntispamBotToken().length > 0
}
