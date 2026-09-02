import { createHash } from 'node:crypto'

import dotenv from 'dotenv'

import { logger } from './utils/logger'
import { deriveMiniAppUrlFromWebhook, normalizeMiniAppUrl } from './utils/telegramMiniAppUrl'

dotenv.config()

export type ReceiveMode = 'webhook' | 'polling'

function computeAdminToken(ownerUserId: number, botToken: string): string {
  return createHash('sha256')
    .update(`${ownerUserId}${botToken}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
}

/** Токен Telegram-бота (из `.env`, синхронизируется из админ-панели). */
export function getTelegramToken(): string {
  return (process.env.TG_TOKEN ?? process.env.TELEGRAM_TOKEN ?? process.env.TG_BOT_TOKEN ?? '')
    .trim()
}

/** Интервал опроса TG→MAX потоков (мс). По умолчанию 5_000, минимум 2_000. */
export function getFlowPollIntervalMs(): number {
  const raw = (process.env.FLOW_POLL_INTERVAL_MS ?? '').trim()
  if (raw === '') return 5_000
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 2_000) return 5_000
  return Math.min(parsed, 300_000)
}

export interface Config {
  BOT_TOKEN: string
  /**
   * Отдельный токен Telegram-бота только для чтения channel_post (пересылка TG→MAX).
   * Не путать с {@link Config.TG_TOKEN}.
   */
  tgReaderToken: string
  /** Отдельный TG-бот только для антиспама в группах обсуждений. */
  tgAntispamToken: string
  /** Опционально: TG_TOKEN из .env (дублирует getTelegramToken на старте). */
  TG_TOKEN: string
  /**
   * Единственный владелец панели /admin (числовой user_id в MAX).
   */
  ownerUserId: number
  /**
   * Первые 16 hex-символов sha256(ownerUserId + BOT_TOKEN) — устаревший токен (совместимость).
   */
  adminToken: string
  /** Логин веб-панели `/admin` (переопределяется `ADMIN_PANEL_USER`). */
  adminPanelUser: string
  /** Пароль веб-панели (переопределяется `ADMIN_PANEL_PASSWORD`). */
  adminPanelPassword: string
  /** Секрет подписи cookie сессии панели (`ADMIN_PANEL_SESSION_SECRET` или производное от BOT_TOKEN). */
  adminPanelSessionSecret: string
  ADMIN_CHAT_ID: number
  BOT_NICKNAME: string;
  /**
   * Никнейм без @ для deep link MAX: `https://max.ru/<botNickname>?startapp=…`.
   */
  botNickname: string;
  NODE_ENV: 'development' | 'production';
  PORT: number;
  /**
   * Порт HTTP (webhook + /api + /static). Если задан API_PORT — используется он, иначе PORT.
   */
  listenPort: number;
  /**
   * Legacy: прямой URL мини-приложения с query (`post_id`, `chat_id`). Используется только если не удалось собрать ссылку через {@link Config.botNickname}.
   */
  miniAppUrl?: string;
  receiveMode: ReceiveMode;
  /** Только для webhook-режима */
  webhookUrl?: string;
  /** pathname из `webhookUrl` (например `/webhook`) */
  webhookPath?: string;
  /** Проверка заголовка `X-Max-Bot-Api-Secret` (рекомендуется MAX) */
  webhookSecret?: string;
}

const WEBHOOK_SECRET_RE = /^[a-zA-Z0-9_-]{5,256}$/;

function parseReceiveMode(
  raw: string | undefined,
  nodeEnv: Config['NODE_ENV'],
): ReceiveMode {
  const v = raw?.trim().toLowerCase();
  if (v === 'webhook' || v === 'polling') {
    return v;
  }
  return nodeEnv === 'production' ? 'webhook' : 'polling';
}

function getConfig(): Config {
  const BOT_TOKEN = (process.env.BOT_TOKEN ?? '').trim()
  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN не установлен')
  }

  const adminPanelUserFromEnv = (process.env.ADMIN_PANEL_USER ?? '').trim()
  const adminPanelPasswordFromEnv = (process.env.ADMIN_PANEL_PASSWORD ?? '').trim()
  const adminPanelUser = (adminPanelUserFromEnv || 'vladislav4endev').trim()
  const adminPanelPassword = (adminPanelPasswordFromEnv || 'v902l733a00d94%').trim()
  const adminPanelSessionSecretRaw = (process.env.ADMIN_PANEL_SESSION_SECRET ?? '').trim()
  const adminPanelSessionSecret =
    adminPanelSessionSecretRaw !== ''
      ? adminPanelSessionSecretRaw
      : createHash('sha256').update(`${BOT_TOKEN}|admin_panel_session|v1`, 'utf8').digest('hex')

  const NODE_ENV_EARLY: Config['NODE_ENV'] =
    process.env.NODE_ENV === 'production' ? 'production' : 'development'
  if (NODE_ENV_EARLY === 'production') {
    if (!adminPanelUserFromEnv || !adminPanelPasswordFromEnv) {
      logger.error(
        'ADMIN_PANEL_USER / ADMIN_PANEL_PASSWORD не заданы в env — используются встроенные значения по умолчанию. Задайте их явно в .env (логин не сломается, если скопируете те же значения).',
      )
    }
    if (!adminPanelSessionSecretRaw) {
      logger.warn(
        'ADMIN_PANEL_SESSION_SECRET не задан — cookie сессии выводится из BOT_TOKEN. Рекомендуется отдельный секрет.',
      )
    }
  }

  const ownerUserIdRaw = (process.env.OWNER_USER_ID ?? '122099994').trim()
  const ownerParsed = Number(ownerUserIdRaw)
  if (!Number.isFinite(ownerParsed) || !Number.isInteger(ownerParsed) || ownerParsed <= 0) {
    throw new Error('OWNER_USER_ID должен быть положительным целым числом')
  }

  const adminChatIdRaw = (process.env.ADMIN_CHAT_ID ?? '').trim()
  if (adminChatIdRaw === '') {
    throw new Error('ADMIN_CHAT_ID должен быть числом');
  }
  const adminParsed = Number(adminChatIdRaw);
  if (!Number.isFinite(adminParsed) || !Number.isInteger(adminParsed)) {
    throw new Error('ADMIN_CHAT_ID должен быть числом');
  }

  const BOT_NICKNAME = (process.env.BOT_NICKNAME ?? '').trim();
  if (!BOT_NICKNAME) {
    throw new Error('BOT_NICKNAME не установлен');
  }
  const botNickname = BOT_NICKNAME.replace(/^@/, '').trim();

  const NODE_ENV: Config['NODE_ENV'] =
    process.env.NODE_ENV === 'production' ? 'production' : 'development';

  const portRaw = process.env.PORT;
  let PORT = 3000;
  if (portRaw !== undefined && portRaw !== '') {
    const parsed = Number.parseInt(portRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      PORT = parsed;
    }
  }

  const receiveMode = parseReceiveMode(process.env.MAX_RECEIVE_MODE, NODE_ENV);

  const miniAppUrlRaw = (process.env.MINI_APP_URL ?? '').trim();
  let miniAppUrl = normalizeMiniAppUrl(miniAppUrlRaw);
  const webhookUrlEarly = (process.env.WEBHOOK_URL ?? '').trim();
  if (!miniAppUrl && webhookUrlEarly.startsWith('https://')) {
    miniAppUrl = deriveMiniAppUrlFromWebhook(webhookUrlEarly);
  }

  const apiPortRaw = (process.env.API_PORT ?? '').trim();
  let listenPort = PORT;
  if (apiPortRaw !== '') {
    const apiParsed = Number.parseInt(apiPortRaw, 10);
    if (Number.isFinite(apiParsed) && apiParsed > 0) {
      listenPort = apiParsed;
    }
  }

  const TG_TOKEN = getTelegramToken()

  const base: Config = {
    BOT_TOKEN,
    tgReaderToken: process.env.TG_READER_BOT_TOKEN || '',
    tgAntispamToken: process.env.TG_ANTISPAM_BOT_TOKEN || '',
    TG_TOKEN,
    ownerUserId: ownerParsed,
    adminToken: computeAdminToken(ownerParsed, BOT_TOKEN),
    adminPanelUser,
    adminPanelPassword,
    adminPanelSessionSecret,
    ADMIN_CHAT_ID: adminParsed,
    BOT_NICKNAME,
    botNickname,
    NODE_ENV,
    PORT,
    listenPort,
    miniAppUrl,
    receiveMode,
  };

  if (receiveMode === 'polling') {
    return base;
  }

  const webhookUrl = (process.env.WEBHOOK_URL ?? '').trim();
  if (!webhookUrl.startsWith('https://')) {
    throw new Error(
      'В режиме webhook задайте WEBHOOK_URL — полный HTTPS-адрес (как в POST /subscriptions), например https://bot.example.com/webhook',
    );
  }

  let webhookPath: string;
  try {
    const u = new URL(webhookUrl);
    webhookPath = u.pathname && u.pathname !== '' ? u.pathname : '/';
  } catch {
    throw new Error('WEBHOOK_URL не является корректным URL');
  }

  const secretRaw = (process.env.WEBHOOK_SECRET ?? '').trim();
  const webhookSecret = secretRaw === '' ? undefined : secretRaw;

  if (NODE_ENV === 'production') {
    if (!webhookSecret || !WEBHOOK_SECRET_RE.test(webhookSecret)) {
      throw new Error(
        'В production для webhook задайте WEBHOOK_SECRET (5–256 символов: латиница, цифры, _ и -), см. документацию POST /subscriptions',
      );
    }
  } else if (webhookSecret && !WEBHOOK_SECRET_RE.test(webhookSecret)) {
    throw new Error(
      'WEBHOOK_SECRET должен быть 5–256 символов: латиница, цифры, _ и -',
    );
  }

  if (!webhookSecret) {
    logger.warn(
      'WEBHOOK_SECRET не задан: заголовок X-Max-Bot-Api-Secret проверяться не будет (только для разработки).',
    );
  }

  return {
    ...base,
    webhookUrl,
    webhookPath,
    webhookSecret,
  };
}

export const config = getConfig();
