"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscriberStore = exports.SubscriberStore = void 0;
const database_1 = require("../db/database");
const logger_1 = require("../utils/logger");
const adminActivityStore_1 = require("./adminActivityStore");
function isPositiveIntId(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
/**
 * Users who pressed Start in the bot — eligible for DM when a channel replies to their comment.
 */
class SubscriberStore {
    async loadFromDisk() {
        logger_1.logger.debug('subscriberStore: SQLite backend active, loadFromDisk noop');
    }
    addSubscriber(userId) {
        if (!isPositiveIntId(userId)) {
            return;
        }
        if (this.hasSubscriber(userId)) {
            return;
        }
        this.getStatements().insert.run(userId, JSON.stringify({ user_id: userId }));
        logger_1.logger.info('subscriberStore: addSubscriber', { userId });
        (0, adminActivityStore_1.pushAdminActivity)('new_subscriber', { user_id: userId });
    }
    hasSubscriber(userId) {
        if (!isPositiveIntId(userId)) {
            return false;
        }
        const row = this.getStatements().getById.get(userId);
        return row !== undefined;
    }
    removeSubscriber(userId) {
        if (!isPositiveIntId(userId)) {
            return;
        }
        const result = this.getStatements().deleteById.run(userId);
        if ((result.changes ?? 0) === 0) {
            return;
        }
        logger_1.logger.info('subscriberStore: removeSubscriber', { userId });
    }
    getAllSubscribers() {
        const rows = this.getStatements().listAll.all();
        return rows.map((row) => row.user_id);
    }
    /** Очистка файла подписчиков (опасная зона в админке). */
    clearAllSubscribers() {
        this.getStatements().deleteAll.run();
        logger_1.logger.warn('subscriberStore: clearAllSubscribers');
    }
    statements = null;
    getStatements() {
        if (this.statements) {
            return this.statements;
        }
        const db = (0, database_1.getDb)();
        this.statements = {
            getById: db.prepare('SELECT user_id FROM subscribers WHERE user_id = ?'),
            listAll: db.prepare('SELECT user_id FROM subscribers ORDER BY user_id ASC'),
            insert: db.prepare('INSERT OR IGNORE INTO subscribers (user_id, data) VALUES (?, ?)'),
            deleteById: db.prepare('DELETE FROM subscribers WHERE user_id = ?'),
            deleteAll: db.prepare('DELETE FROM subscribers'),
        };
        return this.statements;
    }
}
exports.SubscriberStore = SubscriberStore;
exports.subscriberStore = new SubscriberStore();
//# sourceMappingURL=subscriberStore.js.map