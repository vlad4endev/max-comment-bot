"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.channelRegistry = exports.ChannelRegistry = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const logger_1 = require("../utils/logger");
const DEFAULT_CHANNELS_PATH = (0, node_path_1.join)(process.cwd(), 'channels.json');
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
/**
 * JSON-backed registry of chats the bot participates in.
 * Keeps an in-memory map synchronized with {@link DEFAULT_CHANNELS_PATH}.
 */
class ChannelRegistry {
    channels = new Map();
    filePath;
    persistChain = Promise.resolve();
    constructor(filePath = DEFAULT_CHANNELS_PATH) {
        this.filePath = filePath;
    }
    /**
     * Читает `channels.json` и заполняет память. Повторные вызовы перезаписывают кэш.
     */
    async loadFromDisk() {
        try {
            const raw = await (0, promises_1.readFile)(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || !('channels' in parsed)) {
                logger_1.logger.warn('channelRegistry: неверный формат channels.json, очищаю память');
                this.channels.clear();
                return;
            }
            const list = parsed.channels;
            if (!Array.isArray(list)) {
                this.channels.clear();
                return;
            }
            this.channels.clear();
            for (const item of list) {
                if (isChannelRecord(item)) {
                    this.channels.set(item.chat_id, item);
                }
            }
            logger_1.logger.info(`channelRegistry: загружено ${this.channels.size} канал(ов)`);
        }
        catch (e) {
            const err = e;
            if (err.code === 'ENOENT') {
                logger_1.logger.debug('channelRegistry: файл channels.json отсутствует, начинаем с пустого реестра');
                return;
            }
            logger_1.logger.error('channelRegistry: не удалось прочитать channels.json', e);
        }
    }
    /**
     * Сохраняет или обновляет канал. Для уже известного `chat_id` поле {@link ChannelRecord.date_added} не меняется.
     */
    saveChannel(chatId, chatData) {
        const existing = this.channels.get(chatId);
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
        this.channels.set(chatId, record);
        this.queuePersist();
    }
    /**
     * Удаляет канал из реестра. Возвращает удалённую запись (для текста уведомления) или `null`, если чата не было.
     */
    removeChannel(chatId) {
        const prev = this.channels.get(chatId) ?? null;
        if (prev === null) {
            return null;
        }
        this.channels.delete(chatId);
        this.queuePersist();
        return prev;
    }
    /**
     * Возвращает запись по `chat_id` или `null`.
     */
    getChannel(chatId) {
        return this.channels.get(chatId) ?? null;
    }
    /**
     * Все каналы из текущего реестра, отсортированные по `chat_id`.
     */
    getAllChannels() {
        return [...this.channels.values()].sort((a, b) => a.chat_id - b.chat_id);
    }
    queuePersist() {
        this.persistChain = this.persistChain
            .then(() => this.persist())
            .catch((e) => {
            logger_1.logger.error('channelRegistry: ошибка записи channels.json', e);
        });
    }
    async persist() {
        const dir = (0, node_path_1.dirname)(this.filePath);
        await (0, promises_1.mkdir)(dir, { recursive: true });
        const body = {
            channels: this.getAllChannels(),
        };
        await (0, promises_1.writeFile)(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    }
}
exports.ChannelRegistry = ChannelRegistry;
exports.channelRegistry = new ChannelRegistry();
//# sourceMappingURL=channelRegistry.js.map