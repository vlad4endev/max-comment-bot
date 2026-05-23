import { logger } from './logger'

const TELEGRAM_HOST_SUFFIXES = ['t.me', 'telegram.me', 'telegram.dog']

/** URL, который Telegram принимает для Web App (HTTPS, не t.me, не localhost/LAN). */
export function isTelegramWebAppUrl(url: string): boolean {
  try {
    const u = new URL(url.trim())
    if (u.protocol !== 'https:') {
      return false
    }
    const host = u.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return false
    }
    if (
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)
    ) {
      return false
    }
    for (const suffix of TELEGRAM_HOST_SUFFIXES) {
      if (host === suffix || host.endsWith(`.${suffix}`)) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

export function isPrivateOrLocalMiniAppHost(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return true
    }
    return (
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)
    )
  } catch {
    return false
  }
}

/** Собрать `https://домен/miniapp` из `WEBHOOK_URL`, если `MINI_APP_URL` не задан. */
export function deriveMiniAppUrlFromWebhook(webhookUrl: string): string | undefined {
  const trimmed = webhookUrl.trim()
  if (!trimmed.startsWith('https://')) {
    return undefined
  }
  try {
    const u = new URL(trimmed)
    u.pathname = '/miniapp'
    u.search = ''
    u.hash = ''
    const out = u.toString().replace(/\/+$/, '')
    return isTelegramWebAppUrl(out) ? out : undefined
  } catch {
    return undefined
  }
}

export function normalizeMiniAppUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return undefined
  }
  return trimmed.replace(/\/+$/, '')
}

export type TelegramOpenPanelButton =
  | { text: string; web_app: { url: string } }
  | { text: string; url: string }

/** Кнопка «Открыть панель»: Web App только для валидного HTTPS URL, иначе ссылка на бота. */
export function buildTelegramOpenPanelButton(
  homeUrl: string | null | undefined,
  botUsername = 'commentvmax_bot',
): TelegramOpenPanelButton {
  const fallback = `https://t.me/${botUsername.replace(/^@/, '')}`
  const candidate = (homeUrl ?? '').trim()
  if (candidate && isTelegramWebAppUrl(candidate)) {
    try {
      const url = new URL(candidate)
      if (!url.searchParams.has('platform')) {
        url.searchParams.set('platform', 'telegram')
      }
      return { text: '🚀 Открыть панель', web_app: { url: url.toString().replace(/\/+$/, '') } }
    } catch {
      return { text: '🚀 Открыть панель', web_app: { url: candidate } }
    }
  }
  const link = candidate && /^https?:\/\//i.test(candidate) ? candidate : fallback
  return { text: '🚀 Открыть панель', url: link }
}

/** Публичный HTTPS URL мини-приложения (MAX и Telegram Web App). */
export function isPublicHttpsMiniAppUrl(url: string): boolean {
  return isTelegramWebAppUrl(url)
}

/** Предупреждения при старте: LAN/HTTP URL не откроются с мобильного интернета. */
export function logMiniAppUrlDiagnostics(
  miniAppUrl: string | undefined,
  botNickname: string,
): void {
  const raw = (process.env.MINI_APP_URL ?? '').trim()
  if (raw && !isPublicHttpsMiniAppUrl(raw)) {
    logger.warn(
      'MINI_APP_URL не подходит для Mini App (нужен публичный HTTPS, не t.me и не LAN). С Wi‑Fi может «работать», с мобильного интернета — нет.',
      { miniAppUrl: raw },
    )
  }
  if (raw && isPrivateOrLocalMiniAppHost(raw)) {
    logger.warn(
      'MINI_APP_URL указывает на localhost/LAN — мини-приложение откроется только в локальной сети, не через мобильный интернет.',
      { miniAppUrl: raw },
    )
  }
  const nick = botNickname.trim()
  if (!nick) {
    logger.warn(
      'BOT_NICKNAME не задан — кнопки MAX (startapp) и deep link не откроют мини-приложение. Задайте BOT_NICKNAME в .env.',
    )
  }
  if (miniAppUrl && isPublicHttpsMiniAppUrl(miniAppUrl)) {
    logger.info('Mini App URL (MAX / Telegram)', {
      miniAppUrl,
      botNickname: nick || null,
      maxDeepLinkExample: nick ? `https://max.ru/${nick}?startapp` : null,
    })
    return
  }
  logger.warn(
    'Mini App URL не настроен: задайте MINI_APP_URL=https://ваш-домен/miniapp (публичный HTTPS) или WEBHOOK_URL для автоподстановки. Тот же URL укажите в панели MAX (dev.max.ru) и в BotFather для Telegram.',
  )
}

/** @deprecated Используйте {@link logMiniAppUrlDiagnostics}. */
export function logTelegramMiniAppUrlDiagnostics(miniAppUrl: string | undefined): void {
  logMiniAppUrlDiagnostics(miniAppUrl, (process.env.BOT_NICKNAME ?? '').trim())
}
