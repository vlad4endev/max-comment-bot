"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createChannelImportRouter = createChannelImportRouter;
const express_1 = __importDefault(require("express"));
const adminAuth_1 = require("../middleware/adminAuth");
const channelImportService_1 = require("../services/channelImportService");
const telegramUserArchive_1 = require("../services/telegramUserArchive");
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
    router.get('/meta', (_req, res) => {
        const tokenMeta = (0, channelImportService_1.readerTokenMeta)();
        res.json({
            scan_idle_max: channelImportService_1.SCAN_IDLE_MAX,
            scan_interval_ms: 2000,
            reader_token_ok: tokenMeta.ok,
            reader_uses_main_token: tokenMeta.usesMainToken,
            user_archive_ready: (0, telegramUserArchive_1.telegramUserArchiveConfigured)(),
            hint: tokenMeta.ok
                ? tokenMeta.usesMainToken
                    ? 'Используется TG_TOKEN из интеграции. Для импорта лучше задать отдельный TG_READER_BOT_TOKEN.'
                    : null
                : 'Задайте TG_READER_BOT_TOKEN или подключите Telegram в интеграциях.',
            archive_hint: (0, telegramUserArchive_1.telegramUserArchiveConfigured)()
                ? 'Режим «Архив канала» загрузит до N последних постов через user-аккаунт (MTProto).'
                : 'Для архива: TG_API_ID, TG_API_HASH с my.telegram.org и TG_USER_SESSION (npm run tg:user-login).',
        });
    });
    router.get('/jobs/active', (_req, res) => {
        const job = (0, channelImportService_1.getActiveChannelImportJob)();
        if (!job) {
            res.json({ job: null });
            return;
        }
        res.json({ job });
    });
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
        const archive = body.archive === true;
        const archiveLimitRaw = body.archive_limit;
        const archiveLimit = typeof archiveLimitRaw === 'number' && Number.isFinite(archiveLimitRaw)
            ? archiveLimitRaw
            : typeof archiveLimitRaw === 'string'
                ? Number.parseInt(archiveLimitRaw, 10)
                : 100;
        try {
            const id = (0, channelImportService_1.createChannelImportJob)(tg, max, {
                archive,
                archiveLimit: Number.isFinite(archiveLimit) ? archiveLimit : 100,
            });
            if (!archive) {
                void (0, channelImportService_1.tickChannelImportJobs)().catch(() => { });
            }
            const job = (0, channelImportService_1.getChannelImportJob)(id);
            res.json({ ok: true, id, job: job ? (0, channelImportService_1.toChannelImportJobView)(job) : null });
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
        res.json((0, channelImportService_1.toChannelImportJobView)(job));
    });
    router.post('/jobs/:id/scan', async (req, res) => {
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
        if (job.status !== 'scanning') {
            res.json({ ok: true, job: (0, channelImportService_1.toChannelImportJobView)(job) });
            return;
        }
        await (0, channelImportService_1.tickChannelImportJobs)();
        const updated = (0, channelImportService_1.getChannelImportJob)(id);
        if (!updated) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ ok: true, job: (0, channelImportService_1.toChannelImportJobView)(updated) });
    });
    router.post('/jobs/:id/publish', async (req, res) => {
        const id = parseJobId(req.params.id);
        if (id === null) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        try {
            await (0, channelImportService_1.publishChannelImportJob)(id, (0, channelImportService_1.resolveImportTgToken)(), process.env.BOT_TOKEN || '');
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