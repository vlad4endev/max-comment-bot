"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAutoposts = listAutoposts;
exports.getAutopostById = getAutopostById;
exports.listDueAutoposts = listDueAutoposts;
exports.createAutopost = createAutopost;
exports.updateAutopost = updateAutopost;
exports.markAutopostSent = markAutopostSent;
exports.markAutopostFailed = markAutopostFailed;
exports.deleteAutopost = deleteAutopost;
exports.setAutopostStatus = setAutopostStatus;
exports.purgeAutopostsForChannel = purgeAutopostsForChannel;
const node_crypto_1 = require("node:crypto");
const database_1 = require("../db/database");
function parseMediaJson(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter((m) => typeof m === 'object' &&
            m !== null &&
            m.type !== undefined &&
            typeof m.path === 'string' &&
            (m.type === 'photo' || m.type === 'video'));
    }
    catch {
        return [];
    }
}
function parseInlineButton(raw) {
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' &&
            parsed !== null &&
            typeof parsed.text === 'string' &&
            typeof parsed.url === 'string') {
            return { text: parsed.text, url: parsed.url };
        }
    }
    catch {
        /* ignore */
    }
    return null;
}
function parseWeekdays(raw) {
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return null;
        }
        const days = parsed.filter((d) => typeof d === 'number' && d >= 0 && d <= 6);
        return days.length > 0 ? days : null;
    }
    catch {
        return null;
    }
}
function rowToRecord(row) {
    const status = row.status;
    const schedule_type = row.schedule_type;
    return {
        id: row.id,
        text: row.text,
        media: parseMediaJson(row.media_json),
        inline_button: parseInlineButton(row.inline_button_json),
        target_channel_id: row.target_channel_id,
        channel_title: row.channel_title,
        status: status === 'active' || status === 'sent' || status === 'paused' || status === 'failed'
            ? status
            : 'active',
        schedule_type: schedule_type === 'recurring' ? 'recurring' : 'once',
        scheduled_at: row.scheduled_at,
        recurring_time: row.recurring_time,
        weekdays: parseWeekdays(row.weekdays_json),
        timezone: row.timezone || 'Europe/Moscow',
        last_sent_at: row.last_sent_at,
        last_error: row.last_error,
        sent_count: row.sent_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}
function listAutoposts() {
    const rows = (0, database_1.getDb)()
        .prepare('SELECT * FROM autoposts ORDER BY scheduled_at ASC')
        .all();
    return rows.map(rowToRecord);
}
function getAutopostById(id) {
    const row = (0, database_1.getDb)().prepare('SELECT * FROM autoposts WHERE id = ?').get(id);
    return row ? rowToRecord(row) : null;
}
function listDueAutoposts(nowIso) {
    const rows = (0, database_1.getDb)()
        .prepare(`SELECT * FROM autoposts
       WHERE status = 'active' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC`)
        .all(nowIso);
    return rows.map(rowToRecord);
}
function createAutopost(input) {
    const now = new Date().toISOString();
    const id = (0, node_crypto_1.randomUUID)();
    const media = input.media ?? [];
    const weekdays = input.weekdays ?? null;
    (0, database_1.getDb)()
        .prepare(`INSERT INTO autoposts (
        id, text, media_json, inline_button_json, target_channel_id, channel_title,
        status, schedule_type, scheduled_at, recurring_time, weekdays_json, timezone,
        last_sent_at, last_error, sent_count, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        'active', ?, ?, ?, ?, ?,
        NULL, NULL, 0, ?, ?
      )`)
        .run(id, input.text, JSON.stringify(media), input.inline_button ? JSON.stringify(input.inline_button) : null, input.target_channel_id, input.channel_title ?? null, input.schedule_type, input.scheduled_at, input.recurring_time ?? null, weekdays ? JSON.stringify(weekdays) : null, input.timezone ?? 'Europe/Moscow', now, now);
    return getAutopostById(id);
}
function updateAutopost(id, patch) {
    const current = getAutopostById(id);
    if (!current) {
        return null;
    }
    const next = {
        ...current,
        text: patch.text ?? current.text,
        media: patch.media ?? current.media,
        inline_button: patch.inline_button !== undefined ? patch.inline_button : current.inline_button,
        target_channel_id: patch.target_channel_id ?? current.target_channel_id,
        channel_title: patch.channel_title !== undefined ? patch.channel_title : current.channel_title,
        schedule_type: patch.schedule_type ?? current.schedule_type,
        scheduled_at: patch.scheduled_at ?? current.scheduled_at,
        recurring_time: patch.recurring_time !== undefined ? patch.recurring_time : current.recurring_time,
        weekdays: patch.weekdays !== undefined ? patch.weekdays : current.weekdays,
        timezone: patch.timezone ?? current.timezone,
        status: patch.status ?? current.status,
        updated_at: new Date().toISOString(),
    };
    (0, database_1.getDb)()
        .prepare(`UPDATE autoposts SET
        text = ?, media_json = ?, inline_button_json = ?,
        target_channel_id = ?, channel_title = ?,
        status = ?, schedule_type = ?, scheduled_at = ?,
        recurring_time = ?, weekdays_json = ?, timezone = ?,
        updated_at = ?
       WHERE id = ?`)
        .run(next.text, JSON.stringify(next.media), next.inline_button ? JSON.stringify(next.inline_button) : null, next.target_channel_id, next.channel_title, next.status, next.schedule_type, next.scheduled_at, next.recurring_time, next.weekdays ? JSON.stringify(next.weekdays) : null, next.timezone, next.updated_at, id);
    return getAutopostById(id);
}
function markAutopostSent(id, opts) {
    const current = getAutopostById(id);
    if (!current) {
        return null;
    }
    const now = new Date().toISOString();
    const status = opts.status ?? (current.schedule_type === 'once' ? 'sent' : 'active');
    const scheduledAt = opts.nextScheduledAt ?? current.scheduled_at;
    (0, database_1.getDb)()
        .prepare(`UPDATE autoposts SET
        status = ?, scheduled_at = ?, last_sent_at = ?, last_error = NULL,
        sent_count = sent_count + 1, updated_at = ?
       WHERE id = ?`)
        .run(status, scheduledAt, now, now, id);
    return getAutopostById(id);
}
function markAutopostFailed(id, error) {
    const now = new Date().toISOString();
    (0, database_1.getDb)()
        .prepare(`UPDATE autoposts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
        .run(error.slice(0, 2000), now, id);
    return getAutopostById(id);
}
function deleteAutopost(id) {
    const result = (0, database_1.getDb)().prepare('DELETE FROM autoposts WHERE id = ?').run(id);
    return result.changes > 0;
}
function setAutopostStatus(id, status) {
    return updateAutopost(id, { status });
}
/** Удаляет автопосты, привязанные к TG-каналу (по абсолютному значению id). */
function purgeAutopostsForChannel(channelId) {
    const abs = String(Math.abs(Number.parseInt(channelId, 10) || 0));
    const rows = listAutoposts();
    let removed = 0;
    for (const row of rows) {
        const rowAbs = String(Math.abs(Number.parseInt(row.target_channel_id, 10) || 0));
        if (rowAbs === abs && abs !== '0') {
            if (deleteAutopost(row.id)) {
                removed += 1;
            }
        }
    }
    return removed;
}
//# sourceMappingURL=autopostStore.js.map