"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createChannelImportRouter = createChannelImportRouter;
const express_1 = __importDefault(require("express"));
const adminAuth_1 = require("../middleware/adminAuth");
const channelImportService_1 = require("../services/channelImportService");
function parseJobId(raw) {
    if (raw === undefined) {
        return null;
    }
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}
function createChannelImportRouter() {
    const router = express_1.default.Router();
    router.use(express_1.default.json({ limit: '512kb' }));
    router.use(adminAuth_1.checkAdminAuth);
    router.post('/jobs', (req, res) => {
        const body = req.body;
        const tg = typeof body.tg_channel === 'string'
            ? body.tg_channel
            : body.tg_channel != null
                ? String(body.tg_channel)
                : '';
        const max = typeof body.max_channel_id === 'string'
            ? body.max_channel_id
            : body.max_channel_id != null
                ? String(body.max_channel_id)
                : '';
        try {
            const id = (0, channelImportService_1.createChannelImportJob)(tg, max);
            res.json({ ok: true, id });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'invalid request';
            res.status(400).json({ error: msg });
        }
    });
    router.get('/jobs/:id', (req, res) => {
        const id = parseJobId(req.params.id);
        if (id === null) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        const job = (0, channelImportService_1.getChannelImportJob)(id);
        if (!job) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json(job);
    });
    router.post('/jobs/:id/publish', async (req, res) => {
        const id = parseJobId(req.params.id);
        if (id === null) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        try {
            await (0, channelImportService_1.publishChannelImportJob)(id, process.env.TG_READER_BOT_TOKEN || '', process.env.BOT_TOKEN || '');
            res.json({ ok: true });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'publish failed';
            res.status(400).json({ error: msg });
        }
    });
    router.delete('/jobs/:id', (req, res) => {
        const id = parseJobId(req.params.id);
        if (id === null) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        const ok = (0, channelImportService_1.cancelChannelImportJob)(id);
        if (!ok) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=channelImportRoutes.js.map