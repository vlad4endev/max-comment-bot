"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runChannelPollerTick = runChannelPollerTick;
exports.startChannelPostPoller = startChannelPostPoller;
exports.stopChannelPostPoller = stopChannelPostPoller;
const logger_1 = require("../utils/logger");
const channelPostActions_1 = require("./channelPostActions");
const postStore_1 = require("./postStore");
const channelRegistry_1 = require("./channelRegistry");
const MIN_POLL_INTERVAL_MS = 3_000;
const DEFAULT_INTERVAL_MS = Math.max(MIN_POLL_INTERVAL_MS, parseInt(process.env.CHANNEL_POLL_INTERVAL_MS || '', 10) || 30_000);
const FETCH_COUNT = 10;
let intervalId;
let tickInFlight = false;
function logTickFired() {
    const channels = channelRegistry_1.channelRegistry.getAllChannels();
    logger_1.logger.info('channelPoller: tick fired', {
        channelCount: channels.length,
        channels: channels.map((c) => c.chat_id),
    });
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
    for (const c of channels) {
        try {
            const { messages } = await bot.api.getMessages(c.chat_id, { count: FETCH_COUNT });
            logger_1.logger.info('channelPoller: getMessages result', {
                chatId: c.chat_id,
                messageCount: messages.length,
                mids: messages.map((m) => m.body?.mid),
            });
            if (messages.length === 0) {
                logger_1.logger.info('channelPoller: no messages returned for channel', { chatId: c.chat_id });
            }
            for (const message of messages) {
                const r = await (0, channelPostActions_1.tryAttachCommentsToChannelPost)(bot, message, {
                    botUserId: botUid,
                    channelChatIdOverride: c.chat_id,
                });
                logger_1.logger.info('channelPoller: tryAttach result', {
                    chatId: c.chat_id,
                    mid: message.body?.mid,
                    result: r,
                });
                if (r.ok) {
                    logger_1.logger.info('channelPoller: button attached to new post', {
                        channelChatId: c.chat_id,
                        mid: message.body.mid,
                    });
                }
            }
        }
        catch (err) {
            logger_1.logger.warn('channelPoller: failed for channel', { chatId: c.chat_id, err });
        }
    }
}
/**
 * Starts periodic polling of registered channels. No-op if Mini App open URL is not configured.
 */
function startChannelPostPoller(bot, intervalMs = DEFAULT_INTERVAL_MS) {
    if (!(0, postStore_1.isMiniAppOpenUrlConfigured)()) {
        logger_1.logger.info('channelPoller: disabled (BOT_NICKNAME / MINI_APP_URL not set for Mini App links)');
        return;
    }
    const ms = Math.max(MIN_POLL_INTERVAL_MS, intervalMs);
    stopChannelPostPoller();
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
    logger_1.logger.info(`channelPoller: started (interval ${ms / 1000}s, count=${FETCH_COUNT})`);
}
function stopChannelPostPoller() {
    if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
        logger_1.logger.info('channelPoller: stopped');
    }
}
//# sourceMappingURL=channelPoller.js.map