"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createChannelImportJob = createChannelImportJob;
exports.getChannelImportJob = getChannelImportJob;
exports.cancelChannelImportJob = cancelChannelImportJob;
exports.tickChannelImportJobs = tickChannelImportJobs;
exports.publishChannelImportJob = publishChannelImportJob;
exports.startChannelImportWorker = startChannelImportWorker;
const database_1 = require("../db/database");
const telegramReader_1 = require("../forwarder/telegramReader");
const maxPublisher_1 = require("../forwarder/maxPublisher");
const logger_1 = require("../utils/logger");
const tgChannelMatch_1 = require("../utils/tgChannelMatch");
const SCAN_IDLE_MAX = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
function createChannelImportJob(tgChannel, maxChannelId) {
    const tg = (0, tgChannelMatch_1.normalizeTelegramChannelKey)(tgChannel);
    const max = maxChannelId.trim();
    if (!tg || !max) {
        throw new Error('tg_channel and max_channel_id required');
    }
    const dup = (0, database_1.getDb)()
        .prepare(`SELECT id FROM channel_import_jobs
       WHERE tg_channel = ? AND max_channel_id = ? AND status IN ('scanning', 'ready')`)
        .get(tg, max);
    if (dup) {
        throw new Error('Уже есть активная задача импорта для этой пары TG → MAX');
    }
    const r = (0, database_1.getDb)()
        .prepare('INSERT INTO channel_import_jobs (tg_channel, max_channel_id) VALUES (?, ?)')
        .run(tg, max);
    return Number(r.lastInsertRowid);
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
    if (idle >= SCAN_IDLE_MAX && stagedCount === 0) {
        (0, database_1.getDb)().prepare('DELETE FROM channel_import_jobs WHERE id = ?').run(job.id);
        return;
    }
    const nextStatus = idle >= SCAN_IDLE_MAX ? 'ready' : 'scanning';
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
    const tgToken = (process.env.TG_READER_BOT_TOKEN || '').trim();
    const jobs = (0, database_1.getDb)()
        .prepare("SELECT * FROM channel_import_jobs WHERE status = 'scanning'")
        .all();
    if (jobs.length === 0) {
        return;
    }
    if (!tgToken) {
        for (const j of jobs) {
            (0, database_1.getDb)()
                .prepare(`UPDATE channel_import_jobs SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?`)
                .run('TG_READER_BOT_TOKEN не задан', j.id);
        }
        return;
    }
    try {
        await ingestScanBatchForJobs(jobs, tgToken);
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
            const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, p.fileId);
            if (!url) {
                throw new Error('Фото: не удалось получить файл из Telegram');
            }
            await (0, maxPublisher_1.sendPhotoToMax)(maxToken, maxChannelId, url, p.caption);
            return;
        }
        case 'video': {
            const url = await (0, telegramReader_1.getTgFileUrl)(tgToken, p.fileId);
            if (!url) {
                throw new Error('Видео: не удалось получить файл из Telegram');
            }
            await (0, maxPublisher_1.sendVideoToMax)(maxToken, maxChannelId, url, p.caption);
            return;
        }
        case 'document': {
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
    }
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
            await publishStagedPayload(p, tgToken, maxToken, maxDest);
            await sleep(1500 + Math.random() * 2000);
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
    }, 3000);
}
//# sourceMappingURL=channelImportService.js.map