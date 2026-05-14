"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runChannelPollerTick = runChannelPollerTick;
exports.startChannelPostPoller = startChannelPostPoller;
exports.stopChannelPostPoller = stopChannelPostPoller;
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const channelPostActions_1 = require("./channelPostActions");
const channelRegistry_1 = require("./channelRegistry");
const DEFAULT_INTERVAL_MS = 30_000;
const FETCH_COUNT = 10;
let intervalId;
let tickInFlight = false;
/**
 * One sweep: for each registered channel, fetch recent messages and attach the comment button to new admin posts.
 */
async function runChannelPollerTick(bot) {
    if (!config_1.config.miniAppUrl) {
        return;
    }
    const channels = channelRegistry_1.channelRegistry.getAllChannels().filter((c) => c.type === 'channel');
    const botUid = bot.botInfo?.user_id;
    for (const c of channels) {
        try {
            const { messages } = await bot.api.getMessages(c.chat_id, { count: FETCH_COUNT });
            for (const message of messages) {
                const r = await (0, channelPostActions_1.tryAttachCommentsToChannelPost)(bot, message, {
                    botUserId: botUid,
                    channelChatIdOverride: c.chat_id,
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
 * Starts periodic polling of registered channels. No-op if {@link config.miniAppUrl} is unset.
 */
function startChannelPostPoller(bot, intervalMs = DEFAULT_INTERVAL_MS) {
    if (!config_1.config.miniAppUrl) {
        logger_1.logger.info('channelPoller: disabled (MINI_APP_URL not set)');
        return;
    }
    stopChannelPostPoller();
    void runChannelPollerTick(bot);
    intervalId = setInterval(() => {
        if (tickInFlight) {
            logger_1.logger.debug('channelPoller: skipping tick (previous still running)');
            return;
        }
        tickInFlight = true;
        void runChannelPollerTick(bot)
            .catch((err) => {
            logger_1.logger.error('channelPoller: tick error', err);
        })
            .finally(() => {
            tickInFlight = false;
        });
    }, intervalMs);
    logger_1.logger.info(`channelPoller: started (interval ${intervalMs / 1000}s, count=${FETCH_COUNT})`);
}
function stopChannelPostPoller() {
    if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
        logger_1.logger.info('channelPoller: stopped');
    }
}
//# sourceMappingURL=channelPoller.js.map