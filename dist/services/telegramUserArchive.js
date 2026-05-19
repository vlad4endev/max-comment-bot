"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.telegramUserArchiveConfigured = telegramUserArchiveConfigured;
exports.getTelegramUserApiId = getTelegramUserApiId;
exports.getTelegramUserApiHash = getTelegramUserApiHash;
exports.getTelegramUserSession = getTelegramUserSession;
exports.fetchChannelArchiveForImport = fetchChannelArchiveForImport;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const telegram_1 = require("telegram");
const sessions_1 = require("telegram/sessions");
const logger_1 = require("../utils/logger");
function telegramUserArchiveConfigured() {
    return getTelegramUserApiId() !== null && getTelegramUserApiHash() !== '' && getTelegramUserSession() !== '';
}
function getTelegramUserApiId() {
    const raw = (process.env.TG_API_ID || '').trim();
    if (!raw)
        return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
}
function getTelegramUserApiHash() {
    return (process.env.TG_API_HASH || '').trim();
}
function getTelegramUserSession() {
    return (process.env.TG_USER_SESSION || '').trim();
}
async function createUserClient() {
    const apiId = getTelegramUserApiId();
    const apiHash = getTelegramUserApiHash();
    const session = getTelegramUserSession();
    if (apiId === null || !apiHash || !session) {
        throw new Error('Не настроен user-аккаунт: задайте TG_API_ID, TG_API_HASH и TG_USER_SESSION (скрипт npm run tg:user-login)');
    }
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(session), apiId, apiHash, {
        connectionRetries: 3,
    });
    await client.connect();
    if (!(await client.checkAuthorization())) {
        await client.disconnect();
        throw new Error('TG_USER_SESSION недействителен — выполните npm run tg:user-login');
    }
    return client;
}
function messageCaption(msg) {
    const text = typeof msg.message === 'string' ? msg.message.trim() : '';
    return text;
}
async function mapMessageToPayload(client, msg, tmpDir) {
    const caption = messageCaption(msg);
    const media = msg.media;
    if (!media) {
        return caption ? { kind: 'text', text: caption } : null;
    }
    const downloaded = await client.downloadMedia(msg, {});
    if (!downloaded || !Buffer.isBuffer(downloaded)) {
        return caption ? { kind: 'text', text: caption } : null;
    }
    if (media instanceof telegram_1.Api.MessageMediaPhoto) {
        const localPath = node_path_1.default.join(tmpDir, `${msg.id}-photo.jpg`);
        await promises_1.default.writeFile(localPath, downloaded);
        return { kind: 'photo', caption, localPath };
    }
    if (media instanceof telegram_1.Api.MessageMediaDocument) {
        const doc = media.document;
        if (doc instanceof telegram_1.Api.Document) {
            const mime = doc.mimeType || 'application/octet-stream';
            const fileName = doc.attributes?.find((a) => a instanceof telegram_1.Api.DocumentAttributeFilename)
                ?.fileName || `file-${msg.id}`;
            const localPath = node_path_1.default.join(tmpDir, `${msg.id}-${fileName}`);
            await promises_1.default.writeFile(localPath, downloaded);
            if (mime.startsWith('video/')) {
                return { kind: 'video', caption, localPath };
            }
            return {
                kind: 'document',
                caption,
                localPath,
                fileName,
                mimeType: mime,
            };
        }
    }
    return caption ? { kind: 'text', text: caption } : null;
}
async function fetchChannelArchiveForImport(channelKey, limit, jobId) {
    const client = await createUserClient();
    const tmpDir = node_path_1.default.join(node_os_1.default.tmpdir(), 'maxcomment-import', String(jobId));
    await promises_1.default.mkdir(tmpDir, { recursive: true });
    try {
        const entity = await client.getEntity(channelKey);
        const messages = await client.getMessages(entity, { limit, reverse: true });
        const out = [];
        for (const msg of messages) {
            if (!msg || typeof msg.id !== 'number')
                continue;
            const payload = await mapMessageToPayload(client, msg, tmpDir);
            if (!payload)
                continue;
            out.push({ messageId: msg.id, payload });
        }
        logger_1.logger.info('[telegramUserArchive] fetched', {
            channelKey,
            limit,
            jobId,
            count: out.length,
        });
        return out;
    }
    finally {
        await client.disconnect();
    }
}
//# sourceMappingURL=telegramUserArchive.js.map