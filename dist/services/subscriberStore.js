"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscriberStore = exports.SubscriberStore = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const logger_1 = require("../utils/logger");
const adminActivityStore_1 = require("./adminActivityStore");
const DEFAULT_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'subscribers.json');
function isPositiveIntId(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
/**
 * Users who pressed Start in the bot — eligible for DM when a channel replies to their comment.
 */
class SubscriberStore {
    subscribers = new Set();
    filePath;
    persistChain = Promise.resolve();
    constructor(filePath = DEFAULT_PATH) {
        this.filePath = filePath;
    }
    async loadFromDisk() {
        try {
            const raw = await (0, promises_1.readFile)(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || !('subscribers' in parsed)) {
                logger_1.logger.warn('subscriberStore: invalid file shape, starting empty');
                this.subscribers.clear();
                return;
            }
            const list = parsed.subscribers;
            if (!Array.isArray(list)) {
                this.subscribers.clear();
                return;
            }
            this.subscribers.clear();
            for (const id of list) {
                if (isPositiveIntId(id)) {
                    this.subscribers.add(id);
                }
            }
            logger_1.logger.info(`subscriberStore: loaded ${this.subscribers.size} subscriber(s)`);
        }
        catch (e) {
            const err = e;
            if (err.code === 'ENOENT') {
                logger_1.logger.debug('subscriberStore: file missing, empty store');
                return;
            }
            logger_1.logger.error('subscriberStore: failed to read file', e);
        }
    }
    addSubscriber(userId) {
        if (!isPositiveIntId(userId)) {
            return;
        }
        if (this.subscribers.has(userId)) {
            return;
        }
        this.subscribers.add(userId);
        this.queuePersist();
        logger_1.logger.info('subscriberStore: addSubscriber', { userId });
        (0, adminActivityStore_1.pushAdminActivity)('new_subscriber', { user_id: userId });
    }
    hasSubscriber(userId) {
        if (!isPositiveIntId(userId)) {
            return false;
        }
        return this.subscribers.has(userId);
    }
    removeSubscriber(userId) {
        if (!isPositiveIntId(userId)) {
            return;
        }
        if (!this.subscribers.delete(userId)) {
            return;
        }
        this.queuePersist();
        logger_1.logger.info('subscriberStore: removeSubscriber', { userId });
    }
    getAllSubscribers() {
        return [...this.subscribers].sort((a, b) => a - b);
    }
    /** Очистка файла подписчиков (опасная зона в админке). */
    clearAllSubscribers() {
        if (this.subscribers.size === 0) {
            return;
        }
        this.subscribers.clear();
        this.queuePersist();
        logger_1.logger.warn('subscriberStore: clearAllSubscribers');
    }
    queuePersist() {
        this.persistChain = this.persistChain
            .then(() => this.persist())
            .catch((e) => {
            logger_1.logger.error('subscriberStore: persist error', e);
        });
    }
    async persist() {
        const dir = (0, node_path_1.dirname)(this.filePath);
        await (0, promises_1.mkdir)(dir, { recursive: true });
        const body = { subscribers: this.getAllSubscribers() };
        await (0, promises_1.writeFile)(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    }
}
exports.SubscriberStore = SubscriberStore;
exports.subscriberStore = new SubscriberStore();
//# sourceMappingURL=subscriberStore.js.map