"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.telegramUserArchiveConfigured = telegramUserArchiveConfigured;
exports.getTelegramUserApiId = getTelegramUserApiId;
exports.getTelegramUserApiHash = getTelegramUserApiHash;
exports.getTelegramUserSession = getTelegramUserSession;
exports.connectTelegramUserClient = connectTelegramUserClient;
exports.resolveTelegramChannelEntity = resolveTelegramChannelEntity;
exports.disconnectTelegramUserClient = disconnectTelegramUserClient;
exports.fetchChannelArchiveForImport = fetchChannelArchiveForImport;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const telegram_1 = require("telegram");
const errors_1 = require("telegram/errors");
const sessions_1 = require("telegram/sessions");
const logger_1 = require("../utils/logger");
const tgChannelMatch_1 = require("../utils/tgChannelMatch");
const mtprotoConfigStore_1 = require("./mtprotoConfigStore");
const MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000;
const ARCHIVE_FETCH_TIMEOUT_MS = 20 * 60_000;
const ARCHIVE_STEP_DELAY_MS = 1200;
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function floodWaitSeconds(err) {
    if (err instanceof errors_1.FloodWaitError || err instanceof errors_1.SlowModeWaitError) {
        return Number.isFinite(err.seconds) ? Math.max(1, Math.ceil(err.seconds)) : null;
    }
    if (typeof err === 'object' && err !== null && 'seconds' in err) {
        const seconds = Number(err.seconds);
        if (Number.isFinite(seconds) && seconds > 0) {
            return Math.max(1, Math.ceil(seconds));
        }
    }
    const msg = err instanceof Error ? err.message : String(err);
    const match = /FLOOD_WAIT_?(\d+)/i.exec(msg);
    if (match?.[1]) {
        return Math.max(1, Number(match[1]));
    }
    return null;
}
async function withFloodWaitRetry(jobId, label, run, maxRetries = 5) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            return await run();
        }
        catch (err) {
            const waitSeconds = floodWaitSeconds(err);
            if (!waitSeconds || attempt >= maxRetries) {
                throw err;
            }
            logger_1.logger.warn('[telegramUserArchive] FLOOD_WAIT, жду и продолжаю', {
                jobId,
                label,
                attempt: attempt + 1,
                waitSeconds,
            });
            await sleep((waitSeconds + 1) * 1000);
        }
    }
    throw new Error('unexpected flood-wait retry state');
}
function telegramUserArchiveConfigured() {
    return (0, mtprotoConfigStore_1.isMtprotoSessionReady)();
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
/** Подключение MTProto user-сессии (импорт TG→MAX, отправка в обсуждения от канала). */
async function connectTelegramUserClient() {
    return createUserClient();
}
async function resolveTelegramChannelEntity(client, channelKey) {
    return resolveChannelEntity(client, channelKey);
}
async function createUserClient() {
    const apiId = getTelegramUserApiId();
    const apiHash = getTelegramUserApiHash();
    const session = getTelegramUserSession();
    if (apiId === null || !apiHash || !session) {
        throw new Error('Не настроен user-аккаунт: войдите в MTProto в админке (TG→MAX или Импорт TG→MAX) или задайте TG_API_ID, TG_API_HASH, TG_USER_SESSION в .env');
    }
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(session), apiId, apiHash, {
        connectionRetries: 3,
    });
    await client.connect();
    if (!(await client.checkAuthorization())) {
        await client.destroy().catch(() => { });
        throw new Error('Сессия MTProto недействительна — войдите заново в админке');
    }
    return client;
}
async function disconnectTelegramUserClient(client) {
    try {
        if (typeof client.destroy === 'function') {
            await client.destroy();
            return;
        }
        await client.disconnect();
    }
    catch (err) {
        logger_1.logger.debug('[telegramUserArchive] MTProto client teardown', { err });
    }
}
function messageCaption(msg) {
    const text = typeof msg.message === 'string' ? msg.message.trim() : '';
    return text;
}
function sanitizeFileName(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
}
async function mapMessageToPayload(client, msg, tmpDir, jobId) {
    const caption = messageCaption(msg);
    const media = msg.media;
    if (!media) {
        return caption ? { kind: 'text', text: caption } : null;
    }
    if (media instanceof telegram_1.Api.MessageMediaPhoto) {
        const localPath = node_path_1.default.join(tmpDir, `${msg.id}-photo.jpg`);
        logger_1.logger.info('[telegramUserArchive] Скачиваю фото из Telegram', { jobId, messageId: msg.id });
        await withTimeout(client.downloadMedia(msg, { outputFile: localPath }), MEDIA_DOWNLOAD_TIMEOUT_MS, 'скачивание фото');
        logger_1.logger.info('[telegramUserArchive] Фото скачано', { jobId, messageId: msg.id, localPath });
        return { kind: 'photo', caption, localPath };
    }
    if (media instanceof telegram_1.Api.MessageMediaDocument) {
        const doc = media.document;
        if (doc instanceof telegram_1.Api.Document) {
            const mime = doc.mimeType || 'application/octet-stream';
            const fileName = doc.attributes?.find((a) => a instanceof telegram_1.Api.DocumentAttributeFilename)
                ?.fileName || `file-${msg.id}`;
            const localPath = node_path_1.default.join(tmpDir, `${msg.id}-${sanitizeFileName(fileName)}`);
            logger_1.logger.info('[telegramUserArchive] Скачиваю документ/видео из Telegram', {
                jobId,
                messageId: msg.id,
                fileName,
            });
            await withTimeout(client.downloadMedia(msg, { outputFile: localPath }), MEDIA_DOWNLOAD_TIMEOUT_MS, 'скачивание документа');
            logger_1.logger.info('[telegramUserArchive] Файл скачан', {
                jobId,
                messageId: msg.id,
                localPath,
            });
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
function groupedIdKey(msg) {
    if (!msg.groupedId)
        return null;
    try {
        return msg.groupedId.toString();
    }
    catch {
        return String(msg.groupedId);
    }
}
function isMediaPayload(payload) {
    return payload.kind === 'photo' || payload.kind === 'video' || payload.kind === 'document';
}
function collectPayloadPaths(payload) {
    if (payload.kind === 'album') {
        return payload.items.map((item) => item.localPath);
    }
    if ('localPath' in payload && payload.localPath) {
        return [payload.localPath];
    }
    return [];
}
function buildArchiveMessageGroups(messages) {
    const groups = [];
    const albumIndexByGroupId = new Map();
    for (const msg of messages) {
        if (!msg || typeof msg.id !== 'number')
            continue;
        const groupedId = groupedIdKey(msg);
        if (!groupedId) {
            groups.push({ messageId: msg.id, groupedId: null, items: [msg] });
            continue;
        }
        const existingIndex = albumIndexByGroupId.get(groupedId);
        if (existingIndex === undefined) {
            groups.push({ messageId: msg.id, groupedId, items: [msg] });
            albumIndexByGroupId.set(groupedId, groups.length - 1);
            continue;
        }
        groups[existingIndex].items.push(msg);
    }
    return groups;
}
async function mapGroupToPost(client, group, tmpDir, jobId) {
    if (group.items.length === 1) {
        const payload = await mapMessageToPayload(client, group.items[0], tmpDir, jobId);
        return payload ? { messageId: group.messageId, payload } : null;
    }
    logger_1.logger.info('[telegramUserArchive] Обрабатываю альбом groupedId', {
        jobId,
        groupedId: group.groupedId,
        parts: group.items.length,
    });
    const albumItems = [];
    let caption = '';
    const createdFiles = [];
    try {
        for (const item of group.items) {
            const payload = await mapMessageToPayload(client, item, tmpDir, jobId);
            if (!payload)
                continue;
            if (isMediaPayload(payload) && payload.localPath) {
                albumItems.push({
                    kind: payload.kind,
                    localPath: payload.localPath,
                    fileName: payload.kind === 'document' ? payload.fileName : undefined,
                    mimeType: payload.kind === 'document' ? payload.mimeType : undefined,
                });
                createdFiles.push(payload.localPath);
            }
            if (!caption) {
                const c = payload.kind === 'text' ? payload.text : payload.caption;
                if (c?.trim())
                    caption = c.trim();
            }
        }
    }
    catch (err) {
        for (const filePath of createdFiles) {
            await promises_1.default.rm(filePath, { force: true }).catch(() => { });
        }
        throw err;
    }
    if (albumItems.length === 0) {
        return caption ? { messageId: group.messageId, payload: { kind: 'text', text: caption } } : null;
    }
    return {
        messageId: group.messageId,
        payload: {
            kind: 'album',
            caption,
            items: albumItems,
        },
    };
}
async function resolveChannelEntity(client, channelKey) {
    const normalized = (0, tgChannelMatch_1.normalizeTelegramChannelKey)(channelKey);
    const candidates = [normalized, normalized.replace(/^@/, '')].filter((v, i, a) => v && a.indexOf(v) === i);
    let lastErr;
    for (const key of candidates) {
        try {
            return (await client.getEntity(key));
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
            const groups = buildArchiveMessageGroups(messages);
            logger_1.logger.info('[telegramUserArchive] Сообщения сгруппированы перед импортом', {
                jobId,
                messages: messages.length,
                groups: groups.length,
            });
            for (const group of groups) {
                scanned += group.items.length;
                let post = null;
                try {
                    post = await withFloodWaitRetry(jobId, `group:${group.groupedId ?? group.messageId}`, async () => mapGroupToPost(client, group, tmpDir, jobId));
                }
                catch (err) {
                    logger_1.logger.warn('[telegramUserArchive] skip message/group', {
                        jobId,
                        messageId: group.messageId,
                        groupedId: group.groupedId,
                        err: err instanceof Error ? err.message : String(err),
                    });
                    const caption = group.items.map((m) => messageCaption(m)).find((text) => text.length > 0) || '';
                    if (caption) {
                        post = { messageId: group.messageId, payload: { kind: 'text', text: caption } };
                    }
                }
                if (!post)
                    continue;
                logger_1.logger.info('[telegramUserArchive] Пост подготовлен, передаю в staging', {
                    jobId,
                    messageId: post.messageId,
                    payloadKind: post.payload.kind,
                    groupedId: group.groupedId,
                });
                if (onPost) {
                    await onPost(post);
                }
                if (!onPost) {
                    for (const localPath of collectPayloadPaths(post.payload)) {
                        await promises_1.default.rm(localPath, { force: true }).catch(() => { });
                    }
                }
                staged += 1;
                await sleep(ARCHIVE_STEP_DELAY_MS);
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
            await disconnectTelegramUserClient(client);
        }
    };
    return withTimeout(run(), ARCHIVE_FETCH_TIMEOUT_MS, 'загрузка архива');
}
//# sourceMappingURL=telegramUserArchive.js.map