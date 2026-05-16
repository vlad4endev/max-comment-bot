"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.channelSettingsStore = exports.ChannelSettingsStore = void 0;
exports.parseManagerUrlInput = parseManagerUrlInput;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const logger_1 = require("../utils/logger");
const DEFAULT_SETTINGS = {
    manager_url: null,
};
const DEFAULT_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'channel-settings.json');
function mergeRow(row) {
    const url = row?.manager_url;
    if (typeof url === 'string') {
        const trimmed = url.trim();
        return { manager_url: trimmed === '' ? null : trimmed };
    }
    if (url === null) {
        return { manager_url: null };
    }
    return { ...DEFAULT_SETTINGS };
}
function isValidManagerUrl(value) {
    try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:';
    }
    catch {
        return false;
    }
}
/**
 * Per-channel Mini App settings (e.g. manager contact link).
 */
class ChannelSettingsStore {
    byChatId = new Map();
    filePath;
    persistChain = Promise.resolve();
    constructor(filePath = DEFAULT_PATH) {
        this.filePath = filePath;
    }
    async loadFromDisk() {
        try {
            const raw = await (0, promises_1.readFile)(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || !('channels' in parsed)) {
                logger_1.logger.warn('channelSettingsStore: invalid file shape, starting empty');
                this.byChatId.clear();
                return;
            }
            const channels = parsed.channels;
            if (typeof channels !== 'object' || channels === null || Array.isArray(channels)) {
                this.byChatId.clear();
                return;
            }
            this.byChatId.clear();
            for (const [k, v] of Object.entries(channels)) {
                const id = Number.parseInt(k, 10);
                if (!Number.isInteger(id) || id === 0 || typeof v !== 'object' || v === null) {
                    continue;
                }
                this.byChatId.set(id, v);
            }
            logger_1.logger.info(`channelSettingsStore: loaded ${this.byChatId.size} channel row(s)`);
        }
        catch (e) {
            const err = e;
            if (err.code === 'ENOENT') {
                logger_1.logger.debug('channelSettingsStore: file missing, empty store');
                return;
            }
            logger_1.logger.error('channelSettingsStore: failed to read file', e);
        }
    }
    getSettings(chatId) {
        return mergeRow(this.byChatId.get(chatId));
    }
    getManagerUrl(chatId) {
        return this.getSettings(chatId).manager_url;
    }
    setManagerUrl(chatId, managerUrl) {
        const prev = this.byChatId.get(chatId) ?? {};
        const next = { ...prev };
        if (managerUrl === null) {
            next.manager_url = null;
        }
        else {
            const trimmed = managerUrl.trim();
            if (trimmed !== '' && !isValidManagerUrl(trimmed)) {
                throw new Error('invalid manager_url');
            }
            next.manager_url = trimmed === '' ? null : trimmed;
        }
        this.byChatId.set(chatId, next);
        this.queuePersist();
        return mergeRow(next);
    }
    queuePersist() {
        this.persistChain = this.persistChain
            .then(() => this.persist())
            .catch((e) => {
            logger_1.logger.error('channelSettingsStore: persist error', e);
        });
    }
    async persist() {
        const dir = (0, node_path_1.dirname)(this.filePath);
        await (0, promises_1.mkdir)(dir, { recursive: true });
        const channels = {};
        for (const [chatId, row] of this.byChatId) {
            channels[String(chatId)] = { ...row };
        }
        const body = { channels };
        await (0, promises_1.writeFile)(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    }
}
exports.ChannelSettingsStore = ChannelSettingsStore;
exports.channelSettingsStore = new ChannelSettingsStore();
function parseManagerUrlInput(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'string') {
        return 'invalid';
    }
    const trimmed = value.trim();
    if (trimmed === '') {
        return null;
    }
    return isValidManagerUrl(trimmed) ? trimmed : 'invalid';
}
//# sourceMappingURL=channelSettingsStore.js.map