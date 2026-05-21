"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.disabledAdminStore = exports.DisabledAdminStore = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const logger_1 = require("../utils/logger");
const DEFAULT_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'disabled-admins.json');
function isPositiveInt(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
/**
 * Stores user ids explicitly disabled from bot admin capabilities.
 */
class DisabledAdminStore {
    disabledUserIds = new Set();
    filePath;
    persistChain = Promise.resolve();
    constructor(filePath = DEFAULT_PATH) {
        this.filePath = filePath;
    }
    async loadFromDisk() {
        try {
            const raw = await (0, promises_1.readFile)(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || !('disabled_user_ids' in parsed)) {
                logger_1.logger.warn('disabledAdminStore: invalid file shape, starting empty');
                this.disabledUserIds.clear();
                return;
            }
            const rows = parsed.disabled_user_ids;
            if (!Array.isArray(rows)) {
                this.disabledUserIds.clear();
                return;
            }
            this.disabledUserIds.clear();
            for (const row of rows) {
                if (isPositiveInt(row)) {
                    this.disabledUserIds.add(row);
                }
            }
            logger_1.logger.info(`disabledAdminStore: loaded ${this.disabledUserIds.size} disabled user(s)`);
        }
        catch (e) {
            const err = e;
            if (err.code === 'ENOENT') {
                logger_1.logger.debug('disabledAdminStore: file missing, empty store');
                return;
            }
            logger_1.logger.error('disabledAdminStore: failed to read file', e);
        }
    }
    isDisabled(userId) {
        return isPositiveInt(userId) && this.disabledUserIds.has(userId);
    }
    disableUser(userId) {
        if (!isPositiveInt(userId)) {
            return;
        }
        if (this.disabledUserIds.has(userId)) {
            return;
        }
        this.disabledUserIds.add(userId);
        this.queuePersist();
        logger_1.logger.info('disabledAdminStore: disableUser', { userId });
    }
    enableUser(userId) {
        if (!isPositiveInt(userId)) {
            return;
        }
        if (!this.disabledUserIds.delete(userId)) {
            return;
        }
        this.queuePersist();
        logger_1.logger.info('disabledAdminStore: enableUser', { userId });
    }
    getAllDisabledUserIds() {
        return [...this.disabledUserIds].sort((a, b) => a - b);
    }
    queuePersist() {
        this.persistChain = this.persistChain
            .then(() => this.persist())
            .catch((e) => {
            logger_1.logger.error('disabledAdminStore: persist error', e);
        });
    }
    async persist() {
        const dir = (0, node_path_1.dirname)(this.filePath);
        await (0, promises_1.mkdir)(dir, { recursive: true });
        const body = {
            disabled_user_ids: [...this.disabledUserIds].sort((a, b) => a - b),
        };
        await (0, promises_1.writeFile)(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    }
}
exports.DisabledAdminStore = DisabledAdminStore;
exports.disabledAdminStore = new DisabledAdminStore();
//# sourceMappingURL=disabledAdminStore.js.map