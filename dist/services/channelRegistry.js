"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.channelRegistry = exports.ChannelRegistry = void 0;
exports.setChannelRegistryChangeHandler = setChannelRegistryChangeHandler;
const adminActivityStore_1 = require("./adminActivityStore");
const database_1 = require("../db/database");
const logger_1 = require("../utils/logger");
let onRegistryChanged = null;
/** Регистрирует колбэк (поллер каналов) без циклического import. */
function setChannelRegistryChangeHandler(handler) {
    onRegistryChanged = handler;
}
function emitRegistryChanged() {
    try {
        onRegistryChanged?.();
    }
    catch (err) {
        logger_1.logger.warn('channelRegistry: onRegistryChanged handler failed', err);
    }
}
function isChatType(value) {
    return value === 'dialog' || value === 'chat' || value === 'channel';
}
function isChannelRecord(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const o = value;
    return (typeof o.chat_id === 'number' &&
        Number.isInteger(o.chat_id) &&
        (o.title === null || typeof o.title === 'string') &&
        isChatType(o.type) &&
        typeof o.date_added === 'string');
}
class ChannelRegistry {
    statements = null;
    async loadFromDisk() {
        logger_1.logger.debug('channelRegistry: SQLite backend active, loadFromDisk noop');
    }
    /**
     * Сохраняет или обновляет канал. Для уже известного `chat_id` поле {@link ChannelRecord.date_added} не меняется.
     */
    saveChannel(chatId, chatData) {
        const existing = this.getChannel(chatId);
        const record = existing
            ? {
                ...existing,
                title: chatData.title ?? existing.title,
                type: chatData.type,
            }
            : {
                chat_id: chatId,
                title: chatData.title,
                type: chatData.type,
                date_added: new Date().toISOString(),
            };
        const isNew = !existing;
        this.getStatements().upsert.run(record.chat_id, record.title, record.type, record.date_added, 1, JSON.stringify(record));
        if (isNew) {
            (0, adminActivityStore_1.pushAdminActivity)('channel_added', {
                chat_id: chatId,
                title: record.title,
            });
        }
        emitRegistryChanged();
    }
    /**
     * Исключает канал из поллера и реестра без удаления постов/комментариев (повторные ошибки API).
     */
    deactivate(chatId) {
        return this.removeChannel(chatId);
    }
    /**
     * Удаляет канал из реестра. Возвращает удалённую запись (для текста уведомления) или `null`, если чата не было.
     */
    removeChannel(chatId) {
        const prev = this.getChannel(chatId);
        if (prev === null) {
            return null;
        }
        this.getStatements().deleteById.run(chatId);
        emitRegistryChanged();
        return prev;
    }
    /**
     * Возвращает запись по `chat_id` или `null`.
     */
    getChannel(chatId) {
        const row = this.getStatements().getById.get(chatId);
        if (!row) {
            return null;
        }
        return this.parseRow(row);
    }
    /**
     * Все каналы из текущего реестра, отсортированные по `chat_id`.
     */
    getAllChannels() {
        const rows = this.getStatements().listAll.all();
        return rows.map((row) => this.parseRow(row));
    }
    parseRow(row) {
        if (row.settings) {
            try {
                const parsed = JSON.parse(row.settings);
                if (isChannelRecord(parsed)) {
                    return parsed;
                }
            }
            catch (error) {
                logger_1.logger.warn('channelRegistry: failed to parse settings JSON, fallback to columns', {
                    chatId: row.chat_id,
                    error,
                });
            }
        }
        return {
            chat_id: row.chat_id,
            title: row.title,
            type: row.type,
            date_added: row.date_added,
        };
    }
    getStatements() {
        if (this.statements) {
            return this.statements;
        }
        const db = (0, database_1.getDb)();
        this.statements = {
            getById: db.prepare('SELECT chat_id, title, type, date_added, settings FROM channels WHERE chat_id = ?'),
            listAll: db.prepare('SELECT chat_id, title, type, date_added, settings FROM channels ORDER BY chat_id ASC'),
            upsert: db.prepare('INSERT OR REPLACE INTO channels (chat_id, title, type, date_added, active, settings) VALUES (?, ?, ?, ?, ?, ?)'),
            deleteById: db.prepare('DELETE FROM channels WHERE chat_id = ?'),
        };
        return this.statements;
    }
}
exports.ChannelRegistry = ChannelRegistry;
exports.channelRegistry = new ChannelRegistry();
//# sourceMappingURL=channelRegistry.js.map