"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateAutopostsFromJson = migrateAutopostsFromJson;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const logger_1 = require("../utils/logger");
const autopostStore_1 = require("../services/autopostStore");
const database_1 = require("./database");
const ADMIN_STATE_PATH = node_path_1.default.join(process.cwd(), 'data', 'admin-panel-state.json');
/**
 * Однократный перенос автопостов из admin-panel-state.json в SQLite.
 * Старые записи (MAX chat_id) сохраняются как target_channel_id; для TG нужно пересоздать в админке.
 */
function migrateAutopostsFromJson() {
    (0, database_1.getDb)();
    if ((0, autopostStore_1.listAutoposts)().length > 0) {
        return;
    }
    if (!node_fs_1.default.existsSync(ADMIN_STATE_PATH)) {
        return;
    }
    try {
        const raw = node_fs_1.default.readFileSync(ADMIN_STATE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const legacy = Array.isArray(parsed.autoposts) ? parsed.autoposts : [];
        if (legacy.length === 0) {
            return;
        }
        let imported = 0;
        for (const row of legacy) {
            if (!row.text?.trim() || !row.scheduled_at) {
                continue;
            }
            const scheduleType = row.repeat === 'none' ? 'once' : 'recurring';
            let recurringTime = null;
            let weekdays = null;
            if (scheduleType === 'recurring') {
                const d = new Date(row.scheduled_at);
                recurringTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                weekdays =
                    row.repeat === 'weekly'
                        ? [d.getDay()]
                        : [0, 1, 2, 3, 4, 5, 6];
            }
            const status = row.status === 'sent' ? 'sent' : row.status === 'failed' ? 'failed' : 'active';
            const created = (0, autopostStore_1.createAutopost)({
                text: row.text,
                target_channel_id: String(row.chat_id),
                channel_title: row.channel_title,
                schedule_type: scheduleType,
                scheduled_at: row.scheduled_at,
                recurring_time: recurringTime,
                weekdays,
            });
            imported += 1;
            if (status !== 'active') {
                (0, autopostStore_1.updateAutopost)(created.id, { status: status });
            }
        }
        if (imported > 0) {
            logger_1.logger.info('migrateAutopostsFromJson: imported legacy autoposts', { count: imported });
        }
    }
    catch (err) {
        logger_1.logger.warn('migrateAutopostsFromJson failed', err);
    }
}
//# sourceMappingURL=migrateAutopostsFromJson.js.map