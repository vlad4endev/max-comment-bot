"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
exports.getTelegramToken = getTelegramToken;
exports.getFlowPollIntervalMs = getFlowPollIntervalMs;
const node_crypto_1 = require("node:crypto");
const dotenv_1 = __importDefault(require("dotenv"));
const logger_1 = require("./utils/logger");
const telegramMiniAppUrl_1 = require("./utils/telegramMiniAppUrl");
dotenv_1.default.config();
function computeAdminToken(ownerUserId, botToken) {
    return (0, node_crypto_1.createHash)('sha256')
        .update(`${ownerUserId}${botToken}`, 'utf8')
        .digest('hex')
        .slice(0, 16);
}
/** Токен Telegram-бота (из `.env`, синхронизируется из админ-панели). */
function getTelegramToken() {
    return (process.env.TG_TOKEN ?? process.env.TELEGRAM_TOKEN ?? process.env.TG_BOT_TOKEN ?? '')
        .trim();
}
/** Интервал опроса TG→MAX потоков (мс). По умолчанию 60_000, минимум 5_000. */
function getFlowPollIntervalMs() {
    const raw = (process.env.FLOW_POLL_INTERVAL_MS ?? '').trim();
    if (raw === '')
        return 60_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000)
        return 60_000;
    return Math.min(parsed, 300_000);
}
const WEBHOOK_SECRET_RE = /^[a-zA-Z0-9_-]{5,256}$/;
function parseReceiveMode(raw, nodeEnv) {
    const v = raw?.trim().toLowerCase();
    if (v === 'webhook' || v === 'polling') {
        return v;
    }
    return nodeEnv === 'production' ? 'webhook' : 'polling';
}
function getConfig() {
    const BOT_TOKEN = (process.env.BOT_TOKEN ?? '').trim();
    if (!BOT_TOKEN) {
        throw new Error('BOT_TOKEN не установлен');
    }
    const adminPanelUser = (process.env.ADMIN_PANEL_USER ?? 'vladislav4endev').trim();
    const adminPanelPassword = (process.env.ADMIN_PANEL_PASSWORD ?? 'v902l733a00d94%').trim();
    const adminPanelSessionSecretRaw = (process.env.ADMIN_PANEL_SESSION_SECRET ?? '').trim();
    const adminPanelSessionSecret = adminPanelSessionSecretRaw !== ''
        ? adminPanelSessionSecretRaw
        : (0, node_crypto_1.createHash)('sha256').update(`${BOT_TOKEN}|admin_panel_session|v1`, 'utf8').digest('hex');
    const ownerUserIdRaw = (process.env.OWNER_USER_ID ?? '122099994').trim();
    const ownerParsed = Number(ownerUserIdRaw);
    if (!Number.isFinite(ownerParsed) || !Number.isInteger(ownerParsed) || ownerParsed <= 0) {
        throw new Error('OWNER_USER_ID должен быть положительным целым числом');
    }
    const adminChatIdRaw = (process.env.ADMIN_CHAT_ID ?? '').trim();
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
    const NODE_ENV = process.env.NODE_ENV === 'production' ? 'production' : 'development';
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
    let miniAppUrl = (0, telegramMiniAppUrl_1.normalizeMiniAppUrl)(miniAppUrlRaw);
    const webhookUrlEarly = (process.env.WEBHOOK_URL ?? '').trim();
    if (!miniAppUrl && webhookUrlEarly.startsWith('https://')) {
        miniAppUrl = (0, telegramMiniAppUrl_1.deriveMiniAppUrlFromWebhook)(webhookUrlEarly);
    }
    const apiPortRaw = (process.env.API_PORT ?? '').trim();
    let listenPort = PORT;
    if (apiPortRaw !== '') {
        const apiParsed = Number.parseInt(apiPortRaw, 10);
        if (Number.isFinite(apiParsed) && apiParsed > 0) {
            listenPort = apiParsed;
        }
    }
    const TG_TOKEN = getTelegramToken();
    const base = {
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
        throw new Error('В режиме webhook задайте WEBHOOK_URL — полный HTTPS-адрес (как в POST /subscriptions), например https://bot.example.com/webhook');
    }
    let webhookPath;
    try {
        const u = new URL(webhookUrl);
        webhookPath = u.pathname && u.pathname !== '' ? u.pathname : '/';
    }
    catch {
        throw new Error('WEBHOOK_URL не является корректным URL');
    }
    const secretRaw = (process.env.WEBHOOK_SECRET ?? '').trim();
    const webhookSecret = secretRaw === '' ? undefined : secretRaw;
    if (NODE_ENV === 'production') {
        if (!webhookSecret || !WEBHOOK_SECRET_RE.test(webhookSecret)) {
            throw new Error('В production для webhook задайте WEBHOOK_SECRET (5–256 символов: латиница, цифры, _ и -), см. документацию POST /subscriptions');
        }
    }
    else if (webhookSecret && !WEBHOOK_SECRET_RE.test(webhookSecret)) {
        throw new Error('WEBHOOK_SECRET должен быть 5–256 символов: латиница, цифры, _ и -');
    }
    if (!webhookSecret) {
        logger_1.logger.warn('WEBHOOK_SECRET не задан: заголовок X-Max-Bot-Api-Secret проверяться не будет (только для разработки).');
    }
    return {
        ...base,
        webhookUrl,
        webhookPath,
        webhookSecret,
    };
}
exports.config = getConfig();
//# sourceMappingURL=config.js.map