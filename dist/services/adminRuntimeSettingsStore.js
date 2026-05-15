"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminRuntimeSettingsStore = exports.AdminRuntimeSettingsStore = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const logger_1 = require("../utils/logger");
const MIN_POLL_MS = 3_000;
const DEFAULT_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'admin-runtime.json');
function pollMsFromEnv() {
    const n = Number.parseInt(process.env.CHANNEL_POLL_INTERVAL_MS ?? '', 10);
    if (Number.isFinite(n) && n >= MIN_POLL_MS) {
        return n;
    }
    return 30_000;
}
class AdminRuntimeSettingsStore {
    pollIntervalMs;
    filePath;
    constructor(filePath = DEFAULT_PATH) {
        this.filePath = filePath;
        this.pollIntervalMs = Math.max(MIN_POLL_MS, pollMsFromEnv());
    }
    getPollIntervalMs() {
        return this.pollIntervalMs;
    }
    async loadFromDisk() {
        try {
            const raw = await (0, promises_1.readFile)(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object' &&
                parsed !== null &&
                typeof parsed.poll_interval_ms === 'number' &&
                Number.isFinite(parsed.poll_interval_ms)) {
                this.pollIntervalMs = Math.max(MIN_POLL_MS, Math.round(parsed.poll_interval_ms));
            }
        }
        catch (e) {
            const err = e;
            if (err.code === 'ENOENT') {
                logger_1.logger.debug('adminRuntimeSettings: no file, using env/default');
                return;
            }
            logger_1.logger.error('adminRuntimeSettings: read failed', e);
        }
    }
    async setPollIntervalMs(ms) {
        this.pollIntervalMs = Math.max(MIN_POLL_MS, Math.round(ms));
        await this.persist();
        return this.pollIntervalMs;
    }
    async persist() {
        const dir = (0, node_path_1.dirname)(this.filePath);
        await (0, promises_1.mkdir)(dir, { recursive: true });
        const body = { poll_interval_ms: this.pollIntervalMs };
        await (0, promises_1.writeFile)(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    }
}
exports.AdminRuntimeSettingsStore = AdminRuntimeSettingsStore;
exports.adminRuntimeSettingsStore = new AdminRuntimeSettingsStore();
//# sourceMappingURL=adminRuntimeSettingsStore.js.map