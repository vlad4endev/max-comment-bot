"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const logger_1 = require("./utils/logger");
dotenv_1.default.config();
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
    const miniAppUrl = miniAppUrlRaw === '' ? undefined : miniAppUrlRaw.replace(/\/+$/, '');
    const apiPortRaw = (process.env.API_PORT ?? '').trim();
    let listenPort = PORT;
    if (apiPortRaw !== '') {
        const apiParsed = Number.parseInt(apiPortRaw, 10);
        if (Number.isFinite(apiParsed) && apiParsed > 0) {
            listenPort = apiParsed;
        }
    }
    const base = {
        BOT_TOKEN,
        ADMIN_CHAT_ID: adminParsed,
        BOT_NICKNAME,
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