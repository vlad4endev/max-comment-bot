"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setTgChainForwarderBot = setTgChainForwarderBot;
exports.runTgChainsOnce = runTgChainsOnce;
exports.startTgChainForwarder = startTgChainForwarder;
const node_crypto_1 = require("node:crypto");
const config_1 = require("../config");
const database_1 = require("../db/database");
const telegramReader_1 = require("../forwarder/telegramReader");
const maxPublisher_1 = require("../forwarder/maxPublisher");
const adminPanelState_1 = require("../api/adminPanelState");
const channelImportService_1 = require("./channelImportService");
const channelPostActions_1 = require("./channelPostActions");
const postStore_1 = require("./postStore");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const tgChannelMatch_1 = require("../utils/tgChannelMatch");
const logger_1 = require("../utils/logger");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Long-poll Telegram for new channel_post (сек). */
const TG_CHAIN_LONG_POLL_SEC = 25;
const TG_CHAIN_IDLE_MS = 3_000;
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
async function forwardMessageToMax(msg, tgToken, maxToken, maxChatId, addSignature) {
    const maxChannelId = String(maxChatId);
    let text = (msg.text || msg.caption || '').trim();
    if (addSignature && text) {
        text = `${text}\n\n— TG`;
    }
    if (msg.photo && msg.photo.length > 0) {
        const largest = msg.photo[msg.photo.length - 1];
        const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, largest.file_id);
        if (url) {
            await (0, maxPublisher_1.sendPhotoToMax)(maxToken, maxChannelId, url, text);
            return;
        }
    }
    if (msg.video?.file_id) {
        const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, msg.video.file_id);
        if (url) {
            await (0, maxPublisher_1.sendVideoToMax)(maxToken, maxChannelId, url, text);
            return;
        }
    }
    if (msg.document?.file_id) {
        const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, msg.document.file_id);
        if (url) {
            await (0, maxPublisher_1.sendDocumentToMax)(maxToken, maxChannelId, url, text, {
                filename: msg.document.file_name,
                contentType: msg.document.mime_type,
            });
            return;
        }
    }
    if (text) {
        await (0, maxPublisher_1.sendTextToMax)(maxToken, maxChannelId, text);
    }
}
/** После публикации в MAX — кнопка «Комментарии» на свежем посте бота. */
async function attachCommentsButtonOnLatestBotPost(bot, maxChatId) {
    const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(maxChatId) ?? maxChatId;
    const botUid = bot.botInfo?.user_id;
    let messages = [];
    try {
        const res = await bot.api.getMessages(chatId, { count: 8 });
        messages = res.messages;
    }
    catch (err) {
        logger_1.logger.warn('[tgChain] getMessages for comment button failed', { chatId, err });
        return false;
    }
    for (const message of messages) {
        const mid = message.body?.mid;
        if (!mid)
            continue;
        if (botUid !== undefined && message.sender?.user_id !== botUid)
            continue;
        if (postStore_1.postStore.findPostByChannelMessage(chatId, mid))
            continue;
        const post = await (0, channelPostActions_1.ensurePostFromChannelMessage)(bot, chatId, mid);
        if (post) {
            logger_1.logger.info('[tgChain] comments button attached', { chatId, messageMid: mid, postId: post.post_id });
            return true;
        }
    }
    logger_1.logger.warn('[tgChain] no new bot post found for comment button', { chatId });
    return false;
}
async function processChainMessage(chain, msg, tgToken, maxToken) {
    const sourceKey = chainSourceKey(chain);
    if (!(0, tgChannelMatch_1.telegramChannelMatchesTarget)(msg.chat, sourceKey)) {
        return;
    }
    if (isAlreadyForwarded(chain.id, msg.message_id)) {
        return;
    }
    try {
        await forwardMessageToMax(msg, tgToken, maxToken, chain.max_chat_id, chain.add_signature);
        if (chain.add_comments_button !== false && botRef) {
            await sleep(600);
            await attachCommentsButtonOnLatestBotPost(botRef, chain.max_chat_id);
        }
        markForwarded(chain.id, msg.message_id);
        const forwardedToday = chain.forwarded_today + 1;
        chain.forwarded_today = forwardedToday;
        await (0, adminPanelState_1.updateTgChain)(chain.id, { forwarded_today: forwardedToday });
        logger_1.logger.info('[tgChain] forwarded', {
            chainId: chain.id,
            from: sourceKey,
            to: chain.max_chat_id,
            messageId: msg.message_id,
        });
        await sleep(800 + Math.random() * 400);
    }
    catch (err) {
        logger_1.logger.error('[tgChain] forward failed', {
            chainId: chain.id,
            from: sourceKey,
            to: chain.max_chat_id,
            err,
        });
        const errorsToday = chain.errors_today + 1;
        chain.errors_today = errorsToday;
        await (0, adminPanelState_1.updateTgChain)(chain.id, { errors_today: errorsToday });
    }
}
async function runTgChainsOnce() {
    const maxToken = (process.env.BOT_TOKEN || '').trim();
    if (!maxToken) {
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
        for (const u of batch) {
            receivedAny = true;
            nextOffset = Math.max(nextOffset, u.update_id + 1);
            const msg = u.channel_post;
            if (!msg)
                continue;
            for (const chain of group) {
                await processChainMessage(chain, msg, tgToken, maxToken);
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