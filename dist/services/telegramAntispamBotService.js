"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTelegramAntispamBotToken = exports.isTelegramAntispamBotConfigured = void 0;
exports.tryBlockTelegramCommentByAntispam = tryBlockTelegramCommentByAntispam;
exports.runTelegramAntispamBotOnce = runTelegramAntispamBotOnce;
exports.startTelegramAntispamBotPoller = startTelegramAntispamBotPoller;
const axios_1 = __importDefault(require("axios"));
const adminPanelState_1 = require("../api/adminPanelState");
const telegramReader_1 = require("../forwarder/telegramReader");
const commentSyncGuard_1 = require("../utils/commentSyncGuard");
const commentSyncFilter_1 = require("../utils/commentSyncFilter");
const logger_1 = require("../utils/logger");
const channelImportService_1 = require("./channelImportService");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const postCommentMappingStore_1 = require("./postCommentMappingStore");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const resolveTelegramAntispamBotToken_1 = require("./resolveTelegramAntispamBotToken");
Object.defineProperty(exports, "isTelegramAntispamBotConfigured", { enumerable: true, get: function () { return resolveTelegramAntispamBotToken_1.isTelegramAntispamBotConfigured; } });
Object.defineProperty(exports, "resolveTelegramAntispamBotToken", { enumerable: true, get: function () { return resolveTelegramAntispamBotToken_1.resolveTelegramAntispamBotToken; } });
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const antispamService_1 = require("./antispamService");
const telegramAntispamEnforcement_1 = require("./telegramAntispamEnforcement");
const telegramMainBotOffsetStore_1 = require("./telegramMainBotOffsetStore");
function isDiscussionAutoForwardMessage(message) {
    return Boolean(message.is_automatic_forward ||
        message.forward_origin?.type === 'channel' ||
        (message.sender_chat && message.forward_from_message_id != null));
}
const TG_ANTISPAM_LONG_POLL_SEC = 25;
const TG_ANTISPAM_IDLE_MS = 3_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function resolveEnforcementToken(chain, override) {
    const dedicated = (0, resolveTelegramAntispamBotToken_1.resolveTelegramAntispamBotToken)();
    if (dedicated) {
        return dedicated;
    }
    return override?.trim() || chain.bot_token?.trim() || (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
}
/**
 * Проверка и блокировка спам-комментария в TG-обсуждении.
 * @returns true если комментарий заблокирован.
 */
async function tryBlockTelegramCommentByAntispam(message, chain, discussionChatId, tgCommentId, enforcementToken) {
    const text = (message.text || message.caption || '').trim();
    if (!text ||
        (0, commentSyncFilter_1.isMaxAdminReplyInTelegram)(text) ||
        (0, commentSyncFilter_1.isMaxCommentInTelegram)(text) ||
        (0, commentSyncFilter_1.isTelegramCommentMarkedAnsweredInMax)(text)) {
        return false;
    }
    const token = resolveEnforcementToken(chain, enforcementToken);
    if (!token) {
        return false;
    }
    const maxChatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chain.max_chat_id) ?? chain.max_chat_id;
    const isAdmin = await (0, commentSyncFilter_1.isTgCommentFromAdmin)(message, token, chain, discussionChatId);
    const { userId, username: authorName } = (0, commentSyncFilter_1.resolveTgCommentAuthor)(message, chain, discussionChatId);
    const antispam = (0, antispamService_1.evaluateComment)({
        text,
        userId,
        username: authorName,
        channelChatId: maxChatId,
        source: 'telegram',
        isChannelAdmin: isAdmin,
    });
    if (antispam.allowed) {
        return false;
    }
    const telegramUserId = typeof message.from?.id === 'number' ? message.from.id : null;
    await (0, telegramAntispamEnforcement_1.enforceTelegramAntispamAction)({
        token,
        chatId: message.chat.id,
        messageId: tgCommentId,
        telegramUserId,
        channelChatId: maxChatId,
        evaluation: antispam,
    });
    (0, commentSyncGuard_1.markCommentSynced)(`tg:${tgCommentId}`);
    logger_1.logger.info('[antispam/tg] blocked comment', {
        chainId: chain.id,
        tgCommentId,
        spamScore: antispam.spamScore,
        reason: antispam.reason,
        action: antispam.action,
        outcome: antispam.outcome,
        dedicatedBot: (0, resolveTelegramAntispamBotToken_1.isTelegramAntispamBotConfigured)(),
    });
    return true;
}
async function buildDiscussionChainMap(token) {
    const map = new Map();
    for (const chain of (0, adminPanelState_1.listTgChainsSync)()) {
        if (!chain.active || !chain.forward_comments) {
            continue;
        }
        const discussionId = await (0, postCommentMappingStore_1.resolveDiscussionChatId)(token, chain);
        if (discussionId == null) {
            continue;
        }
        const list = map.get(discussionId) ?? [];
        list.push(chain);
        map.set(discussionId, list);
    }
    return map;
}
function pickChainForDiscussion(chains) {
    return chains[0] ?? null;
}
async function runTelegramAntispamBotOnce() {
    const token = (0, resolveTelegramAntispamBotToken_1.resolveTelegramAntispamBotToken)();
    if (!token) {
        return false;
    }
    await (0, integrationPlatformClient_1.ensureTelegramPollingMode)(token);
    const pollErr = await (0, channelImportService_1.assertTelegramPollingReady)(token);
    if (pollErr) {
        logger_1.logger.warn('[antispamBot] polling not ready', { err: pollErr });
        return false;
    }
    const discussionMap = await buildDiscussionChainMap(token);
    if (discussionMap.size === 0) {
        return false;
    }
    const offset = (0, telegramMainBotOffsetStore_1.getTelegramBotUpdatesOffset)(token);
    let batch;
    try {
        batch = await (0, telegramReader_1.getTelegramUpdatesWithIds)(token, offset, TG_ANTISPAM_LONG_POLL_SEC, {
            includeDiscussionMessages: true,
        });
    }
    catch (err) {
        if (err instanceof telegramReader_1.TelegramGetUpdatesConflictError) {
            await sleep(10_000);
            return false;
        }
        if (axios_1.default.isAxiosError(err) && err.response?.status === 409) {
            logger_1.logger.warn('[antispamBot] 409 conflict — waiting 10s');
            await sleep(10_000);
            return false;
        }
        throw err;
    }
    let nextOffset = offset;
    let handledAny = false;
    for (const upd of batch) {
        nextOffset = Math.max(nextOffset, upd.update_id + 1);
        const msg = upd.message;
        if (!msg) {
            continue;
        }
        const chains = discussionMap.get(msg.chat.id);
        if (!chains?.length) {
            continue;
        }
        if (isDiscussionAutoForwardMessage(msg)) {
            continue;
        }
        if (!msg.reply_to_message) {
            continue;
        }
        if ((0, commentSyncGuard_1.isCommentSynced)(`tg:${msg.message_id}`)) {
            continue;
        }
        const chain = pickChainForDiscussion(chains);
        if (!chain) {
            continue;
        }
        const blocked = await tryBlockTelegramCommentByAntispam(msg, chain, msg.chat.id, msg.message_id, token);
        if (blocked) {
            handledAny = true;
        }
    }
    if (nextOffset > offset) {
        (0, telegramMainBotOffsetStore_1.setTelegramBotUpdatesOffset)(token, nextOffset);
    }
    return handledAny || batch.length > 0;
}
let pollerStarted = false;
function startTelegramAntispamBotPoller() {
    if (!(0, resolveTelegramAntispamBotToken_1.isTelegramAntispamBotConfigured)()) {
        logger_1.logger.info('[antispamBot] TG_ANTISPAM_BOT_TOKEN not set — antispam via main CommentBot');
        return () => { };
    }
    if (pollerStarted) {
        return () => { };
    }
    pollerStarted = true;
    let stopped = false;
    const loop = async () => {
        while (!stopped) {
            try {
                const hadUpdates = await runTelegramAntispamBotOnce();
                if (!hadUpdates) {
                    await sleep(TG_ANTISPAM_IDLE_MS);
                }
            }
            catch (err) {
                if (err instanceof telegramReader_1.TelegramGetUpdatesConflictError) {
                    logger_1.logger.warn('[antispamBot] 409 conflict — waiting 10s');
                    await sleep(10_000);
                    continue;
                }
                if (axios_1.default.isAxiosError(err) && err.response?.status === 409) {
                    logger_1.logger.warn('[antispamBot] 409 conflict — waiting 10s');
                    await sleep(10_000);
                    continue;
                }
                logger_1.logger.error('[antispamBot] loop error', { err });
                await sleep(TG_ANTISPAM_IDLE_MS);
            }
        }
    };
    void loop();
    logger_1.logger.info('[antispamBot] dedicated antispam bot poller started');
    return () => {
        stopped = true;
        pollerStarted = false;
    };
}
//# sourceMappingURL=telegramAntispamBotService.js.map