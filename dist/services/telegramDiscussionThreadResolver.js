"use strict";
/**
 * Восстанавливает tg_thread_chat_id / tg_thread_msg_id для post_comment_mapping,
 * если авто-репост канала в группу обсуждений был пропущен (бот не был в группе и т.п.).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensurePostThreadMapping = ensurePostThreadMapping;
const telegram_1 = require("telegram");
const adminPanelState_1 = require("../api/adminPanelState");
const logger_1 = require("../utils/logger");
const postCommentMappingStore_1 = require("./postCommentMappingStore");
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const mtprotoConfigStore_1 = require("./mtprotoConfigStore");
const telegramUserArchive_1 = require("./telegramUserArchive");
function resolveBotTokenForChain(chain) {
    const fromChain = chain.bot_token?.trim();
    if (fromChain) {
        return fromChain;
    }
    return (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
}
function resolveChannelKey(chain, mapping) {
    const fromChainId = chain.tg_channel_id?.trim();
    if (fromChainId) {
        return fromChainId;
    }
    const username = chain.tg_username?.trim();
    if (username) {
        return username.startsWith('@') ? username : `@${username}`;
    }
    if (typeof mapping.tg_chat_id === 'number') {
        return String(mapping.tg_chat_id);
    }
    return null;
}
function peerIdToBotChatId(peerId) {
    if (peerId instanceof telegram_1.Api.PeerChannel) {
        return Number(`-100${peerId.channelId}`);
    }
    if (peerId instanceof telegram_1.Api.PeerChat) {
        return -peerId.chatId;
    }
    return null;
}
function extractThreadFromDiscussionMessage(result) {
    if (!(result instanceof telegram_1.Api.messages.DiscussionMessage)) {
        return null;
    }
    for (const raw of result.messages ?? []) {
        if (!(raw instanceof telegram_1.Api.Message)) {
            continue;
        }
        const threadMsgId = raw.id;
        if (typeof threadMsgId !== 'number' || threadMsgId <= 0) {
            continue;
        }
        const threadChatId = peerIdToBotChatId(raw.peerId);
        if (threadChatId != null) {
            return { threadChatId, threadMsgId };
        }
    }
    return null;
}
async function resolveThreadViaMtproto(chain, mapping) {
    const mtproto = (0, mtprotoConfigStore_1.resolveMtprotoCredentials)();
    if (!(0, mtprotoConfigStore_1.isMtprotoSessionReady)()) {
        logger_1.logger.debug('[discussionThreadResolver] MTProto session not configured', {
            chainId: chain.id,
            maxMid: mapping.max_mid,
            mtprotoSource: mtproto.source,
        });
        return null;
    }
    if (typeof mapping.tg_msg_id !== 'number' || mapping.tg_msg_id <= 0) {
        return null;
    }
    const channelKey = resolveChannelKey(chain, mapping);
    if (!channelKey) {
        return null;
    }
    const client = await (0, telegramUserArchive_1.connectTelegramUserClient)();
    try {
        const channelPeer = await (0, telegramUserArchive_1.resolveTelegramChannelEntity)(client, channelKey);
        const result = await client.invoke(new telegram_1.Api.messages.GetDiscussionMessage({
            peer: channelPeer,
            msgId: mapping.tg_msg_id,
        }));
        const extracted = extractThreadFromDiscussionMessage(result);
        if (extracted) {
            logger_1.logger.info('[discussionThreadResolver] resolved thread via GetDiscussionMessage', {
                chainId: chain.id,
                channelMsgId: mapping.tg_msg_id,
                maxMid: mapping.max_mid,
                threadChatId: extracted.threadChatId,
                threadMsgId: extracted.threadMsgId,
            });
        }
        return extracted;
    }
    catch (err) {
        logger_1.logger.warn('[discussionThreadResolver] GetDiscussionMessage failed', {
            chainId: chain.id,
            channelMsgId: mapping.tg_msg_id,
            maxMid: mapping.max_mid,
            err,
        });
        return null;
    }
    finally {
        await client.disconnect();
    }
}
/**
 * Дополняет post_comment_mapping полями треда обсуждения, если они ещё не заданы.
 * @returns mapping с заполненными thread id или null, если восстановить не удалось
 */
async function ensurePostThreadMapping(maxMid) {
    const normalized = maxMid.trim();
    if (!normalized) {
        return null;
    }
    let mapping = (0, postCommentMappingStore_1.findMappingByMaxMid)(normalized);
    if (!mapping) {
        return null;
    }
    if (mapping.tg_thread_chat_id && mapping.tg_thread_msg_id) {
        return mapping;
    }
    const chain = (0, adminPanelState_1.listTgChainsSync)().find((c) => c.id === mapping.chain_id);
    if (!chain || chain.forward_comments !== true) {
        return null;
    }
    const token = resolveBotTokenForChain(chain);
    let threadChatId = mapping.tg_thread_chat_id;
    let threadMsgId = mapping.tg_thread_msg_id;
    if (threadChatId == null) {
        threadChatId = await (0, postCommentMappingStore_1.resolveDiscussionChatId)(token, chain);
    }
    if (threadMsgId == null) {
        const resolved = await resolveThreadViaMtproto(chain, mapping);
        if (resolved) {
            threadChatId = resolved.threadChatId;
            threadMsgId = resolved.threadMsgId;
        }
    }
    if (threadChatId != null &&
        threadMsgId != null &&
        typeof mapping.tg_msg_id === 'number' &&
        mapping.tg_msg_id > 0) {
        (0, postCommentMappingStore_1.linkThreadMessageToChannelPost)(mapping.chain_id, mapping.tg_msg_id, threadChatId, threadMsgId);
        mapping = (0, postCommentMappingStore_1.findMappingByMaxMid)(normalized);
        logger_1.logger.info('[discussionThreadResolver] ensured post thread mapping', {
            maxMid: normalized,
            chainId: mapping?.chain_id ?? null,
            threadChatId,
            threadMsgId,
        });
        return mapping;
    }
    logger_1.logger.warn('[discussionThreadResolver] could not ensure thread mapping', {
        maxMid: normalized,
        chainId: mapping.chain_id,
        channelMsgId: mapping.tg_msg_id,
        threadChatId,
        threadMsgId,
        mtprotoReady: (0, mtprotoConfigStore_1.isMtprotoSessionReady)(),
        mtprotoSource: (0, mtprotoConfigStore_1.resolveMtprotoCredentials)().source,
    });
    return null;
}
//# sourceMappingURL=telegramDiscussionThreadResolver.js.map