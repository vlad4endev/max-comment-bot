"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.channelNotifyLinkStore = exports.ChannelNotifyLinkStore = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const logger_1 = require("../utils/logger");
const DEFAULT_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'channel-notify-links.json');
function isLinkRow(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const o = value;
    return (typeof o.user_id === 'number' &&
        Number.isInteger(o.user_id) &&
        o.user_id > 0 &&
        typeof o.channel_chat_id === 'number' &&
        Number.isInteger(o.channel_chat_id) &&
        o.channel_chat_id !== 0 &&
        typeof o.joined_at === 'string');
}
/**
 * JSON-backed opt-in: which user_ids receive new-comment DMs for which channel.
 * When a channel has at least one link, only linked users are notified (instead of all API admins).
 */
class ChannelNotifyLinkStore {
    links = [];
    filePath;
    persistChain = Promise.resolve();
    constructor(filePath = DEFAULT_PATH) {
        this.filePath = filePath;
    }
    async loadFromDisk() {
        try {
            const raw = await (0, promises_1.readFile)(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || !('links' in parsed)) {
                logger_1.logger.warn('channelNotifyLinkStore: invalid file shape, starting empty');
                this.links.length = 0;
                return;
            }
            const list = parsed.links;
            if (!Array.isArray(list)) {
                this.links.length = 0;
                return;
            }
            this.links.length = 0;
            for (const item of list) {
                if (isLinkRow(item)) {
                    this.links.push(item);
                }
            }
            logger_1.logger.info(`channelNotifyLinkStore: loaded ${this.links.length} link(s)`);
        }
        catch (e) {
            const err = e;
            if (err.code === 'ENOENT') {
                logger_1.logger.debug('channelNotifyLinkStore: file missing, empty store');
                return;
            }
            logger_1.logger.error('channelNotifyLinkStore: failed to read file', e);
        }
    }
    /**
     * Distinct user ids registered for comment notifications on this channel (order preserved).
     */
    getUserIdsForChannel(channelChatId) {
        const seen = new Set();
        const out = [];
        for (const row of this.links) {
            if (row.channel_chat_id !== channelChatId || seen.has(row.user_id)) {
                continue;
            }
            seen.add(row.user_id);
            out.push(row.user_id);
        }
        return out;
    }
    isLinked(userId, channelChatId) {
        return this.links.some((r) => r.user_id === userId && r.channel_chat_id === channelChatId);
    }
    register(userId, channelChatId) {
        if (this.isLinked(userId, channelChatId)) {
            return;
        }
        this.links.push({
            user_id: userId,
            channel_chat_id: channelChatId,
            joined_at: new Date().toISOString(),
        });
        this.queuePersist();
        logger_1.logger.info('channelNotifyLinkStore: registered', { userId, channelChatId });
    }
    /** When the bot leaves a channel, drop all opt-ins for that chat. */
    removeAllForChannel(channelChatId) {
        const before = this.links.length;
        const next = this.links.filter((r) => r.channel_chat_id !== channelChatId);
        if (next.length === before) {
            return;
        }
        this.links.length = 0;
        this.links.push(...next);
        this.queuePersist();
        logger_1.logger.info('channelNotifyLinkStore: removed links for channel', { channelChatId });
    }
    queuePersist() {
        this.persistChain = this.persistChain
            .then(() => this.persist())
            .catch((e) => {
            logger_1.logger.error('channelNotifyLinkStore: persist error', e);
        });
    }
    async persist() {
        const dir = (0, node_path_1.dirname)(this.filePath);
        await (0, promises_1.mkdir)(dir, { recursive: true });
        const body = { links: [...this.links] };
        await (0, promises_1.writeFile)(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    }
}
exports.ChannelNotifyLinkStore = ChannelNotifyLinkStore;
exports.channelNotifyLinkStore = new ChannelNotifyLinkStore();
//# sourceMappingURL=channelNotifyLinkStore.js.map