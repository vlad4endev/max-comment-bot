"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setTgChainForwarderBot = setTgChainForwarderBot;
exports.runTgChainsOnce = runTgChainsOnce;
exports.startTgChainForwarder = startTgChainForwarder;
const node_crypto_1 = require("node:crypto");
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const database_1 = require("../db/database");
const telegramReader_1 = require("../forwarder/telegramReader");
const adminPanelState_1 = require("../api/adminPanelState");
const channelImportService_1 = require("./channelImportService");
const channelPostActions_1 = require("./channelPostActions");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const tgChannelMatch_1 = require("../utils/tgChannelMatch");
const logger_1 = require("../utils/logger");
const maxApiRetry_1 = require("../utils/maxApiRetry");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Long-poll Telegram for new channel_post (сек). */
const TG_CHAIN_LONG_POLL_SEC = 25;
const TG_CHAIN_IDLE_MS = 3_000;
/** MIN gap between `sendMessageToChat` to the same MAX channel (API 429). */
const MAX_SEND_INTERVAL_MS = 2_500;
const UPLOAD_STAGGER_MS = 450;
const TG_CHAIN_MAX_API_RETRIES = 6;
const lastMaxSendAt = new Map();
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
function tokenKey(token) {
    return (0, node_crypto_1.createHash)('sha256').update(token).digest('hex').slice(0, 16);
}
function getReaderOffset(tgToken) {
    const row = (0, database_1.getDb)()
        .prepare('SELECT scan_next_offset FROM tg_chain_reader_offsets WHERE token_key = ?')
        .get(tokenKey(tgToken));
    return row?.scan_next_offset ?? 0;
}
function setReaderOffset(tgToken, offset) {
    (0, database_1.getDb)()
        .prepare(`INSERT INTO tg_chain_reader_offsets (token_key, scan_next_offset) VALUES (?, ?)
       ON CONFLICT(token_key) DO UPDATE SET scan_next_offset = excluded.scan_next_offset`)
        .run(tokenKey(tgToken), offset);
}
function chainSourceKey(chain) {
    if (chain.tg_channel_id && chain.tg_channel_id.trim() !== '') {
        return chain.tg_channel_id.trim();
    }
    const u = chain.tg_username.trim().replace(/^@/, '');
    return u ? `@${u}` : '';
}
function isAlreadyForwarded(chainId, messageId) {
    const row = (0, database_1.getDb)()
        .prepare('SELECT 1 FROM tg_chain_forwarded WHERE chain_id = ? AND tg_message_id = ?')
        .get(chainId, messageId);
    return !!row;
}
function markForwarded(chainId, messageId) {
    (0, database_1.getDb)()
        .prepare('INSERT OR IGNORE INTO tg_chain_forwarded (chain_id, tg_message_id) VALUES (?, ?)')
        .run(chainId, messageId);
}
function resolveTgToken(chain) {
    const fromChain = chain.bot_token?.trim();
    if (fromChain)
        return fromChain;
    return (process.env.TG_READER_BOT_TOKEN || '').trim() || (0, config_1.getTelegramToken)();
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
    if (msg.photo && msg.photo.length > 0) {
        const largest = msg.photo[msg.photo.length - 1];
        const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, largest.file_id);
        if (url) {
            const image = await maxApi(() => bot.api.uploadImage({ url }));
            await throttleMaxChatSend(chatId);
            const sent = await maxApi(() => bot.api.sendMessageToChat(chatId, messageText, {
                attachments: [image.toJson()],
            }));
            return sent.body?.mid ?? null;
        }
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
    if (caption.trim()) {
        await throttleMaxChatSend(chatId);
        const sent = await maxApi(() => bot.api.sendMessageToChat(chatId, caption.trim()));
        return sent.body?.mid ?? null;
    }
    return null;
}
/** Загружает все фото альбома и собирает одно image-вложение (несколько photos в одном посте MAX). */
async function buildAlbumImageAttachment(bot, photoMessages, tgToken) {
    const photosMap = {};
    let index = 0;
    for (let i = 0; i < photoMessages.length; i += 1) {
        const msg = photoMessages[i];
        if (!msg.photo?.length)
            continue;
        const largest = msg.photo[msg.photo.length - 1];
        const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, largest.file_id);
        if (!url)
            continue;
        const res = await axios_1.default.get(url, { responseType: 'arraybuffer' });
        const uploaded = await maxApi(() => bot.api.uploadImage({ source: Buffer.from(res.data) }));
        const json = uploaded.toJson();
        const token = json.payload?.token;
        if (token) {
            photosMap[String(index)] = { token };
            index++;
            if (i < photoMessages.length - 1) {
                await sleep(UPLOAD_STAGGER_MS);
            }
        }
    }
    if (index === 0)
        return null;
    if (index === 1) {
        return { type: 'image', payload: { token: photosMap['0'].token } };
    }
    return { type: 'image', payload: { photos: photosMap } };
}
/** Альбом TG → один пост MAX (все фото в одном сообщении, как в Telegram). */
async function forwardAlbumToMax(bot, messages, tgToken, maxChatId, addSignature) {
    const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(maxChatId) ?? maxChatId;
    const caption = pickAlbumCaption(messages, addSignature);
    const messageText = caption.trim() || '\u00a0';
    const photoMessages = messages.filter((m) => m.photo && m.photo.length > 0);
    const attachments = [];
    const imageAtt = await buildAlbumImageAttachment(bot, photoMessages, tgToken);
    if (imageAtt) {
        attachments.push(imageAtt);
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
    if (attachments.length === 0 && !caption.trim()) {
        return null;
    }
    await throttleMaxChatSend(chatId);
    const sent = await maxApi(() => bot.api.sendMessageToChat(chatId, messageText, {
        attachments: attachments.length > 0 ? attachments : undefined,
    }));
    return sent.body?.mid ?? null;
}
async function processChainMessageGroup(chain, messages, tgToken) {
    const sourceKey = chainSourceKey(chain);
    const pending = messages.filter((m) => (0, tgChannelMatch_1.telegramChannelMatchesTarget)(m.chat, sourceKey) && !isAlreadyForwarded(chain.id, m.message_id));
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
            resultMid = await forwardAlbumToMax(bot, pending, tgToken, chain.max_chat_id, chain.add_signature);
            if (resultMid) {
                published = 1;
                if (attachComments) {
                    const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chain.max_chat_id) ?? chain.max_chat_id;
                    const mid = resultMid;
                    await maxApi(() => (0, channelPostActions_1.ensurePostFromChannelMessage)(bot, chatId, mid));
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
            if (resultMid) {
                published = 1;
                if (attachComments) {
                    const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chain.max_chat_id) ?? chain.max_chat_id;
                    const mid = resultMid;
                    await maxApi(() => (0, channelPostActions_1.ensurePostFromChannelMessage)(bot, chatId, mid));
                }
            }
        }
        for (const msg of pending) {
            markForwarded(chain.id, msg.message_id);
        }
        if (published > 0) {
            const forwardedToday = chain.forwarded_today + published;
            chain.forwarded_today = forwardedToday;
            await (0, adminPanelState_1.updateTgChain)(chain.id, { forwarded_today: forwardedToday });
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
async function runTgChainsOnce() {
    if (!botRef) {
        logger_1.logger.warn('[tgChain] MAX bot not set — skip tick');
        return false;
    }
    const chains = (await (0, adminPanelState_1.listTgChains)()).filter((c) => c.active && c.forward_posts && chainSourceKey(c) !== '');
    if (chains.length === 0) {
        return false;
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
    let receivedAny = false;
    for (const [tgToken, group] of tokenGroups) {
        const pollErr = await (0, channelImportService_1.assertTelegramPollingReady)(tgToken);
        if (pollErr) {
            logger_1.logger.warn('[tgChain] telegram polling not ready', { err: pollErr });
            continue;
        }
        const offset = getReaderOffset(tgToken);
        const batch = await (0, telegramReader_1.getTelegramUpdatesWithIds)(tgToken, offset, TG_CHAIN_LONG_POLL_SEC);
        let nextOffset = offset;
        const channelPosts = [];
        for (const u of batch) {
            receivedAny = true;
            nextOffset = Math.max(nextOffset, u.update_id + 1);
            if (u.channel_post) {
                channelPosts.push(u.channel_post);
            }
        }
        for (const chain of group) {
            const sourceKey = chainSourceKey(chain);
            const forChain = channelPosts.filter((m) => (0, tgChannelMatch_1.telegramChannelMatchesTarget)(m.chat, sourceKey));
            const chainGroups = groupChannelPostsForForward(forChain);
            for (const msgs of chainGroups) {
                await processChainMessageGroup(chain, msgs, tgToken);
            }
        }
        if (nextOffset > offset) {
            setReaderOffset(tgToken, nextOffset);
        }
    }
    return receivedAny;
}
let loopStarted = false;
function startTgChainForwarder() {
    if (loopStarted)
        return;
    loopStarted = true;
    logger_1.logger.info('[tgChain] forwarder started (long-poll channel_post)');
    const loop = async () => {
        while (true) {
            try {
                const hadUpdates = await runTgChainsOnce();
                if (!hadUpdates) {
                    await sleep(TG_CHAIN_IDLE_MS);
                }
            }
            catch (err) {
                logger_1.logger.error('[tgChain] loop error', err);
                await sleep(TG_CHAIN_IDLE_MS);
            }
        }
    };
    void loop();
}
//# sourceMappingURL=tgChainForwarder.js.map