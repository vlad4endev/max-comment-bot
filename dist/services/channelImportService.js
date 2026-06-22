"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCAN_IDLE_MAX = void 0;
exports.resolveImportTgToken = resolveImportTgToken;
exports.readerTokenMeta = readerTokenMeta;
exports.assertTelegramPollingReady = assertTelegramPollingReady;
exports.toChannelImportJobView = toChannelImportJobView;
exports.getActiveChannelImportJob = getActiveChannelImportJob;
exports.createChannelImportJob = createChannelImportJob;
exports.runArchiveImportJob = runArchiveImportJob;
exports.getChannelImportJob = getChannelImportJob;
exports.cancelChannelImportJob = cancelChannelImportJob;
exports.tickChannelImportJobs = tickChannelImportJobs;
exports.publishChannelImportJob = publishChannelImportJob;
exports.startChannelImportWorker = startChannelImportWorker;
const axios_1 = __importDefault(require("axios"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const database_1 = require("../db/database");
const telegramReader_1 = require("../forwarder/telegramReader");
const maxPublisher_1 = require("../forwarder/maxPublisher");
const logger_1 = require("../utils/logger");
const telegramUserArchive_1 = require("./telegramUserArchive");
const tgChannelMatch_1 = require("../utils/tgChannelMatch");
exports.SCAN_IDLE_MAX = 5;
const TG_API = 'https://api.telegram.org/bot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function resolveImportTgToken() {
    const reader = (process.env.TG_READER_BOT_TOKEN || '').trim();
    if (reader)
        return reader;
    return (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
}
function readerTokenMeta() {
    const reader = (process.env.TG_READER_BOT_TOKEN || '').trim();
    const fallback = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
    if (reader)
        return { ok: true, usesMainToken: false };
    return { ok: fallback.length > 0, usesMainToken: fallback.length > 0 };
}
async function assertTelegramPollingReady(tgToken) {
    if (!tgToken) {
        return 'Не задан TG_READER_BOT_TOKEN (или TG_TOKEN в интеграции)';
    }
    try {
        const { data } = await axios_1.default.get(`${TG_API}${tgToken}/getWebhookInfo`, { timeout: 10_000 });
        const url = data.result?.url?.trim();
        if (data.ok && url) {
            return `У бота включён webhook (${url}) — getUpdates пустой. Отключите webhook (deleteWebhook) для reader-бота.`;
        }
    }
    catch {
        /* ignore probe errors */
    }
    return null;
}
function toChannelImportJobView(job) {
    const tokenMeta = readerTokenMeta();
    const staged = job.staged_count ?? 0;
    let statusHint = null;
    if (job.status === 'archive_fetch') {
        statusHint =
            staged > 0
                ? `Загрузка архива… подготовлено постов: ${staged}`
                : 'Загрузка архива канала через user-аккаунт (MTProto)…';
    }
    else if (job.status === 'scanning') {
        const step = Math.min(job.scan_idle_rounds + 1, exports.SCAN_IDLE_MAX);
        statusHint = `Опрос Telegram ${step}/${exports.SCAN_IDLE_MAX}… Найдено постов: ${staged}. Если долго 0 — в канале нет новых постов в очереди бота.`;
    }
    else if (job.status === 'ready' && staged === 0) {
        statusHint =
            job.import_source === 'user_archive'
                ? 'Архив не дал постов: нет доступа user-аккаунта к каналу или сообщения без текста/медиа.'
                : 'В очереди обновлений бота нет постов этого канала. Опубликуйте новый пост в TG или проверьте, что reader-бот — админ в канале.';
    }
    else if (job.status === 'ready' && staged > 0) {
        statusHint = 'Можно публиковать в MAX.';
    }
    return {
        ...job,
        scan_idle_max: exports.SCAN_IDLE_MAX,
        status_hint: job.error_message ?? statusHint,
        can_publish: job.status === 'ready' && staged > 0,
        reader_token_ok: tokenMeta.ok,
        reader_uses_main_token: tokenMeta.usesMainToken,
        user_archive_ready: (0, telegramUserArchive_1.telegramUserArchiveConfigured)(),
    };
}
function getActiveChannelImportJob() {
    const job = (0, database_1.getDb)()
        .prepare(`SELECT * FROM channel_import_jobs
       WHERE status IN ('scanning', 'archive_fetch', 'ready')
       ORDER BY id DESC LIMIT 1`)
        .get();
    return job ? toChannelImportJobView(job) : undefined;
}
function getImportReaderOffset() {
    const row = (0, database_1.getDb)()
        .prepare('SELECT scan_next_offset FROM channel_import_reader_state WHERE id = 1')
        .get();
    return row?.scan_next_offset ?? 0;
}
function setImportReaderOffset(offset) {
    (0, database_1.getDb)()
        .prepare('UPDATE channel_import_reader_state SET scan_next_offset = ? WHERE id = 1')
        .run(offset);
}
function buildStagingPayload(msg) {
    const caption = (msg.caption || msg.text || '').trim();
    if (msg.photo && msg.photo.length > 0) {
        const largest = msg.photo[msg.photo.length - 1];
        return { kind: 'photo', caption, fileId: largest.file_id };
    }
    if (msg.video?.file_id) {
        return { kind: 'video', caption, fileId: msg.video.file_id };
    }
    if (msg.document?.file_id) {
        return {
            kind: 'document',
            caption,
            fileId: msg.document.file_id,
            fileName: msg.document.file_name,
            mimeType: msg.document.mime_type,
        };
    }
    if (caption) {
        return { kind: 'text', text: caption };
    }
    return null;
}
function createChannelImportJob(tgChannel, maxChannelId, options) {
    const tg = (0, tgChannelMatch_1.normalizeTelegramChannelKey)(tgChannel);
    const max = maxChannelId.trim();
    if (!tg || !max) {
        throw new Error('tg_channel and max_channel_id required');
    }
    const dup = (0, database_1.getDb)()
        .prepare(`SELECT id FROM channel_import_jobs
       WHERE tg_channel = ? AND max_channel_id = ? AND status IN ('scanning', 'archive_fetch', 'ready')`)
        .get(tg, max);
    if (dup) {
        throw new Error('Уже есть активная задача импорта для этой пары TG → MAX');
    }
    const useArchive = options?.archive === true;
    if (useArchive && !(0, telegramUserArchive_1.telegramUserArchiveConfigured)()) {
        throw new Error('Архив недоступен: настройте MTProto в блоке ниже (api_id, api_hash и вход по телефону)');
    }
    const initialStatus = useArchive ? 'archive_fetch' : 'scanning';
    const r = (0, database_1.getDb)()
        .prepare('INSERT INTO channel_import_jobs (tg_channel, max_channel_id, status, import_source) VALUES (?, ?, ?, ?)')
        .run(tg, max, initialStatus, useArchive ? 'user_archive' : 'bot_queue');
    const jobId = Number(r.lastInsertRowid);
    if (useArchive) {
        const limit = Math.min(Math.max(options?.archiveLimit ?? 100, 1), 500);
        void runArchiveImportJob(jobId, limit).catch((err) => {
            logger_1.logger.error('[channelImport] archive job failed job=' + String(jobId), err);
        });
    }
    return jobId;
}
async function runArchiveImportJob(jobId, limit) {
    const job = getChannelImportJob(jobId);
    if (!job || job.status !== 'archive_fetch') {
        return;
    }
    try {
        const insertStmt = (0, database_1.getDb)().prepare('INSERT OR IGNORE INTO channel_import_staged (job_id, tg_message_id, payload) VALUES (?, ?, ?)');
        const bumpProgress = (0, database_1.getDb)().prepare(`UPDATE channel_import_jobs
       SET staged_count = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'archive_fetch'`);
        const stagedCount = await (0, telegramUserArchive_1.fetchChannelArchiveForImport)(job.tg_channel, limit, jobId, async (post) => {
            insertStmt.run(jobId, post.messageId, JSON.stringify(post.payload));
            const row = (0, database_1.getDb)()
                .prepare('SELECT COUNT(*) AS c FROM channel_import_staged WHERE job_id = ?')
                .get(jobId);
            bumpProgress.run(row?.c ?? 0, jobId);
        });
        (0, database_1.getDb)()
            .prepare(`UPDATE channel_import_jobs
         SET status = 'ready', staged_count = ?, scan_idle_rounds = 0, error_message = NULL, updated_at = datetime('now')
         WHERE id = ?`)
            .run(stagedCount, jobId);
        logger_1.logger.info('[channelImport] archive ready', { jobId, stagedCount });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (0, database_1.getDb)()
            .prepare(`UPDATE channel_import_jobs SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(msg, jobId);
        throw err;
    }
}
function getChannelImportJob(id) {
    return (0, database_1.getDb)()
        .prepare('SELECT * FROM channel_import_jobs WHERE id = ?')
        .get(id);
}
function cancelChannelImportJob(id) {
    const r = (0, database_1.getDb)().prepare('DELETE FROM channel_import_jobs WHERE id = ?').run(id);
    return r.changes > 0;
}
function updateJobAfterBatch(job, jobGotPosts) {
    const idle = jobGotPosts ? 0 : job.scan_idle_rounds + 1;
    const stagedRow = (0, database_1.getDb)()
        .prepare('SELECT COUNT(*) AS c FROM channel_import_staged WHERE job_id = ?')
        .get(job.id);
    const stagedCount = stagedRow?.c ?? 0;
    const nextStatus = idle >= exports.SCAN_IDLE_MAX ? 'ready' : 'scanning';
    (0, database_1.getDb)()
        .prepare(`UPDATE channel_import_jobs
       SET scan_idle_rounds = ?, staged_count = ?, status = ?, updated_at = datetime('now')
       WHERE id = ?`)
        .run(idle, stagedCount, nextStatus, job.id);
}
async function ingestScanBatchForJobs(jobs, tgToken) {
    const offset = getImportReaderOffset();
    const batch = await (0, telegramReader_1.getTelegramUpdatesWithIds)(tgToken, offset, 0);
    let nextOffset = offset;
    const jobTouched = new Set();
    for (const u of batch) {
        nextOffset = Math.max(nextOffset, u.update_id + 1);
        const msg = u.channel_post;
        if (!msg)
            continue;
        for (const job of jobs) {
            if (!(0, tgChannelMatch_1.telegramChannelMatchesTarget)(msg.chat, job.tg_channel)) {
                continue;
            }
            const payload = buildStagingPayload(msg);
            if (!payload) {
                continue;
            }
            const ins = (0, database_1.getDb)()
                .prepare('INSERT OR IGNORE INTO channel_import_staged (job_id, tg_message_id, payload) VALUES (?, ?, ?)')
                .run(job.id, msg.message_id, JSON.stringify(payload));
            if (ins.changes > 0) {
                jobTouched.add(job.id);
            }
        }
    }
    if (nextOffset > offset) {
        setImportReaderOffset(nextOffset);
    }
    for (const job of jobs) {
        const fresh = getChannelImportJob(job.id);
        if (!fresh)
            continue;
        updateJobAfterBatch(fresh, jobTouched.has(job.id));
    }
}
async function tickChannelImportJobs() {
    const tgToken = resolveImportTgToken();
    const jobs = (0, database_1.getDb)()
        .prepare("SELECT * FROM channel_import_jobs WHERE status = 'scanning'")
        .all();
    if (jobs.length === 0) {
        return;
    }
    const configErr = await assertTelegramPollingReady(tgToken);
    if (configErr) {
        for (const j of jobs) {
            (0, database_1.getDb)()
                .prepare(`UPDATE channel_import_jobs SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?`)
                .run(configErr, j.id);
        }
        return;
    }
    try {
        await ingestScanBatchForJobs(jobs, tgToken);
        logger_1.logger.info('[channelImport] tick', {
            jobs: jobs.length,
            jobIds: jobs.map((j) => j.id),
        });
    }
    catch (err) {
        logger_1.logger.error('[channelImport] scan batch failed', err);
        const msg = err instanceof Error ? err.message : String(err);
        for (const job of jobs) {
            (0, database_1.getDb)()
                .prepare(`UPDATE channel_import_jobs SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?`)
                .run(msg, job.id);
        }
    }
}
async function publishStagedPayload(p, tgToken, maxToken, maxChannelId) {
    switch (p.kind) {
        case 'text':
            await (0, maxPublisher_1.sendTextToMax)(maxToken, maxChannelId, p.text);
            return;
        case 'photo': {
            if (p.localPath) {
                await (0, maxPublisher_1.sendPhotoFileToMax)(maxToken, maxChannelId, p.localPath, p.caption);
                return;
            }
            if (!p.fileId)
                throw new Error('Фото: нет fileId');
            const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, p.fileId);
            if (!url) {
                throw new Error('Фото: не удалось получить файл из Telegram');
            }
            await (0, maxPublisher_1.sendPhotoToMax)(maxToken, maxChannelId, url, p.caption);
            return;
        }
        case 'video': {
            if (p.localPath) {
                await (0, maxPublisher_1.sendVideoFileToMax)(maxToken, maxChannelId, p.localPath, p.caption);
                return;
            }
            if (!p.fileId)
                throw new Error('Видео: нет fileId');
            const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, p.fileId);
            if (!url) {
                throw new Error('Видео: не удалось получить файл из Telegram');
            }
            await (0, maxPublisher_1.sendVideoToMax)(maxToken, maxChannelId, url, p.caption);
            return;
        }
        case 'document': {
            if (p.localPath) {
                await (0, maxPublisher_1.sendDocumentFileToMax)(maxToken, maxChannelId, p.localPath, p.caption, {
                    filename: p.fileName,
                    contentType: p.mimeType,
                });
                return;
            }
            if (!p.fileId)
                throw new Error('Документ: нет fileId');
            const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, p.fileId);
            if (!url) {
                throw new Error('Документ: не удалось получить файл из Telegram');
            }
            await (0, maxPublisher_1.sendDocumentToMax)(maxToken, maxChannelId, url, p.caption, {
                filename: p.fileName,
                contentType: p.mimeType,
            });
            return;
        }
        case 'album': {
            if (!p.items.length) {
                throw new Error('Альбом: пустой список медиа');
            }
            await (0, maxPublisher_1.sendMediaAlbumFilesToMax)(maxToken, maxChannelId, p.caption, p.items.map((item) => ({
                type: item.kind === 'photo' ? 'image' : item.kind === 'video' ? 'video' : 'file',
                filePath: item.localPath,
                filename: item.kind === 'document' ? item.fileName : undefined,
                contentType: item.kind === 'document' ? item.mimeType : undefined,
            })));
            return;
        }
    }
}
function payloadLocalPaths(payload) {
    if (payload.kind === 'album') {
        return payload.items.map((item) => item.localPath).filter(Boolean);
    }
    if ('localPath' in payload && payload.localPath) {
        return [payload.localPath];
    }
    return [];
}
async function cleanupImportTempDirectory(jobId) {
    const tmpDir = node_path_1.default.join(node_os_1.default.tmpdir(), 'maxcomment-import', String(jobId));
    await promises_1.default.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
}
async function publishChannelImportJob(jobId, tgToken, maxToken) {
    const job = getChannelImportJob(jobId);
    if (!job || job.status !== 'ready') {
        throw new Error('Импорт не готов к публикации (ожидайте статус ready)');
    }
    (0, database_1.getDb)()
        .prepare(`UPDATE channel_import_jobs SET status = 'publishing', error_message = NULL, updated_at = datetime('now') WHERE id = ?`)
        .run(jobId);
    const rows = (0, database_1.getDb)()
        .prepare('SELECT * FROM channel_import_staged WHERE job_id = ? ORDER BY id ASC')
        .all(jobId);
    const maxDest = job.max_channel_id.trim();
    if (!maxDest) {
        throw new Error('MAX-канал не задан');
    }
    try {
        for (const row of rows) {
            const p = JSON.parse(row.payload);
            logger_1.logger.info('[channelImport] Публикую пост в MAX', {
                jobId,
                stagedId: row.id,
                tgMessageId: row.tg_message_id,
                payloadKind: p.kind,
            });
            let published = false;
            try {
                await publishStagedPayload(p, tgToken, maxToken, maxDest);
                published = true;
            }
            finally {
                if (published) {
                    const localPaths = payloadLocalPaths(p);
                    for (const localPath of localPaths) {
                        await promises_1.default.rm(localPath, { force: true }).catch(() => { });
                    }
                }
            }
            logger_1.logger.info('[channelImport] Пост опубликован, жду перед следующим', {
                jobId,
                stagedId: row.id,
                delayMs: 1500,
            });
            await sleep(1500 + Math.random() * 500);
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (0, database_1.getDb)()
            .prepare(`UPDATE channel_import_jobs SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(msg, jobId);
        throw err;
    }
    (0, database_1.getDb)().prepare('DELETE FROM channel_import_staged WHERE job_id = ?').run(jobId);
    (0, database_1.getDb)().prepare('DELETE FROM channel_import_jobs WHERE id = ?').run(jobId);
    await cleanupImportTempDirectory(jobId);
}
let workerStarted = false;
function startChannelImportWorker() {
    if (workerStarted) {
        return;
    }
    workerStarted = true;
    setInterval(() => {
        void tickChannelImportJobs().catch((err) => {
            logger_1.logger.error('[channelImport] tick', err);
        });
    }, 2000);
}
//# sourceMappingURL=channelImportService.js.map