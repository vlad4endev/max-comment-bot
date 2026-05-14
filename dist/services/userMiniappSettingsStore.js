"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userMiniappSettingsStore = exports.UserMiniappSettingsStore = exports.MINIAPP_FEATURE_KEYS = void 0;
exports.parseMiniappFeatureKey = parseMiniappFeatureKey;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const logger_1 = require("../utils/logger");
exports.MINIAPP_FEATURE_KEYS = [
    'comments',
    'notifications',
    'moderation',
    'auto_replies',
];
const DEFAULT_SETTINGS = {
    comments: true,
    notifications: true,
    moderation: false,
    auto_replies: false,
};
const DEFAULT_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'settings.json');
function isFeatureKey(value) {
    return (typeof value === 'string' &&
        exports.MINIAPP_FEATURE_KEYS.includes(value));
}
function mergeWithDefaults(partial) {
    return {
        comments: partial?.comments ?? DEFAULT_SETTINGS.comments,
        notifications: partial?.notifications ?? DEFAULT_SETTINGS.notifications,
        moderation: partial?.moderation ?? DEFAULT_SETTINGS.moderation,
        auto_replies: partial?.auto_replies ?? DEFAULT_SETTINGS.auto_replies,
    };
}
/**
 * JSON-backed per-user Mini App toggles (`data/settings.json`).
 */
class UserMiniappSettingsStore {
    byUserId = new Map();
    filePath;
    persistChain = Promise.resolve();
    constructor(filePath = DEFAULT_PATH) {
        this.filePath = filePath;
    }
    async loadFromDisk() {
        try {
            const raw = await (0, promises_1.readFile)(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || !('users' in parsed)) {
                logger_1.logger.warn('userMiniappSettingsStore: invalid settings.json shape, starting empty');
                this.byUserId.clear();
                return;
            }
            const users = parsed.users;
            if (typeof users !== 'object' || users === null || Array.isArray(users)) {
                this.byUserId.clear();
                return;
            }
            this.byUserId.clear();
            for (const [k, v] of Object.entries(users)) {
                const id = Number.parseInt(k, 10);
                if (!Number.isInteger(id) || id <= 0 || typeof v !== 'object' || v === null) {
                    continue;
                }
                const row = {};
                for (const fk of exports.MINIAPP_FEATURE_KEYS) {
                    if (fk in v && typeof v[fk] === 'boolean') {
                        row[fk] = v[fk];
                    }
                }
                this.byUserId.set(id, row);
            }
            logger_1.logger.info(`userMiniappSettingsStore: loaded ${this.byUserId.size} user row(s)`);
        }
        catch (e) {
            const err = e;
            if (err.code === 'ENOENT') {
                logger_1.logger.debug('userMiniappSettingsStore: settings.json missing, empty store');
                return;
            }
            logger_1.logger.error('userMiniappSettingsStore: failed to read settings.json', e);
        }
    }
    getMerged(userId) {
        return mergeWithDefaults(this.byUserId.get(userId));
    }
    setFeature(userId, feature, enabled) {
        const prev = this.byUserId.get(userId) ?? {};
        const next = { ...prev, [feature]: enabled };
        this.byUserId.set(userId, next);
        this.queuePersist();
        return mergeWithDefaults(next);
    }
    queuePersist() {
        this.persistChain = this.persistChain
            .then(() => this.persist())
            .catch((e) => {
            logger_1.logger.error('userMiniappSettingsStore: persist error', e);
        });
    }
    async persist() {
        const dir = (0, node_path_1.dirname)(this.filePath);
        await (0, promises_1.mkdir)(dir, { recursive: true });
        const users = {};
        for (const [uid, row] of this.byUserId) {
            users[String(uid)] = { ...row };
        }
        const body = { users };
        await (0, promises_1.writeFile)(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    }
}
exports.UserMiniappSettingsStore = UserMiniappSettingsStore;
function parseMiniappFeatureKey(value) {
    return isFeatureKey(value) ? value : null;
}
exports.userMiniappSettingsStore = new UserMiniappSettingsStore();
//# sourceMappingURL=userMiniappSettingsStore.js.map