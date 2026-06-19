"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAutopostRouter = createAutopostRouter;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const integrationPlatformClient_1 = require("../services/integrationPlatformClient");
const integrationsStore_1 = require("../services/integrationsStore");
const autopostSchedule_1 = require("../services/autopostSchedule");
const autopostStore_1 = require("../services/autopostStore");
const channelRegistry_1 = require("../services/channelRegistry");
const postTemplateStore_1 = require("../services/postTemplateStore");
const postsDatabase_1 = require("../db/postsDatabase");
const AUTOPOST_MEDIA_DIR = node_path_1.default.join(process.cwd(), 'data', 'autoposts-media');
const MAX_MEDIA_FILES = 10;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const upload = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination(_req, _file, cb) {
            node_fs_1.default.mkdirSync(AUTOPOST_MEDIA_DIR, { recursive: true });
            cb(null, AUTOPOST_MEDIA_DIR);
        },
        filename(_req, file, cb) {
            const ext = node_path_1.default.extname(file.originalname || '').toLowerCase();
            const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.mov', '.webm'].includes(ext)
                ? ext
                : file.mimetype?.startsWith('video/')
                    ? '.mp4'
                    : '.jpg';
            cb(null, `${Date.now()}-${(0, node_crypto_1.randomUUID)()}${safeExt}`);
        },
    }),
    limits: { files: MAX_MEDIA_FILES, fileSize: MAX_MEDIA_BYTES },
});
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseNonEmptyString(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const t = value.trim();
    return t === '' ? null : t;
}
function parseWeekdays(raw) {
    if (typeof raw === 'string' && raw.trim()) {
        try {
            return parseWeekdays(JSON.parse(raw));
        }
        catch {
            return null;
        }
    }
    if (!Array.isArray(raw)) {
        return null;
    }
    const days = raw
        .map((d) => (typeof d === 'number' ? d : Number.parseInt(String(d), 10)))
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    return days.length > 0 ? [...new Set(days)] : null;
}
function mediaFromUploaded(files) {
    return files.map((f) => ({
        type: f.mimetype?.startsWith('video/') ? 'video' : 'photo',
        path: f.path,
    }));
}
function parseInlineButton(body) {
    const text = parseNonEmptyString(body.inline_button_text);
    const url = parseNonEmptyString(body.inline_button_url);
    if (!text && !url) {
        return null;
    }
    if (!text || !url) {
        throw new Error('inline_button_text and inline_button_url required together');
    }
    if (!/^https?:\/\//i.test(url)) {
        throw new Error('inline_button_url must start with http:// or https://');
    }
    return { text, url };
}
async function listTelegramChannelsForAutopost() {
    await integrationsStore_1.integrationsStore.load();
    const integ = integrationsStore_1.integrationsStore.getTelegramIntegration();
    if (!integ) {
        return [];
    }
    const token = (integ.token || (0, config_1.getTelegramToken)()).trim();
    if (!token) {
        return [];
    }
    const channels = await (0, integrationPlatformClient_1.buildTelegramLinkedChatsList)({
        integrationId: integ.id,
        token,
        existingLinkedChats: integ.linkedChats,
        refresh: false,
    });
    return channels
        .filter((c) => c.type === 'channel')
        .filter((c) => c.botIsAdmin === true)
        .map((c) => ({
        id: c.id,
        title: c.title,
        username: c.username,
        botIsAdmin: c.botIsAdmin,
        platform: 'telegram',
    }));
}
function syncPostChannelsRegistry() {
    for (const ch of channelRegistry_1.channelRegistry.getAllChannels()) {
        if (ch.type !== 'channel')
            continue;
        (0, autopostStore_1.upsertPostChannel)({
            id: String(ch.chat_id),
            platform: 'max',
            title: ch.title ?? null,
        });
    }
}
function listMaxChannelsForAutopost() {
    return channelRegistry_1.channelRegistry
        .getAllChannels()
        .filter((ch) => ch.type === 'channel')
        .map((ch) => ({
        id: String(ch.chat_id),
        title: ch.title?.trim() || `Канал ${ch.chat_id}`,
        platform: 'max',
    }));
}
function validateScheduleInput(body) {
    const scheduleTypeRaw = parseNonEmptyString(body.schedule_type) ?? 'once';
    const schedule_type = scheduleTypeRaw === 'recurring' ? 'recurring' : 'once';
    const scheduled_at = parseNonEmptyString(body.scheduled_at);
    if (!scheduled_at || Number.isNaN(new Date(scheduled_at).getTime())) {
        throw new Error('scheduled_at required (ISO datetime)');
    }
    if (schedule_type === 'once') {
        return { schedule_type, scheduled_at, recurring_time: null, weekdays: null };
    }
    const recurring_time = parseNonEmptyString(body.recurring_time) ?? (0, autopostSchedule_1.extractRecurringTimeFromIso)(scheduled_at);
    const weekdays = parseWeekdays(body.weekdays);
    if (!weekdays?.length) {
        throw new Error('weekdays required for recurring schedule (0=Sun … 6=Sat)');
    }
    const nextAt = (0, autopostSchedule_1.computeNextRecurringAt)(recurring_time, weekdays);
    return { schedule_type, scheduled_at: nextAt, recurring_time, weekdays };
}
function createAutopostRouter() {
    const router = express_1.default.Router();
    router.get('/channels', async (_req, res) => {
        try {
            const tgChannels = await listTelegramChannelsForAutopost();
            for (const c of tgChannels) {
                (0, autopostStore_1.upsertPostChannel)({
                    id: c.id,
                    platform: 'telegram',
                    title: c.title,
                    username: c.username,
                });
            }
            syncPostChannelsRegistry();
            const maxChannels = listMaxChannelsForAutopost();
            const allChannels = [...tgChannels, ...maxChannels];
            const registered = (0, autopostStore_1.listPostChannels)();
            const integ = integrationsStore_1.integrationsStore.getTelegramIntegration();
            const hints = [];
            if (!tgChannels.length) {
                hints.push('Telegram: подключите интеграцию и добавьте бота админом в канал.');
            }
            if (!maxChannels.length) {
                hints.push('MAX: добавьте бота в канал — он появится в списке автоматически.');
            }
            res.json({
                connected: !!integ || maxChannels.length > 0,
                channels: allChannels,
                telegram: tgChannels,
                max: maxChannels,
                registered,
                db_path: postsDatabase_1.POSTS_DB_PATH,
                hint: hints.length ? hints.join(' ') : null,
            });
        }
        catch (err) {
            logger_1.logger.error('GET /autoposts/channels failed', err);
            res.status(500).json({ error: 'Не удалось загрузить каналы' });
        }
    });
    router.get('/templates', (_req, res) => {
        res.json({ templates: (0, postTemplateStore_1.listPostTemplates)() });
    });
    router.post('/templates', (req, res) => {
        const body = isRecord(req.body) ? req.body : {};
        const name = parseNonEmptyString(body.name);
        const text = parseNonEmptyString(body.text) ?? '';
        if (!name) {
            res.status(400).json({ error: 'name required' });
            return;
        }
        const row = (0, postTemplateStore_1.createPostTemplate)({ name, text });
        res.json({ ok: true, template: row });
    });
    router.patch('/templates/:id', (req, res) => {
        const id = parseNonEmptyString(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        const body = isRecord(req.body) ? req.body : {};
        const row = (0, postTemplateStore_1.updatePostTemplate)(id, {
            name: body.name !== undefined ? (parseNonEmptyString(body.name) ?? undefined) : undefined,
            text: body.text !== undefined ? (parseNonEmptyString(body.text) ?? '') : undefined,
        });
        if (!row) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ ok: true, template: row });
    });
    router.delete('/templates/:id', (req, res) => {
        const id = parseNonEmptyString(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        if (!(0, postTemplateStore_1.deletePostTemplate)(id)) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ ok: true });
    });
    router.get('/stats', async (_req, res) => {
        try {
            const channels = await listTelegramChannelsForAutopost();
            const posts = (0, autopostStore_1.listAutoposts)();
            res.json({ stats: (0, autopostStore_1.computeAutopostStats)(posts, channels.length) });
        }
        catch (err) {
            logger_1.logger.error('GET /autoposts/stats failed', err);
            res.status(500).json({ error: 'Не удалось загрузить статистику' });
        }
    });
    router.get('/', (req, res) => {
        const status = parseNonEmptyString(req.query.status) ?? undefined;
        const channelId = parseNonEmptyString(req.query.channelId) ?? undefined;
        const scheduleTypeRaw = parseNonEmptyString(req.query.scheduleType);
        const scheduleType = scheduleTypeRaw === 'recurring' || scheduleTypeRaw === 'once' ? scheduleTypeRaw : undefined;
        const search = parseNonEmptyString(req.query.search) ?? undefined;
        const from = parseNonEmptyString(req.query.from) ?? undefined;
        const to = parseNonEmptyString(req.query.to) ?? undefined;
        const posts = (0, autopostStore_1.listAutopostsFiltered)({ status, channelId, scheduleType, search, from, to });
        res.json({ posts });
    });
    router.get('/:id', (req, res) => {
        const id = parseNonEmptyString(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        const row = (0, autopostStore_1.getAutopostById)(id);
        if (!row) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ post: row });
    });
    router.post('/', upload.array('media', MAX_MEDIA_FILES), async (req, res) => {
        try {
            const body = isRecord(req.body) ? req.body : {};
            const text = parseNonEmptyString(body.text) ?? '';
            const target_channel_id = parseNonEmptyString(body.target_channel_id);
            if (!target_channel_id) {
                res.status(400).json({ error: 'target_channel_id required' });
                return;
            }
            if (!text && (!req.files || !req.files.length)) {
                res.status(400).json({ error: 'text or media required' });
                return;
            }
            const schedule = validateScheduleInput(body);
            const inline_button = parseInlineButton(body);
            const media = mediaFromUploaded(req.files ?? []);
            const platformRaw = parseNonEmptyString(body.platform);
            const platform = platformRaw === 'max' ? 'max' : 'telegram';
            if (media.length > 1 && inline_button && platform === 'telegram') {
                res.status(400).json({
                    error: 'album_inline_button',
                    message: 'Инлайн-кнопка не поддерживается в альбоме Telegram. Используйте одно медиа или кнопку без альбома.',
                });
                return;
            }
            const row = (0, autopostStore_1.createAutopost)({
                platform,
                text,
                media,
                inline_button,
                target_channel_id,
                channel_title: parseNonEmptyString(body.channel_title),
                ...schedule,
            });
            res.json({ ok: true, post: row });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'invalid body';
            res.status(400).json({ error: message });
        }
    });
    router.patch('/:id', upload.array('media', MAX_MEDIA_FILES), async (req, res) => {
        const id = parseNonEmptyString(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        try {
            const body = isRecord(req.body) ? req.body : {};
            const patch = {};
            if (body.text !== undefined) {
                patch.text = parseNonEmptyString(body.text) ?? '';
            }
            if (body.target_channel_id !== undefined) {
                const tid = parseNonEmptyString(body.target_channel_id);
                if (!tid) {
                    res.status(400).json({ error: 'target_channel_id invalid' });
                    return;
                }
                patch.target_channel_id = tid;
            }
            if (body.channel_title !== undefined) {
                patch.channel_title = parseNonEmptyString(body.channel_title);
            }
            if (body.platform !== undefined) {
                const platformRaw = parseNonEmptyString(body.platform);
                patch.platform = platformRaw === 'max' ? 'max' : 'telegram';
            }
            if (body.inline_button_text !== undefined || body.inline_button_url !== undefined) {
                patch.inline_button = parseInlineButton(body);
            }
            if (req.files && req.files.length > 0) {
                patch.media = mediaFromUploaded(req.files);
            }
            if (body.schedule_type !== undefined || body.scheduled_at !== undefined) {
                Object.assign(patch, validateScheduleInput(body));
            }
            const row = (0, autopostStore_1.updateAutopost)(id, patch);
            if (!row) {
                res.status(404).json({ error: 'not found' });
                return;
            }
            res.json({ ok: true, post: row });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'invalid body';
            res.status(400).json({ error: message });
        }
    });
    router.patch('/:id/pause', (req, res) => {
        const id = parseNonEmptyString(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        const row = (0, autopostStore_1.setAutopostStatus)(id, 'paused');
        if (!row) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ ok: true, post: row });
    });
    router.patch('/:id/resume', (req, res) => {
        const id = parseNonEmptyString(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        const current = (0, autopostStore_1.getAutopostById)(id);
        if (!current) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        let scheduled_at = current.scheduled_at;
        if (current.schedule_type === 'recurring' && current.recurring_time && current.weekdays?.length) {
            scheduled_at = (0, autopostSchedule_1.computeNextRecurringAt)(current.recurring_time, current.weekdays);
        }
        else if (new Date(scheduled_at).getTime() <= Date.now()) {
            res.status(400).json({ error: 'scheduled_at in the past; update schedule first' });
            return;
        }
        const row = (0, autopostStore_1.updateAutopost)(id, { status: 'active', scheduled_at });
        if (!row) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ ok: true, post: row });
    });
    router.delete('/:id', (req, res) => {
        const id = parseNonEmptyString(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        const ok = (0, autopostStore_1.deleteAutopost)(id);
        if (!ok) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=autopostRoutes.js.map