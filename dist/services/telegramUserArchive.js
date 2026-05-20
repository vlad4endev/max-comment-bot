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
const tgChannelMatch_1 = require("../utils/tgChannelMatch");
const mtprotoConfigStore_1 = require("./mtprotoConfigStore");
const MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000;
const ARCHIVE_FETCH_TIMEOUT_MS = 20 * 60_000;
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Таймаут (${label})`)), ms);
        promise
            .then((v) => {
            clearTimeout(timer);
            resolve(v);
        })
            .catch((e) => {
            clearTimeout(timer);
            reject(e);
        });
    });
}
function telegramRpcMessage(err) {
    if (err instanceof Error && err.message)
        return err.message;
    if (typeof err === 'object' && err !== null && 'errorMessage' in err) {
        const rpc = String(err.errorMessage || '');
        if (rpc === 'CHANNEL_PRIVATE') {
            return 'Канал закрыт: user-аккаунт должен быть подписан на канал';
        }
        if (rpc === 'USERNAME_NOT_OCCUPIED' || rpc === 'USERNAME_INVALID') {
            return 'Канал не найден по username — проверьте @ или укажите -100… id';
        }
        if (rpc === 'FLOOD_WAIT') {
            return 'Telegram просит подождать (FLOOD_WAIT) — повторите через минуту';
        }
        if (rpc)
            return rpc;
    }
    return 'Ошибка Telegram MTProto';
}
function telegramUserArchiveConfigured() {
    const { apiId, apiHash, session } = (0, mtprotoConfigStore_1.resolveMtprotoCredentials)();
    return apiId !== null && apiHash !== '' && session !== '';
}
function getTelegramUserApiId() {
    return (0, mtprotoConfigStore_1.resolveMtprotoCredentials)().apiId;
}
function getTelegramUserApiHash() {
    return (0, mtprotoConfigStore_1.resolveMtprotoCredentials)().apiHash;
}
function getTelegramUserSession() {
    return (0, mtprotoConfigStore_1.resolveMtprotoCredentials)().session;
}
async function createUserClient() {
    const apiId = getTelegramUserApiId();
    const apiHash = getTelegramUserApiHash();
    const session = getTelegramUserSession();
    if (apiId === null || !apiHash || !session) {
        throw new Error('Не настроен user-аккаунт: укажите MTProto в админке (Импорт TG→MAX) или TG_API_ID, TG_API_HASH, TG_USER_SESSION в .env');
    }
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(session), apiId, apiHash, {
        connectionRetries: 3,
    });
    await client.connect();
    if (!(await client.checkAuthorization())) {
        await client.disconnect();
        throw new Error('Сессия MTProto недействительна — войдите заново в админке');
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
    const downloaded = await withTimeout(client.downloadMedia(msg, {}), MEDIA_DOWNLOAD_TIMEOUT_MS, 'скачивание медиа');
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
async function resolveChannelEntity(client, channelKey) {
    const normalized = (0, tgChannelMatch_1.normalizeTelegramChannelKey)(channelKey);
    const candidates = [normalized, normalized.replace(/^@/, '')].filter((v, i, a) => v && a.indexOf(v) === i);
    let lastErr;
    for (const key of candidates) {
        try {
            return await client.getEntity(key);
        }
        catch (err) {
            lastErr = err;
        }
    }
    throw new Error(telegramRpcMessage(lastErr));
}
async function fetchChannelArchiveForImport(channelKey, limit, jobId, onPost) {
    const run = async () => {
        const client = await createUserClient();
        const tmpDir = node_path_1.default.join(node_os_1.default.tmpdir(), 'maxcomment-import', String(jobId));
        await promises_1.default.mkdir(tmpDir, { recursive: true });
        try {
            const entity = await resolveChannelEntity(client, channelKey);
            const messages = await client.getMessages(entity, { limit, reverse: true });
            if (!messages.length) {
                throw new Error('В канале нет доступных сообщений. User-аккаунт должен быть участником/админом канала.');
            }
            let staged = 0;
            let scanned = 0;
            for (const msg of messages) {
                if (!msg || typeof msg.id !== 'number')
                    continue;
                scanned += 1;
                let payload = null;
                try {
                    payload = await mapMessageToPayload(client, msg, tmpDir);
                }
                catch (err) {
                    logger_1.logger.warn('[telegramUserArchive] skip message', {
                        jobId,
                        messageId: msg.id,
                        err: err instanceof Error ? err.message : String(err),
                    });
                    const caption = messageCaption(msg);
                    if (caption) {
                        payload = { kind: 'text', text: caption };
                    }
                }
                if (!payload)
                    continue;
                const post = { messageId: msg.id, payload };
                if (onPost) {
                    await onPost(post);
                }
                staged += 1;
            }
            logger_1.logger.info('[telegramUserArchive] fetched', {
                channelKey,
                limit,
                jobId,
                scanned,
                staged,
            });
            if (staged === 0) {
                throw new Error(`Просмотрено сообщений: ${scanned}, подходящих постов: 0 (пустые или неподдерживаемый формат).`);
            }
            return staged;
        }
        finally {
            await client.disconnect();
        }
    };
    return withTimeout(run(), ARCHIVE_FETCH_TIMEOUT_MS, 'загрузка архива');
}
//# sourceMappingURL=telegramUserArchive.js.map