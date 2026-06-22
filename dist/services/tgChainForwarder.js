"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setTgChainForwarderBot = setTgChainForwarderBot;
exports.getTgChainForwarderBot = getTgChainForwarderBot;
exports.syncMainTelegramBotDiscoveryUpdates = syncMainTelegramBotDiscoveryUpdates;
exports.runTgChainsOnce = runTgChainsOnce;
exports.startTgChainForwarder = startTgChainForwarder;
const axios_1 = __importDefault(require("axios"));
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const database_1 = require("../db/database");
const telegramReader_1 = require("../forwarder/telegramReader");
const adminPanelState_1 = require("../api/adminPanelState");
const channelImportService_1 = require("./channelImportService");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const channelPostPublishGate_1 = require("./channelPostPublishGate");
const postStore_1 = require("./postStore");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const tgChannelMatch_1 = require("../utils/tgChannelMatch");
const logger_1 = require("../utils/logger");
const alertService_1 = require("../utils/alertService");
const maxApiRetry_1 = require("../utils/maxApiRetry");
const telegramMainBotOffsetStore_1 = require("./telegramMainBotOffsetStore");
const telegramMiniappService_1 = require("./telegramMiniappService");
const postCommentMappingStore_1 = require("./postCommentMappingStore");
const telegramDiscussionThreadResolver_1 = require("./telegramDiscussionThreadResolver");
const tgCommentSyncService_1 = require("./tgCommentSyncService");
const vkChainForwarder_1 = require("./vkChainForwarder");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Long-poll Telegram for new channel_post (сек). */
const TG_CHAIN_LONG_POLL_SEC = 25;
const TG_CHAIN_IDLE_MS = 3_000;
/** MIN gap between `sendMessageToChat` to the same MAX channel (API 429). */
const MAX_SEND_INTERVAL_MS = 2_500;
const UPLOAD_STAGGER_MS = 450;
const TG_CHAIN_MAX_API_RETRIES = 6;
/** Буферизация Telegram-альбомов по media_group_id. */
const TG_ALBUM_BUFFER_MS = 900;
/** Telegram media group ограничен 10 элементами. */
const TG_ALBUM_MAX_MEDIA_PER_POST = 10;
const lastMaxSendAt = new Map();
const albumBuffer = new Map();
/** Время последней активности long-poll / пересылки по chain_id. */
const chainLastActivity = new Map();
const chainRestartCount = new Map();
const activeForwarders = new Map();
let globalForwarderHandle = null;
function touchChainActivity(chainId) {
    chainLastActivity.set(chainId, Date.now());
}
async function throttleMaxChatSend(chatId) {
    const now = Date.now();
    const last = lastMaxSendAt.get(chatId) ?? 0;
    const wait = MAX_SEND_INTERVAL_MS - (now - last);
    if (wait > 0) {
        await sleep(wait);
    }
    lastMaxSendAt.set(chatId, Date.now());
}
function maxApi(fn) {
    return (0, maxApiRetry_1.apiCallWithRetry)(fn, TG_CHAIN_MAX_API_RETRIES);
}
let botRef = null;
function setTgChainForwarderBot(bot) {
    botRef = bot;
}
function getTgChainForwarderBot() {
    return botRef;
}
function getReaderOffset(tgToken) {
    return (0, telegramMainBotOffsetStore_1.getTelegramBotUpdatesOffset)(tgToken);
}
function setReaderOffset(tgToken, offset) {
    (0, telegramMainBotOffsetStore_1.setTelegramBotUpdatesOffset)(tgToken, offset);
}
/** Long-poll / drain TG updates for main CommentBot (my_chat_member, /start, callbacks). */
async function syncMainTelegramBotDiscoveryUpdates(tgToken, options) {
    if (!(0, resolveTelegramBotToken_1.isMainTelegramBotToken)(tgToken)) {
        return 0;
    }
    await (0, integrationPlatformClient_1.ensureTelegramPollingMode)(tgToken);
    const pollErr = await (0, channelImportService_1.assertTelegramPollingReady)(tgToken);
    if (pollErr) {
        logger_1.logger.warn('[tgChain] main bot discovery poll skipped', { err: pollErr });
        return 0;
    }
    let offset = getReaderOffset(tgToken);
    const timeoutSec = options?.timeoutSec ?? 0;
    const maxPages = options?.maxPages ?? 8;
    let processed = 0;
    for (let page = 0; page < maxPages; page++) {
        let batch;
        try {
            batch = await (0, telegramReader_1.getTelegramUpdatesWithIds)(tgToken, offset, timeoutSec, {
                includeMiniappBotUpdates: true,
            });
        }
        catch (err) {
            if (err instanceof telegramReader_1.TelegramGetUpdatesConflictError) {
                logger_1.logger.warn('[tgChain] main bot discovery 409 conflict');
                break;
            }
            throw err;
        }
        if (batch.length === 0) {
            break;
        }
        const rawUpdates = batch
            .map((u) => u.raw)
            .filter((u) => !!u);
        if (rawUpdates.length > 0) {
            await (0, telegramMiniappService_1.processTelegramMiniappBotUpdates)(tgToken, rawUpdates, botRef);
        }
        for (const u of batch) {
            offset = Math.max(offset, u.update_id + 1);
            processed += 1;
        }
        if (batch.length < 100) {
            break;
        }
    }
    if (offset > getReaderOffset(tgToken)) {
        setReaderOffset(tgToken, offset);
    }
    return processed;
}
function chainSourceKey(chain) {
    if (chain.tg_channel_id && chain.tg_channel_id.trim() !== '') {
        return chain.tg_channel_id.trim();
    }
    const u = chain.tg_username.trim().replace(/^@/, '');
    return u ? `@${u}` : '';
}
/** Минимальная метка времени TG-поста (мс) для пересылки; null = без ограничения. */
function resolveForwardPostsSinceMs(chain) {
    if (!chain.forward_posts) {
        return null;
    }
    const iso = chain.forward_posts_since?.trim() || chain.created_at?.trim() || '';
    if (!iso) {
        return null;
    }
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) {
        return null;
    }
    // Небольшой запас на рассинхрон часов TG и сервера.
    return ms - 120_000;
}
function isTgPostTooOldForForward(chain, message) {
    const sinceMs = resolveForwardPostsSinceMs(chain);
    if (sinceMs === null) {
        return false;
    }
    const msgDateSec = message.date;
    if (typeof msgDateSec !== 'number' || !Number.isFinite(msgDateSec)) {
        return false;
    }
    return msgDateSec * 1000 < sinceMs;
}
function isAlreadyForwarded(chainId, messageId) {
    const row = (0, database_1.getDb)()
        .prepare('SELECT 1 FROM tg_chain_forwarded WHERE chain_id = ? AND tg_message_id = ?')
        .get(chainId, messageId);
    return !!row;
}
function getForwardedRecord(chainId, messageId) {
    const row = (0, database_1.getDb)()
        .prepare(`SELECT max_message_mid, tg_media_group_id, album_chunk_index, tg_payload
       FROM tg_chain_forwarded
       WHERE chain_id = ? AND tg_message_id = ?`)
        .get(chainId, messageId);
    return row ?? null;
}
function listForwardedAlbumChunk(chainId, mediaGroupId, chunkIndex) {
    return (0, database_1.getDb)()
        .prepare(`SELECT tg_message_id, tg_payload
       FROM tg_chain_forwarded
       WHERE chain_id = ? AND tg_media_group_id = ? AND album_chunk_index = ?
       ORDER BY tg_message_id ASC`)
        .all(chainId, mediaGroupId, chunkIndex);
}
function syncTgMetadataOnForwardedPost(maxChatId, maxMid, chain, tgMessage) {
    const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(maxChatId) ?? maxChatId;
    const post = postStore_1.postStore.findPostByChannelMessage(chatId, maxMid.trim());
    if (!post) {
        return;
    }
    postStore_1.postStore.savePost({
        ...post,
        tg_msg_id: tgMessage.message_id,
        tg_channel_id: chain.tg_channel_id?.trim() || String(tgMessage.chat.id),
    });
}
function markForwarded(chainId, message, maxMid, chunkIndex) {
    const mediaGroupId = message.media_group_id?.trim() || null;
    const payload = JSON.stringify(message);
    (0, database_1.getDb)()
        .prepare(`INSERT INTO tg_chain_forwarded
       (chain_id, tg_message_id, max_message_mid, tg_media_group_id, album_chunk_index, tg_payload)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain_id, tg_message_id) DO UPDATE SET
         max_message_mid = excluded.max_message_mid,
         tg_media_group_id = excluded.tg_media_group_id,
         album_chunk_index = excluded.album_chunk_index,
         tg_payload = excluded.tg_payload`)
        .run(chainId, message.message_id, maxMid, mediaGroupId, chunkIndex, payload);
    // Синхронизация комментариев: дублируем маппинг в post_comment_mapping
    if (maxMid) {
        (0, postCommentMappingStore_1.upsertPostCommentMapping)(chainId, message.message_id, maxMid, message.chat?.id ?? null);
        const chain = (0, adminPanelState_1.listTgChainsSync)().find((c) => c.id === chainId);
        if (chain?.forward_comments) {
            void (0, telegramDiscussionThreadResolver_1.ensurePostThreadMapping)(maxMid).catch((err) => {
                logger_1.logger.warn('[tgChain] ensurePostThreadMapping failed', { chainId, maxMid, err });
            });
        }
    }
}
/** Токен TG-бота для опроса channel_post. Пустой bot_token в связке = основной CommentBot (как в miniapp), не reader. */
function resolveTgToken(chain) {
    const fromChain = chain.bot_token?.trim();
    if (fromChain)
        return fromChain;
    return (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
}
function pickAlbumCaption(messages, addSignature) {
    for (const m of messages) {
        const raw = (m.caption || m.text || '').trim();
        if (raw) {
            return addSignature ? `${raw}\n\n— TG` : raw;
        }
    }
    return '';
}
function buildAlbumBufferKey(chain, msg) {
    const gid = msg.media_group_id?.trim();
    if (!gid)
        return null;
    return `${chain.id}:${msg.chat.id}:${gid}`;
}
/**
 * Складывает сообщение media group в буфер и продлевает окно ожидания,
 * чтобы собрать альбом целиком даже при раздельных батчах getUpdates.
 */
function queueAlbumMessage(chain, tgToken, msg) {
    const key = buildAlbumBufferKey(chain, msg);
    if (!key)
        return;
    const now = Date.now();
    const existing = albumBuffer.get(key);
    if (existing) {
        if (!existing.messages.some((m) => m.message_id === msg.message_id)) {
            existing.messages.push(msg);
            existing.messages.sort((a, b) => a.message_id - b.message_id);
        }
        existing.flushAt = now + TG_ALBUM_BUFFER_MS;
        return;
    }
    albumBuffer.set(key, {
        chain,
        tgToken,
        messages: [msg],
        flushAt: now + TG_ALBUM_BUFFER_MS,
    });
}
function getAlbumBufferDelayMs(now = Date.now(), tgToken) {
    let minDelay = null;
    for (const entry of albumBuffer.values()) {
        if (tgToken && entry.tgToken !== tgToken)
            continue;
        const delay = Math.max(0, entry.flushAt - now);
        if (minDelay === null || delay < minDelay) {
            minDelay = delay;
        }
    }
    return minDelay;
}
function takeReadyAlbumEntries(now = Date.now()) {
    const ready = [];
    for (const [key, entry] of albumBuffer.entries()) {
        if (entry.flushAt <= now) {
            ready.push(entry);
            albumBuffer.delete(key);
        }
    }
    ready.sort((a, b) => a.messages[0].message_id - b.messages[0].message_id);
    return ready;
}
function chunkAlbumMessages(messages) {
    if (messages.length <= TG_ALBUM_MAX_MEDIA_PER_POST)
        return [messages];
    const chunks = [];
    for (let i = 0; i < messages.length; i += TG_ALBUM_MAX_MEDIA_PER_POST) {
        chunks.push(messages.slice(i, i + TG_ALBUM_MAX_MEDIA_PER_POST));
    }
    return chunks;
}
/** Разбивает апдейты: одиночные посты и альбомы (несколько channel_post с media_group_id). */
function groupChannelPostsForForward(posts) {
    const singles = [];
    const albums = new Map();
    for (const msg of posts) {
        const gid = msg.media_group_id?.trim();
        if (gid) {
            const key = `${msg.chat.id}:${gid}`;
            const list = albums.get(key) ?? [];
            list.push(msg);
            albums.set(key, list);
        }
        else {
            singles.push(msg);
        }
    }
    const out = singles.map((m) => [m]);
    for (const list of albums.values()) {
        list.sort((a, b) => a.message_id - b.message_id);
        out.push(list);
    }
    return out;
}
/** Публикует одно TG-сообщение в MAX; caption — явная подпись (для альбома только у первого кадра). */
async function forwardOneTgMessageToMax(bot, msg, tgToken, maxChatId, caption) {
    const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(maxChatId) ?? maxChatId;
    const messageText = caption.trim() || '\u00a0';
    const hasMedia = Boolean(msg.photo?.length || msg.video?.file_id || msg.document?.file_id);
    if (msg.photo && msg.photo.length > 0) {
        const largest = msg.photo[msg.photo.length - 1];
        const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, largest.file_id);
        if (url) {
            let image;
            try {
                const res = await axios_1.default.get(url, { responseType: 'arraybuffer', timeout: 120_000 });
                image = await maxApi(() => bot.api.uploadImage({ source: Buffer.from(res.data) }));
            }
            catch (err) {
                logger_1.logger.warn('[tgChain] binary photo upload failed, fallback to url', {
                    messageId: msg.message_id,
                    err,
                });
                image = await maxApi(() => bot.api.uploadImage({ url }));
            }
            await throttleMaxChatSend(chatId);
            const sent = await maxApi(() => bot.api.sendMessageToChat(chatId, messageText, {
                attachments: [image.toJson()],
            }));
            return sent.body?.mid ?? null;
        }
        logger_1.logger.warn('[tgChain] photo forward skipped: no TG file url', { messageId: msg.message_id });
    }
    if (msg.video?.file_id) {
        const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, msg.video.file_id);
        if (url) {
            const res = await axios_1.default.get(url, { responseType: 'arraybuffer' });
            const video = await maxApi(() => bot.api.uploadVideo({ source: Buffer.from(res.data) }));
            await throttleMaxChatSend(chatId);
            const sent = await maxApi(() => bot.api.sendMessageToChat(chatId, messageText, {
                attachments: [video.toJson()],
            }));
            return sent.body?.mid ?? null;
        }
    }
    if (msg.document?.file_id) {
        const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, msg.document.file_id);
        if (url) {
            const res = await axios_1.default.get(url, { responseType: 'arraybuffer' });
            const file = await maxApi(() => bot.api.uploadFile({ source: Buffer.from(res.data) }));
            await throttleMaxChatSend(chatId);
            const sent = await maxApi(() => bot.api.sendMessageToChat(chatId, messageText, {
                attachments: [file.toJson()],
            }));
            return sent.body?.mid ?? null;
        }
    }
    if (!hasMedia && caption.trim()) {
        await throttleMaxChatSend(chatId);
        const sent = await maxApi(() => bot.api.sendMessageToChat(chatId, caption.trim()));
        return sent.body?.mid ?? null;
    }
    return null;
}
/** Загружает одно TG-фото в MAX (тот же путь, что и для одиночного поста — через URL). */
async function uploadTgPhotoAttachment(bot, tgToken, fileId) {
    const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, fileId);
    if (!url)
        return null;
    let uploaded = null;
    try {
        // Prefer binary upload so MAX returns token-based image payloads.
        // Those can be safely merged into one album attachment (`payload.photos`).
        const res = await axios_1.default.get(url, { responseType: 'arraybuffer' });
        uploaded = await maxApi(() => bot.api.uploadImage({ source: Buffer.from(res.data) }));
    }
    catch (err) {
        logger_1.logger.warn('[tgChain] album: binary image upload failed, fallback to url upload', {
            fileId,
            err,
        });
        uploaded = await maxApi(() => bot.api.uploadImage({ url }));
    }
    const json = uploaded.toJson();
    if (json.type !== 'image' || !json.payload) {
        return null;
    }
    const { token, url: imageUrl, photos } = json.payload;
    if (token || imageUrl || (photos && Object.keys(photos).length > 0)) {
        return json;
    }
    return null;
}
function mergeAlbumImageAttachments(images) {
    const out = [];
    for (const img of images) {
        const payload = img.payload;
        if (!payload)
            continue;
        if (payload.token) {
            out.push({ type: 'image', payload: { token: payload.token } });
            continue;
        }
        if (payload.url) {
            out.push({ type: 'image', payload: { url: payload.url } });
            continue;
        }
        if (payload.photos) {
            for (const photo of Object.values(payload.photos)) {
                if (photo?.token) {
                    out.push({ type: 'image', payload: { token: photo.token } });
                }
            }
        }
    }
    return out;
}
/** Загружает все фото альбома для одного поста MAX. */
async function buildAlbumImageAttachments(bot, photoMessages, tgToken) {
    const uploaded = [];
    for (let i = 0; i < photoMessages.length; i += 1) {
        const msg = photoMessages[i];
        if (!msg.photo?.length)
            continue;
        const largest = msg.photo[msg.photo.length - 1];
        const att = await uploadTgPhotoAttachment(bot, tgToken, largest.file_id);
        if (att) {
            uploaded.push(att);
        }
        if (i < photoMessages.length - 1) {
            await sleep(UPLOAD_STAGGER_MS);
        }
    }
    return mergeAlbumImageAttachments(uploaded);
}
async function buildAlbumAttachments(bot, messages, tgToken) {
    const photoMessages = messages.filter((m) => m.photo && m.photo.length > 0);
    const attachments = [];
    const imageAtts = await buildAlbumImageAttachments(bot, photoMessages, tgToken);
    attachments.push(...imageAtts);
    if (photoMessages.length > 0 && imageAtts.length === 0) {
        logger_1.logger.error('[tgChain] album: photos failed to upload', {
            photoCount: photoMessages.length,
            messageIds: messages.map((m) => m.message_id),
        });
        return [];
    }
    for (const msg of messages) {
        if (msg.photo?.length)
            continue;
        if (msg.video?.file_id) {
            const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, msg.video.file_id);
            if (url) {
                const res = await axios_1.default.get(url, { responseType: 'arraybuffer' });
                const video = await maxApi(() => bot.api.uploadVideo({ source: Buffer.from(res.data) }));
                attachments.push(video.toJson());
                await sleep(UPLOAD_STAGGER_MS);
            }
        }
        else if (msg.document?.file_id) {
            const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, msg.document.file_id);
            if (url) {
                const res = await axios_1.default.get(url, { responseType: 'arraybuffer' });
                const file = await maxApi(() => bot.api.uploadFile({ source: Buffer.from(res.data) }));
                attachments.push(file.toJson());
                await sleep(UPLOAD_STAGGER_MS);
            }
        }
    }
    return attachments;
}
async function buildSingleMessageAttachments(bot, msg, tgToken) {
    if (msg.photo && msg.photo.length > 0) {
        const largest = msg.photo[msg.photo.length - 1];
        const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, largest.file_id);
        if (!url)
            return [];
        const image = await maxApi(() => bot.api.uploadImage({ url }));
        return [image.toJson()];
    }
    if (msg.video?.file_id) {
        const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, msg.video.file_id);
        if (!url)
            return [];
        const res = await axios_1.default.get(url, { responseType: 'arraybuffer' });
        const video = await maxApi(() => bot.api.uploadVideo({ source: Buffer.from(res.data) }));
        return [video.toJson()];
    }
    if (msg.document?.file_id) {
        const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, msg.document.file_id);
        if (!url)
            return [];
        const res = await axios_1.default.get(url, { responseType: 'arraybuffer' });
        const file = await maxApi(() => bot.api.uploadFile({ source: Buffer.from(res.data) }));
        return [file.toJson()];
    }
    return [];
}
/** Альбом TG → один пост MAX (все фото в одном сообщении, как в Telegram). */
async function forwardAlbumToMax(bot, messages, tgToken, maxChatId, caption) {
    const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(maxChatId) ?? maxChatId;
    const messageText = caption.trim() || '\u00a0';
    const attachments = await buildAlbumAttachments(bot, messages, tgToken);
    if (attachments.length === 0) {
        return null;
    }
    await throttleMaxChatSend(chatId);
    const sent = await maxApi(() => bot.api.sendMessageToChat(chatId, messageText, {
        attachments: attachments.length > 0 ? attachments : undefined,
    }));
    return sent.body?.mid ?? null;
}
function parseBufferedTgPayload(payload) {
    if (!payload)
        return null;
    try {
        return JSON.parse(payload);
    }
    catch {
        return null;
    }
}
async function loadInlineKeyboardAttachment(bot, maxMid) {
    try {
        const message = await maxApi(() => bot.api.getMessage(maxMid));
        const keyboard = message.body.attachments?.find((att) => att.type === 'inline_keyboard');
        return keyboard ?? null;
    }
    catch {
        return null;
    }
}
function firstImageUrlFromAttachments(attachments) {
    for (const att of attachments) {
        if (att.type === 'image') {
            const payload = att.payload;
            if (payload?.url && payload.url.trim() !== '') {
                return payload.url;
            }
        }
    }
    return undefined;
}
async function editMaxMessageFromTelegram(bot, maxMid, text, attachments) {
    if (attachments.length === 0) {
        await maxApi(() => bot.api.editMessage(maxMid, { text: text.trim() || '\u00a0' }));
        return;
    }
    const keyboard = await loadInlineKeyboardAttachment(bot, maxMid);
    const nextAttachments = keyboard ? [...attachments, keyboard] : attachments;
    await maxApi(() => bot.api.editMessage(maxMid, {
        text: text.trim() || '\u00a0',
        attachments: nextAttachments,
    }));
}
function syncStoredPostAfterEdit(maxChatId, maxMid, text, attachments) {
    const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(maxChatId) ?? maxChatId;
    const post = postStore_1.postStore.findPostByChannelMessage(chatId, maxMid);
    if (!post)
        return;
    postStore_1.postStore.savePost({
        ...post,
        text: text.trim(),
        photo_url: attachments.length > 0 ? firstImageUrlFromAttachments(attachments) : post.photo_url,
        media_attachments: attachments.length > 0 ? attachments : post.media_attachments,
        timestamp: new Date().toISOString(),
    });
}
async function processEditedChainMessage(chain, msg, tgToken) {
    const sourceKey = chainSourceKey(chain);
    if (!(0, tgChannelMatch_1.telegramChannelMatchesTarget)(msg.chat, sourceKey))
        return;
    const mapping = getForwardedRecord(chain.id, msg.message_id);
    if (!mapping?.max_message_mid) {
        logger_1.logger.info('[tgChain] skip edit: original post was not forwarded', {
            chainId: chain.id,
            tgMessageId: msg.message_id,
        });
        return;
    }
    const bot = botRef;
    if (!bot) {
        throw new Error('MAX bot not initialized (setTgChainForwarderBot)');
    }
    try {
        const isAlbum = Boolean(msg.media_group_id?.trim() || mapping.tg_media_group_id?.trim());
        const maxMid = mapping.max_message_mid;
        if (isAlbum) {
            const mediaGroupId = (msg.media_group_id?.trim() || mapping.tg_media_group_id?.trim()) ?? '';
            const chunkIndex = mapping.album_chunk_index ?? 0;
            markForwarded(chain.id, msg, maxMid, chunkIndex);
            const rows = listForwardedAlbumChunk(chain.id, mediaGroupId, chunkIndex);
            const rebuilt = rows
                .map((row) => parseBufferedTgPayload(row.tg_payload))
                .filter((item) => Boolean(item));
            if (!rebuilt.some((item) => item.message_id === msg.message_id)) {
                rebuilt.push(msg);
            }
            rebuilt.sort((a, b) => a.message_id - b.message_id);
            const caption = pickAlbumCaption(rebuilt, chain.add_signature);
            const attachments = await buildAlbumAttachments(bot, rebuilt, tgToken);
            if (attachments.length === 0 && caption.trim() === '') {
                return;
            }
            await editMaxMessageFromTelegram(bot, maxMid, caption, attachments);
            syncStoredPostAfterEdit(chain.max_chat_id, maxMid, caption, attachments);
            logger_1.logger.info('[tgChain] edited album synced', {
                chainId: chain.id,
                tgMessageId: msg.message_id,
                maxMessageMid: maxMid,
                mediaGroupId,
                chunkIndex,
            });
            return;
        }
        const caption = (() => {
            const raw = (msg.caption || msg.text || '').trim();
            if (chain.add_signature && raw)
                return `${raw}\n\n— TG`;
            return raw;
        })();
        const attachments = await buildSingleMessageAttachments(bot, msg, tgToken);
        if (attachments.length === 0 && caption.trim() === '') {
            return;
        }
        markForwarded(chain.id, msg, maxMid, null);
        await editMaxMessageFromTelegram(bot, maxMid, caption, attachments);
        syncStoredPostAfterEdit(chain.max_chat_id, maxMid, caption, attachments);
        logger_1.logger.info('[tgChain] edited post synced', {
            chainId: chain.id,
            tgMessageId: msg.message_id,
            maxMessageMid: maxMid,
        });
    }
    catch (err) {
        const axiosDetail = axios_1.default.isAxiosError(err) && err.response
            ? { status: err.response.status, data: err.response.data }
            : undefined;
        logger_1.logger.error('[tgChain] edit sync failed', {
            chainId: chain.id,
            tgMessageId: msg.message_id,
            err,
            axiosDetail,
        });
        const errorsToday = chain.errors_today + 1;
        chain.errors_today = errorsToday;
        await (0, adminPanelState_1.updateTgChain)(chain.id, { errors_today: errorsToday });
    }
}
async function processChainMessageGroup(chain, messages, tgToken) {
    const sourceKey = chainSourceKey(chain);
    const pending = messages.filter((m) => {
        if (!(0, tgChannelMatch_1.telegramChannelMatchesTarget)(m.chat, sourceKey)) {
            return false;
        }
        if (isAlreadyForwarded(chain.id, m.message_id)) {
            return false;
        }
        if (isTgPostTooOldForForward(chain, m)) {
            markForwarded(chain.id, m, null, null);
            logger_1.logger.info('[tgChain] skip old TG post (before forward_posts_since)', {
                chainId: chain.id,
                tgMessageId: m.message_id,
                tgDate: m.date ?? null,
                forwardPostsSince: chain.forward_posts_since ?? chain.created_at,
            });
            return false;
        }
        return true;
    });
    if (pending.length === 0) {
        return;
    }
    const bot = botRef;
    if (!bot) {
        throw new Error('MAX bot not initialized (setTgChainForwarderBot)');
    }
    const isAlbum = pending.length > 1 || Boolean(pending[0]?.media_group_id);
    const attachComments = chain.add_comments_button !== false;
    try {
        let published = 0;
        let resultMid = null;
        if (isAlbum) {
            // Для media group > 10 отправляем несколькими постами (по 10 вложений).
            // Подпись Telegram переносим только в первый чанк, чтобы текст не дублировался.
            const ordered = [...pending].sort((a, b) => a.message_id - b.message_id);
            const chunks = chunkAlbumMessages(ordered);
            const firstCaption = pickAlbumCaption(ordered, chain.add_signature);
            for (let i = 0; i < chunks.length; i += 1) {
                const chunk = chunks[i];
                const chunkCaption = i === 0 ? firstCaption : '';
                resultMid = await forwardAlbumToMax(bot, chunk, tgToken, chain.max_chat_id, chunkCaption);
                if (typeof resultMid === 'string' && resultMid.trim() !== '') {
                    const maxMid = resultMid.trim();
                    let keepPublished = true;
                    if (attachComments) {
                        keepPublished = await (0, channelPostPublishGate_1.attachAndVerifyCommentsForForwardedPost)(bot, chain.max_chat_id, maxMid, {
                            chainId: chain.id,
                        });
                    }
                    if (keepPublished) {
                        published += 1;
                        for (const msg of chunk) {
                            markForwarded(chain.id, msg, maxMid, i);
                            syncTgMetadataOnForwardedPost(chain.max_chat_id, maxMid, chain, msg);
                        }
                        void (0, vkChainForwarder_1.onMaxPostPublished)(chain.max_chat_id, maxMid, i === 0 ? firstCaption : '', { tgToken, tgMessages: chunk }).catch((err) => {
                            logger_1.logger.warn('[tgChain] VK hook (album) failed', { chainId: chain.id, maxMid, err });
                        });
                    }
                    else {
                        logger_1.logger.warn('[tgChain] chunk not marked forwarded — comment gate rollback, TG retry later', {
                            chainId: chain.id,
                            maxMessageMid: maxMid,
                            chunkIndex: i,
                        });
                    }
                }
            }
        }
        else {
            const msg = pending[0];
            let caption = (msg.caption || msg.text || '').trim();
            if (chain.add_signature && caption) {
                caption = `${caption}\n\n— TG`;
            }
            resultMid = await forwardOneTgMessageToMax(bot, msg, tgToken, chain.max_chat_id, caption);
            if (typeof resultMid === 'string' && resultMid.trim() !== '') {
                const maxMid = resultMid.trim();
                let keepPublished = true;
                if (attachComments) {
                    keepPublished = await (0, channelPostPublishGate_1.attachAndVerifyCommentsForForwardedPost)(bot, chain.max_chat_id, maxMid, {
                        chainId: chain.id,
                    });
                }
                if (keepPublished) {
                    published = 1;
                    markForwarded(chain.id, msg, maxMid, null);
                    syncTgMetadataOnForwardedPost(chain.max_chat_id, maxMid, chain, msg);
                    void (0, vkChainForwarder_1.onMaxPostPublished)(chain.max_chat_id, maxMid, caption, {
                        tgToken,
                        tgMessages: [msg],
                    }).catch((err) => {
                        logger_1.logger.warn('[tgChain] VK hook (single) failed', { chainId: chain.id, maxMid, err });
                    });
                }
                else {
                    logger_1.logger.warn('[tgChain] post not marked forwarded — comment gate rollback, TG retry later', {
                        chainId: chain.id,
                        maxMessageMid: resultMid,
                        tgMessageId: msg.message_id,
                    });
                }
            }
        }
        // Если публикация не удалась, всё равно сохраняем payload по TG id:
        // это позволит позже корректно обработать edited_channel_post.
        for (const msg of pending) {
            const existing = getForwardedRecord(chain.id, msg.message_id);
            if (!existing) {
                markForwarded(chain.id, msg, null, null);
            }
        }
        if (published > 0) {
            const forwardedToday = chain.forwarded_today + published;
            chain.forwarded_today = forwardedToday;
            touchChainActivity(chain.id);
            await (0, adminPanelState_1.updateTgChain)(chain.id, { forwarded_today: forwardedToday });
            // thread chat/msg id — через handleDiscussionAutoForward / ensurePostThreadMapping
            logger_1.logger.info('[tgChain] forwarded', {
                chainId: chain.id,
                from: sourceKey,
                to: chain.max_chat_id,
                published,
                album: isAlbum,
                maxMessageMid: resultMid,
                photoCount: isAlbum ? pending.filter((m) => m.photo?.length).length : undefined,
                messageIds: pending.map((m) => m.message_id),
            });
        }
        await sleep(1_500 + Math.random() * 500);
    }
    catch (err) {
        const axiosDetail = axios_1.default.isAxiosError(err) && err.response
            ? { status: err.response.status, data: err.response.data }
            : undefined;
        logger_1.logger.error('[tgChain] forward failed', {
            chainId: chain.id,
            from: sourceKey,
            to: chain.max_chat_id,
            messageIds: pending.map((m) => m.message_id),
            err,
            axiosDetail,
        });
        const errorsToday = chain.errors_today + 1;
        chain.errors_today = errorsToday;
        await (0, adminPanelState_1.updateTgChain)(chain.id, { errors_today: errorsToday });
    }
}
async function flushReadyAlbums() {
    const ready = takeReadyAlbumEntries();
    if (ready.length === 0)
        return false;
    for (const entry of ready) {
        await processChainMessageGroup(entry.chain, entry.messages, entry.tgToken);
    }
    return true;
}
async function runTgChainsOnce() {
    // Сначала освобождаем альбомы, чей таймер буфера уже истёк.
    let receivedAny = await flushReadyAlbums();
    if (!botRef) {
        logger_1.logger.warn('[tgChain] MAX bot not set — skip tick');
        return receivedAny;
    }
    const chains = (await (0, adminPanelState_1.listTgChains)()).filter((c) => c.active && (c.forward_posts || c.forward_comments) && chainSourceKey(c) !== '');
    if (chains.length === 0) {
        const mainToken = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
        if (mainToken && (0, resolveTelegramBotToken_1.isMainTelegramBotToken)(mainToken)) {
            const n = await syncMainTelegramBotDiscoveryUpdates(mainToken, {
                timeoutSec: TG_CHAIN_LONG_POLL_SEC,
            });
            if (n > 0) {
                receivedAny = true;
            }
        }
        return receivedAny;
    }
    const tokenByChain = new Map();
    for (const chain of chains) {
        const t = resolveTgToken(chain);
        if (!t) {
            logger_1.logger.warn('[tgChain] no TG token for chain', { chainId: chain.id });
            continue;
        }
        tokenByChain.set(chain.id, t);
    }
    const tokenGroups = new Map();
    for (const chain of chains) {
        const token = tokenByChain.get(chain.id);
        if (!token)
            continue;
        const list = tokenGroups.get(token) ?? [];
        list.push(chain);
        tokenGroups.set(token, list);
    }
    for (const [tgToken, group] of tokenGroups) {
        await (0, integrationPlatformClient_1.ensureTelegramPollingMode)(tgToken);
        const pollErr = await (0, channelImportService_1.assertTelegramPollingReady)(tgToken);
        if (pollErr) {
            logger_1.logger.warn('[tgChain] telegram polling not ready', { err: pollErr, chainIds: group.map((c) => c.id) });
            continue;
        }
        const offset = getReaderOffset(tgToken);
        const includeMiniappBotUpdates = (0, resolveTelegramBotToken_1.isMainTelegramBotToken)(tgToken);
        const includeDiscussionMessages = group.some((c) => c.forward_comments);
        let batch;
        try {
            // При ожидающемся flush альбома не блокируемся длинным long-poll.
            const pendingAlbumDelayMs = getAlbumBufferDelayMs(Date.now(), tgToken);
            const timeoutSec = pendingAlbumDelayMs === null
                ? TG_CHAIN_LONG_POLL_SEC
                : Math.max(0, Math.min(TG_CHAIN_LONG_POLL_SEC, Math.ceil(pendingAlbumDelayMs / 1000)));
            batch = await (0, telegramReader_1.getTelegramUpdatesWithIds)(tgToken, offset, timeoutSec, {
                includeMiniappBotUpdates,
                includeDiscussionMessages,
            });
        }
        catch (err) {
            if (err instanceof telegramReader_1.TelegramGetUpdatesConflictError) {
                await sleep(10_000);
                continue;
            }
            if (axios_1.default.isAxiosError(err) && err.response?.status === 409) {
                logger_1.logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s');
                await sleep(10_000);
                continue;
            }
            throw err;
        }
        let nextOffset = offset;
        if (includeMiniappBotUpdates) {
            const rawUpdates = batch
                .map((u) => u.raw)
                .filter((u) => !!u);
            if (rawUpdates.length > 0) {
                await (0, telegramMiniappService_1.processTelegramMiniappBotUpdates)(tgToken, rawUpdates, botRef);
            }
        }
        const channelPosts = [];
        const editedChannelPosts = [];
        const editedMessages = [];
        const discussionMessages = [];
        for (const u of batch) {
            receivedAny = true;
            nextOffset = Math.max(nextOffset, u.update_id + 1);
            if (u.channel_post) {
                channelPosts.push(u.channel_post);
            }
            if (u.edited_channel_post) {
                editedChannelPosts.push(u.edited_channel_post);
            }
            if (u.edited_message) {
                editedMessages.push(u.edited_message);
            }
            if (u.message) {
                discussionMessages.push(u.message);
            }
        }
        for (const chain of group) {
            const sourceKey = chainSourceKey(chain);
            const forChain = channelPosts.filter((m) => (0, tgChannelMatch_1.telegramMessageMatchesTgChain)(m.chat, chain));
            if (channelPosts.length > 0 && forChain.length === 0) {
                logger_1.logger.debug('[tgChain] channel_post batch did not match chain', {
                    chainId: chain.id,
                    sourceKey,
                    tg_channel_id: chain.tg_channel_id ?? null,
                    tg_username: chain.tg_username ?? null,
                    sampleChatId: channelPosts[0]?.chat?.id,
                    sampleUsername: channelPosts[0]?.chat?.username ?? null,
                });
            }
            const chainGroups = groupChannelPostsForForward(forChain);
            for (const msgs of chainGroups) {
                const isMediaGroup = msgs.length > 1 || Boolean(msgs[0]?.media_group_id);
                if (isMediaGroup) {
                    for (const msg of msgs) {
                        queueAlbumMessage(chain, tgToken, msg);
                    }
                    continue;
                }
                await processChainMessageGroup(chain, msgs, tgToken);
            }
            const editedForChain = editedChannelPosts.filter((m) => (0, tgChannelMatch_1.telegramMessageMatchesTgChain)(m.chat, chain));
            for (const edited of editedForChain) {
                await processEditedChainMessage(chain, edited, tgToken);
            }
            const editedMessagesForChain = editedMessages.filter((m) => (0, tgChannelMatch_1.telegramMessageMatchesTgChain)(m.chat, chain));
            for (const edited of editedMessagesForChain) {
                await processEditedChainMessage(chain, edited, tgToken);
            }
            if (chain.forward_comments && discussionMessages.length > 0 && botRef) {
                const discussionChatId = await (0, postCommentMappingStore_1.resolveDiscussionChatId)(tgToken, chain);
                if (discussionChatId != null) {
                    for (const msg of discussionMessages) {
                        if (msg.chat.id !== discussionChatId) {
                            continue;
                        }
                        if ((0, tgCommentSyncService_1.isDiscussionAutoForward)(msg)) {
                            (0, tgCommentSyncService_1.handleDiscussionAutoForward)(msg, chain.id);
                            continue;
                        }
                        if (msg.reply_to_message) {
                            await (0, tgCommentSyncService_1.handleTgComment)(msg, chain, botRef, discussionChatId);
                        }
                    }
                }
            }
        }
        if (nextOffset > offset) {
            setReaderOffset(tgToken, nextOffset);
        }
        for (const chain of group) {
            touchChainActivity(chain.id);
        }
    }
    if (await flushReadyAlbums()) {
        receivedAny = true;
    }
    return receivedAny;
}
let loopStarted = false;
let watchdogStarted = false;
async function restartChainForwarder(chainId) {
    const existing = activeForwarders.get('__global__');
    if (existing) {
        existing.stop();
        activeForwarders.delete('__global__');
        globalForwarderHandle = null;
    }
    await sleep(3000);
    startForwarderLoop();
    logger_1.logger.info('[tgChain] watchdog: forwarder restarted', { chainId });
}
function startForwarderLoop() {
    if (globalForwarderHandle) {
        return;
    }
    let stopped = false;
    const loop = async () => {
        while (!stopped) {
            try {
                const hadUpdates = await runTgChainsOnce();
                if (!hadUpdates) {
                    const albumDelayMs = getAlbumBufferDelayMs();
                    if (albumDelayMs === null) {
                        await sleep(TG_CHAIN_IDLE_MS);
                    }
                    else {
                        await sleep(Math.min(TG_CHAIN_IDLE_MS, Math.max(50, albumDelayMs)));
                    }
                }
            }
            catch (err) {
                if (err instanceof telegramReader_1.TelegramGetUpdatesConflictError) {
                    logger_1.logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s');
                    await sleep(10_000);
                    continue;
                }
                if (axios_1.default.isAxiosError(err) && err.response?.status === 409) {
                    logger_1.logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s');
                    await sleep(10_000);
                    continue;
                }
                logger_1.logger.error('[tgChain] loop error', { err });
                await (0, alertService_1.sendAdminAlert)('forwarder_crash', 'Форвардер упал с ошибкой', {
                    error: String(err),
                });
                await sleep(TG_CHAIN_IDLE_MS);
            }
        }
    };
    void loop();
    globalForwarderHandle = {
        stop: () => {
            stopped = true;
        },
    };
    activeForwarders.set('__global__', globalForwarderHandle);
}
function startTgChainWatchdog() {
    if (watchdogStarted)
        return;
    watchdogStarted = true;
    setInterval(() => {
        void (async () => {
            const now = Date.now();
            const silentThresholdMs = 20 * 60 * 1000;
            for (const chain of (0, adminPanelState_1.listTgChainsSync)()) {
                if (!chain.forward_posts || !chain.active)
                    continue;
                const lastSeen = chainLastActivity.get(chain.id);
                if (!lastSeen)
                    continue;
                const silentMs = now - lastSeen;
                if (silentMs > silentThresholdMs) {
                    const restarts = chainRestartCount.get(chain.id) ?? 0;
                    logger_1.logger.warn('[tgChain] watchdog: chain silent, restarting forwarder', {
                        chainId: chain.id,
                        title: chain.max_title,
                        silentMinutes: Math.round(silentMs / 60000),
                        restartCount: restarts + 1,
                    });
                    await (0, alertService_1.sendAdminAlert)('chain_silent', `Цепочка молчит ${Math.round(silentMs / 60000)} мин`, {
                        chainId: chain.id,
                        title: chain.max_title,
                    });
                    chainRestartCount.set(chain.id, restarts + 1);
                    chainLastActivity.set(chain.id, now);
                    await restartChainForwarder(chain.id);
                }
            }
        })().catch((err) => {
            logger_1.logger.warn('[tgChain] watchdog error', { err });
        });
    }, 5 * 60 * 1000);
}
function startTgChainForwarder() {
    if (loopStarted)
        return;
    loopStarted = true;
    startTgChainWatchdog();
    logger_1.logger.info('[tgChain] forwarder started (long-poll channel_post)');
    startForwarderLoop();
}
//# sourceMappingURL=tgChainForwarder.js.map