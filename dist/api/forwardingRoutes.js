"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createForwardingRouter = createForwardingRouter;
const express_1 = __importDefault(require("express"));
const adminAuth_1 = require("../middleware/adminAuth");
const database_1 = require("../db/database");
function createForwardingRouter() {
    const router = express_1.default.Router();
    router.use(express_1.default.json({ limit: '64kb' }));
    router.use(adminAuth_1.checkAdminAuth);
    router.get('/', (_req, res) => {
        const configs = (0, database_1.getDb)()
            .prepare('SELECT * FROM forwarding_configs ORDER BY created_at DESC')
            .all();
        res.json(configs);
    });
    router.post('/', (req, res) => {
        const { tg_channel, max_channel_id } = req.body;
        if (!tg_channel || !max_channel_id) {
            return res.status(400).json({ error: 'tg_channel and max_channel_id are required' });
        }
        const normalized = typeof tg_channel === 'string' && tg_channel.startsWith('@')
            ? tg_channel
            : `@${String(tg_channel)}`;
        const maxId = typeof max_channel_id === 'string' ? max_channel_id : String(max_channel_id);
        (0, database_1.getDb)()
            .prepare('INSERT INTO forwarding_configs (tg_channel, max_channel_id) VALUES (?, ?)')
            .run(normalized, maxId);
        res.json({ ok: true });
    });
    router.patch('/:id/toggle', (req, res) => {
        const { id } = req.params;
        const row = (0, database_1.getDb)()
            .prepare('SELECT is_active FROM forwarding_configs WHERE id = ?')
            .get(id);
        if (!row) {
            return res.status(404).json({ error: 'Not found' });
        }
        (0, database_1.getDb)()
            .prepare('UPDATE forwarding_configs SET is_active = ? WHERE id = ?')
            .run(row.is_active ? 0 : 1, id);
        res.json({ ok: true });
    });
    router.delete('/:id', (req, res) => {
        (0, database_1.getDb)().prepare('DELETE FROM forwarding_configs WHERE id = ?').run(req.params.id);
        res.json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=forwardingRoutes.js.map