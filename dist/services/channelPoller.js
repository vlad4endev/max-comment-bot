"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.POLL_CONCURRENCY = void 0;
exports.runChannelPollerForChat = runChannelPollerForChat;
exports.runChannelPollerTick = runChannelPollerTick;
exports.startChannelPostPoller = startChannelPostPoller;
exports.restartChannelPostPoller = restartChannelPostPoller;
exports.stopChannelPostPoller = stopChannelPostPoller;
const p_limit_1 = __importDefault(require("p-limit"));
const adminRuntimeSettingsStore_1 = require("./adminRuntimeSettingsStore");
const channelRegistry_1 = require("./channelRegistry");
const logger_1 = require("../utils/logger");
const maxApiRetry_1 = require("../utils/maxApiRetry");
const channelPostActions_1 = require("./channelPostActions");
const postStore_1 = require("./postStore");
const MIN_POLL_INTERVAL_MS = 3_000;
const FETCH_COUNT = 10;
/** Exported for startup diagnostics. */
exports.POLL_CONCURRENCY = 5;
const DISABLE_AFTER_ERRORS = 5;
let intervalId;
let tickInFlight = false;
const errorCount = new Map();
function logTickFired() {
    const channels = channelRegistry_1.channelRegistry.getAllChannels();
    logger_1.logger.info('channelPoller: tick fired', {
        channelCount: channels.length,
        channels: channels.map((c) => c.chat_id),
    });
}
async function pollChannel(bot, channel, botUid) {
    const { messages } = await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.getMessages(channel.chat_id, { count: FETCH_COUNT }));
    logger_1.logger.info('channelPoller: getMessages result', {
        chatId: channel.chat_id,
        messageCount: messages.length,
        mids: messages.map((m) => m.body?.mid),
    });
    if (messages.length === 0) {
        logger_1.logger.info('channelPoller: no messages returned for channel', { chatId: channel.chat_id });
    }
    for (const message of messages) {
        const r = await (0, channelPostActions_1.tryAttachCommentsToChannelPost)(bot, message, {
            botUserId: botUid,
            channelChatIdOverride: channel.chat_id,
        });
        const logPayload = {
            chatId: channel.chat_id,
            mid: message.body?.mid,
            result: r,
        };
        if (!r.ok && r.reason === 'already_exists') {
            logger_1.logger.debug('channelPoller: tryAttach result', logPayload);
        }
        else {
            logger_1.logger.info('channelPoller: tryAttach result', logPayload);
        }
        if (r.ok) {
            logger_1.logger.info('channelPoller: button attached to new post', {
                channelChatId: channel.chat_id,
                mid: message.body.mid,
            });
        }
    }
}
async function pollChannelSafe(bot, channel, botUid) {
    try {
        await pollChannel(bot, channel, botUid);
        errorCount.delete(channel.chat_id);
    }
    catch (err) {
        const count = (errorCount.get(channel.chat_id) ?? 0) + 1;
        errorCount.set(channel.chat_id, count);
        logger_1.logger.error(`channelPoller: error for ${channel.chat_id} (${count}/${DISABLE_AFTER_ERRORS})`, err);
        if (count >= DISABLE_AFTER_ERRORS) {
            logger_1.logger.warn(`channelPoller: disabling channel ${channel.chat_id} after ${count} errors`);
            channelRegistry_1.channelRegistry.deactivate(channel.chat_id);
            errorCount.delete(channel.chat_id);
        }
    }
}
/**
 * One sweep for a single channel (admin «обновить кнопки»).
 */
async function runChannelPollerForChat(bot, chatId) {
    if (!(0, postStore_1.isMiniAppOpenUrlConfigured)()) {
        return;
    }
    const reg = channelRegistry_1.channelRegistry.getChannel(chatId);
    if (!reg || reg.type !== 'channel') {
        return;
    }
    const botUid = bot.botInfo?.user_id;
    try {
        const { messages } = await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.getMessages(chatId, { count: FETCH_COUNT }));
        for (const message of messages) {
            await (0, channelPostActions_1.tryAttachCommentsToChannelPost)(bot, message, {
                botUserId: botUid,
                channelChatIdOverride: chatId,
            });
        }
    }
    catch (err) {
        logger_1.logger.warn('channelPoller: runChannelPollerForChat failed', { chatId, err });
    }
}
/**
 * One sweep: for each registered channel, fetch recent messages and attach the comment button to new admin posts.
 */
async function runChannelPollerTick(bot) {
    if (!(0, postStore_1.isMiniAppOpenUrlConfigured)()) {
        return;
    }
    const channels = channelRegistry_1.channelRegistry.getAllChannels().filter((c) => c.type === 'channel');
    const botUid = bot.botInfo?.user_id;
    const limit = (0, p_limit_1.default)(exports.POLL_CONCURRENCY);
    await Promise.all(channels.map((c) => limit(() => pollChannelSafe(bot, c, botUid))));
}
/**
 * Starts periodic polling of registered channels. No-op if Mini App open URL is not configured.
 */
function startChannelPostPoller(bot, intervalMs) {
    if (!(0, postStore_1.isMiniAppOpenUrlConfigured)()) {
        logger_1.logger.info('channelPoller: disabled (BOT_NICKNAME / MINI_APP_URL not set for Mini App links)');
        return;
    }
    const fromStoreOrArg = intervalMs !== undefined && Number.isFinite(intervalMs)
        ? intervalMs
        : adminRuntimeSettingsStore_1.adminRuntimeSettingsStore.getPollIntervalMs();
    const ms = Math.max(MIN_POLL_INTERVAL_MS, fromStoreOrArg);
    stopChannelPostPoller();
    const channelCount = channelRegistry_1.channelRegistry
        .getAllChannels()
        .filter((c) => c.type === 'channel').length;
    logTickFired();
    void (async () => {
        try {
            await runChannelPollerTick(bot);
        }
        catch (err) {
            logger_1.logger.error('channelPoller: tick error', err);
        }
    })();
    intervalId = setInterval(() => {
        logTickFired();
        if (tickInFlight) {
            logger_1.logger.info('channelPoller: skipping tick (previous still running)');
            return;
        }
        tickInFlight = true;
        void (async () => {
            try {
                await runChannelPollerTick(bot);
            }
            catch (err) {
                logger_1.logger.error('channelPoller: tick error', err);
            }
            finally {
                tickInFlight = false;
            }
        })();
    }, ms);
    logger_1.logger.info('channelPoller: started', {
        channelCount,
        concurrency: exports.POLL_CONCURRENCY,
        intervalMs: ms,
        fetchCount: FETCH_COUNT,
    });
}
/**
 * Перезапуск таймера с разрешением из {@link adminRuntimeSettingsStore}.
 */
function restartChannelPostPoller(bot) {
    startChannelPostPoller(bot);
}
function stopChannelPostPoller() {
    if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
        logger_1.logger.info('channelPoller: stopped');
    }
}
//# sourceMappingURL=channelPoller.js.map