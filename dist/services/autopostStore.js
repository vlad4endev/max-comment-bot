"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeInlineKeyboard = normalizeInlineKeyboard;
exports.primaryInlineButton = primaryInlineButton;
exports.resolveInlineKeyboard = resolveInlineKeyboard;
exports.upsertPostChannel = upsertPostChannel;
exports.listPostChannels = listPostChannels;
exports.logPostPublish = logPostPublish;
exports.listAutoposts = listAutoposts;
exports.listAutopostsFiltered = listAutopostsFiltered;
exports.computeAutopostStats = computeAutopostStats;
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
const postsDatabase_1 = require("../db/postsDatabase");
function parseMediaJson(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
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
    if (!raw)
        return null;
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
function parseInlineButtonCell(raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const row = raw;
    if (typeof row.text !== 'string' || typeof row.url !== 'string')
        return null;
    const text = row.text.trim();
    const url = row.url.trim();
    if (!text || !url || !/^https?:\/\//i.test(url))
        return null;
    return { text: text.slice(0, 64), url };
}
function normalizeInlineKeyboard(input) {
    if (!Array.isArray(input) || input.length === 0)
        return null;
    const rows = [];
    for (const rowRaw of input.slice(0, 8)) {
        if (!Array.isArray(rowRaw))
            continue;
        const row = [];
        for (const cell of rowRaw.slice(0, 2)) {
            const btn = parseInlineButtonCell(cell);
            if (btn)
                row.push(btn);
        }
        if (row.length > 0)
            rows.push(row);
    }
    return rows.length > 0 ? rows : null;
}
function parseInlineButtonsJson(buttonsRaw, legacyRaw) {
    if (buttonsRaw) {
        try {
            const parsed = normalizeInlineKeyboard(JSON.parse(buttonsRaw));
            if (parsed)
                return parsed;
        }
        catch {
            /* ignore */
        }
    }
    const legacy = parseInlineButton(legacyRaw);
    return legacy ? [[legacy]] : null;
}
function primaryInlineButton(keyboard) {
    return keyboard?.[0]?.[0] ?? null;
}
function resolveInlineKeyboard(buttons, legacy) {
    const normalized = normalizeInlineKeyboard(buttons ?? null);
    if (normalized)
        return normalized;
    if (legacy?.text?.trim() && legacy.url?.trim()) {
        return [[{ text: legacy.text.trim().slice(0, 64), url: legacy.url.trim() }]];
    }
    return null;
}
function parseWeekdays(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return null;
        const days = parsed.filter((d) => typeof d === 'number' && d >= 0 && d <= 6);
        return days.length > 0 ? days : null;
    }
    catch {
        return null;
    }
}
function parseStringArray(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return null;
        const items = parsed.filter((v) => typeof v === 'string' && v.trim() !== '');
        return items.length > 0 ? items : null;
    }
    catch {
        return null;
    }
}
function parseConditions(raw) {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((c) => typeof c === 'object' &&
            c !== null &&
            typeof c.id === 'string' &&
            typeof c.type === 'string');
    }
    catch {
        return [];
    }
}
function parseOnFailure(raw) {
    if (raw === 'retry_15m' || raw === 'stop_series' || raw === 'notify')
        return raw;
    return 'skip';
}
function rowToRecord(row) {
    const status = row.status;
    const schedule_type = row.schedule_type;
    const platform = row.platform === 'max' ? 'max' : 'telegram';
    const inline_buttons = parseInlineButtonsJson(row.inline_buttons_json, row.inline_button_json);
    return {
        id: row.id,
        platform,
        text: row.text,
        media: parseMediaJson(row.media_json),
        inline_buttons,
        inline_button: primaryInlineButton(inline_buttons),
        target_channel_id: row.target_channel_id,
        channel_title: row.channel_title,
        series_id: row.series_id,
        status: status === 'draft' ||
            status === 'active' ||
            status === 'sent' ||
            status === 'paused' ||
            status === 'failed'
            ? status
            : 'active',
        schedule_type: schedule_type === 'recurring' ? 'recurring' : 'once',
        scheduled_at: row.scheduled_at,
        recurring_time: row.recurring_time,
        weekdays: parseWeekdays(row.weekdays_json),
        daily_times: parseStringArray(row.daily_times_json),
        timezone: row.timezone || 'Europe/Moscow',
        start_date: row.start_date,
        end_date: row.end_date,
        repeat_limit: row.repeat_limit,
        on_failure: parseOnFailure(row.on_failure || 'skip'),
        conditions: parseConditions(row.conditions_json),
        last_sent_at: row.last_sent_at,
        last_error: row.last_error,
        sent_count: row.sent_count,
        platform_message_id: row.platform_message_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}
function upsertPostChannel(input) {
    (0, postsDatabase_1.getPostsDb)()
        .prepare(`INSERT INTO post_channels (id, platform, title, username, color, subscribers_count, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
       ON CONFLICT(platform, id) DO UPDATE SET
         title = COALESCE(excluded.title, post_channels.title),
         username = COALESCE(excluded.username, post_channels.username),
         color = COALESCE(excluded.color, post_channels.color),
         subscribers_count = COALESCE(excluded.subscribers_count, post_channels.subscribers_count),
         updated_at = datetime('now')`)
        .run(input.id, input.platform, input.title ?? null, input.username ?? null, input.color ?? null, input.subscribers_count ?? 0);
}
function listPostChannels(platform) {
    const rows = platform
        ? (0, postsDatabase_1.getPostsDb)()
            .prepare('SELECT * FROM post_channels WHERE platform = ? ORDER BY title ASC')
            .all(platform)
        : (0, postsDatabase_1.getPostsDb)()
            .prepare('SELECT * FROM post_channels ORDER BY platform, title ASC')
            .all();
    return rows.map((r) => ({
        id: r.id,
        platform: r.platform === 'max' ? 'max' : 'telegram',
        title: r.title,
        username: r.username,
        color: r.color,
        is_active: r.is_active === 1,
        subscribers_count: r.subscribers_count,
    }));
}
function logPostPublish(input) {
    (0, postsDatabase_1.getPostsDb)()
        .prepare(`INSERT INTO post_publish_log (autopost_id, platform, target_channel_id, status, message)
       VALUES (?, ?, ?, ?, ?)`)
        .run(input.autopost_id, input.platform, input.target_channel_id, input.status, input.message?.slice(0, 2000) ?? null);
}
function listAutoposts() {
    const rows = (0, postsDatabase_1.getPostsDb)()
        .prepare('SELECT * FROM autoposts ORDER BY scheduled_at ASC')
        .all();
    return rows.map(rowToRecord);
}
function listAutopostsFiltered(filters = {}) {
    let posts = listAutoposts();
    if (filters.status)
        posts = posts.filter((p) => p.status === filters.status);
    if (filters.platform)
        posts = posts.filter((p) => p.platform === filters.platform);
    if (filters.channelId) {
        const abs = String(Math.abs(Number.parseInt(filters.channelId, 10) || 0));
        posts = posts.filter((p) => {
            const rowAbs = String(Math.abs(Number.parseInt(p.target_channel_id, 10) || 0));
            return rowAbs === abs && abs !== '0';
        });
    }
    if (filters.scheduleType)
        posts = posts.filter((p) => p.schedule_type === filters.scheduleType);
    if (filters.search) {
        const q = filters.search.toLowerCase();
        posts = posts.filter((p) => p.text.toLowerCase().includes(q));
    }
    if (filters.from) {
        const fromMs = Date.parse(filters.from);
        if (Number.isFinite(fromMs))
            posts = posts.filter((p) => Date.parse(p.scheduled_at) >= fromMs);
    }
    if (filters.to) {
        const toMs = Date.parse(filters.to);
        if (Number.isFinite(toMs))
            posts = posts.filter((p) => Date.parse(p.scheduled_at) <= toMs);
    }
    return posts;
}
function computeAutopostStats(posts, channelCount) {
    const scheduledCount = posts.filter((p) => p.status === 'active').length;
    const activeSeries = posts.filter((p) => p.schedule_type === 'recurring' && (p.status === 'active' || p.status === 'paused')).length;
    const totalSent = posts.reduce((acc, p) => acc + p.sent_count, 0);
    const failedCount = posts.filter((p) => p.status === 'failed').length;
    const attempts = totalSent + failedCount;
    const successRate = attempts > 0 ? Math.round((totalSent / attempts) * 100) : 100;
    const channelMap = new Map();
    for (const p of posts) {
        const key = `${p.platform}:${p.target_channel_id}`;
        const cur = channelMap.get(key) ?? {
            title: p.channel_title || p.target_channel_id,
            platform: p.platform,
            sent: 0,
        };
        cur.sent += p.sent_count;
        channelMap.set(key, cur);
    }
    const byChannel = [...channelMap.entries()]
        .map(([key, v]) => ({
        channelId: key.split(':').slice(1).join(':'),
        title: v.title,
        platform: v.platform,
        sent: v.sent,
    }))
        .sort((a, b) => b.sent - a.sent);
    const heatHours = [9, 12, 15, 18, 21];
    const heatmap = Array.from({ length: 7 }, () => heatHours.map(() => 0));
    for (const p of posts) {
        if (p.sent_count <= 0)
            continue;
        const ref = p.last_sent_at || p.scheduled_at;
        const d = new Date(ref);
        if (Number.isNaN(d.getTime()))
            continue;
        let day = d.getDay();
        day = day === 0 ? 6 : day - 1;
        const hour = d.getHours();
        let col = heatHours.findIndex((h) => Math.abs(h - hour) <= 1);
        if (col < 0)
            col = 2;
        heatmap[day][col] += p.sent_count;
    }
    return {
        totalPosts: posts.length,
        scheduledCount,
        activeSeries,
        connectedChannels: channelCount,
        totalSent,
        successRate,
        byChannel,
        heatmap,
    };
}
function getAutopostById(id) {
    const row = (0, postsDatabase_1.getPostsDb)().prepare('SELECT * FROM autoposts WHERE id = ?').get(id);
    return row ? rowToRecord(row) : null;
}
function listDueAutoposts(nowIso) {
    const rows = (0, postsDatabase_1.getPostsDb)()
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
    const platform = input.platform ?? 'telegram';
    const status = input.status ?? 'active';
    const inline_buttons = resolveInlineKeyboard(input.inline_buttons, input.inline_button ?? null);
    const inline_button = primaryInlineButton(inline_buttons);
    upsertPostChannel({
        id: input.target_channel_id,
        platform,
        title: input.channel_title,
    });
    (0, postsDatabase_1.getPostsDb)()
        .prepare(`INSERT INTO autoposts (
        id, platform, target_channel_id, channel_title, series_id, text, media_json,
        inline_button_json, inline_buttons_json, status, schedule_type, scheduled_at, recurring_time,
        weekdays_json, daily_times_json, timezone, start_date, end_date, repeat_limit,
        on_failure, conditions_json, last_sent_at, last_error, sent_count, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, NULL, NULL, 0, ?, ?
      )`)
        .run(id, platform, input.target_channel_id, input.channel_title ?? null, input.series_id ?? null, input.text, JSON.stringify(media), inline_button ? JSON.stringify(inline_button) : null, inline_buttons ? JSON.stringify(inline_buttons) : null, status, input.schedule_type, input.scheduled_at, input.recurring_time ?? null, weekdays ? JSON.stringify(weekdays) : null, input.daily_times ? JSON.stringify(input.daily_times) : null, input.timezone ?? 'Europe/Moscow', input.start_date ?? null, input.end_date ?? null, input.repeat_limit ?? null, input.on_failure ?? 'skip', JSON.stringify(input.conditions ?? []), now, now);
    return getAutopostById(id);
}
function updateAutopost(id, patch) {
    const current = getAutopostById(id);
    if (!current)
        return null;
    const resolvedKeyboard = patch.inline_buttons !== undefined || patch.inline_button !== undefined
        ? resolveInlineKeyboard(patch.inline_buttons !== undefined ? patch.inline_buttons : current.inline_buttons, patch.inline_button !== undefined ? patch.inline_button : current.inline_button)
        : current.inline_buttons;
    const next = {
        ...current,
        platform: patch.platform ?? current.platform,
        text: patch.text ?? current.text,
        media: patch.media ?? current.media,
        inline_buttons: resolvedKeyboard,
        inline_button: primaryInlineButton(resolvedKeyboard),
        target_channel_id: patch.target_channel_id ?? current.target_channel_id,
        channel_title: patch.channel_title !== undefined ? patch.channel_title : current.channel_title,
        series_id: patch.series_id !== undefined ? patch.series_id : current.series_id,
        schedule_type: patch.schedule_type ?? current.schedule_type,
        scheduled_at: patch.scheduled_at ?? current.scheduled_at,
        recurring_time: patch.recurring_time !== undefined ? patch.recurring_time : current.recurring_time,
        weekdays: patch.weekdays !== undefined ? patch.weekdays : current.weekdays,
        daily_times: patch.daily_times !== undefined ? patch.daily_times : current.daily_times,
        timezone: patch.timezone ?? current.timezone,
        start_date: patch.start_date !== undefined ? patch.start_date : current.start_date,
        end_date: patch.end_date !== undefined ? patch.end_date : current.end_date,
        repeat_limit: patch.repeat_limit !== undefined ? patch.repeat_limit : current.repeat_limit,
        on_failure: patch.on_failure ?? current.on_failure,
        conditions: patch.conditions !== undefined ? patch.conditions : current.conditions,
        status: patch.status ?? current.status,
        platform_message_id: patch.platform_message_id !== undefined ? patch.platform_message_id : current.platform_message_id,
        updated_at: new Date().toISOString(),
    };
    if (patch.target_channel_id || patch.channel_title) {
        upsertPostChannel({
            id: next.target_channel_id,
            platform: next.platform,
            title: next.channel_title,
        });
    }
    (0, postsDatabase_1.getPostsDb)()
        .prepare(`UPDATE autoposts SET
        platform = ?, text = ?, media_json = ?, inline_button_json = ?, inline_buttons_json = ?,
        target_channel_id = ?, channel_title = ?, series_id = ?,
        status = ?, schedule_type = ?, scheduled_at = ?,
        recurring_time = ?, weekdays_json = ?, daily_times_json = ?, timezone = ?,
        start_date = ?, end_date = ?, repeat_limit = ?,
        on_failure = ?, conditions_json = ?, platform_message_id = ?,
        updated_at = ?
       WHERE id = ?`)
        .run(next.platform, next.text, JSON.stringify(next.media), next.inline_button ? JSON.stringify(next.inline_button) : null, next.inline_buttons ? JSON.stringify(next.inline_buttons) : null, next.target_channel_id, next.channel_title, next.series_id, next.status, next.schedule_type, next.scheduled_at, next.recurring_time, next.weekdays ? JSON.stringify(next.weekdays) : null, next.daily_times ? JSON.stringify(next.daily_times) : null, next.timezone, next.start_date, next.end_date, next.repeat_limit, next.on_failure, JSON.stringify(next.conditions), next.platform_message_id, next.updated_at, id);
    return getAutopostById(id);
}
function markAutopostSent(id, opts) {
    const current = getAutopostById(id);
    if (!current)
        return null;
    const now = new Date().toISOString();
    const status = opts.status ?? (current.schedule_type === 'once' ? 'sent' : 'active');
    const scheduledAt = opts.nextScheduledAt ?? current.scheduled_at;
    (0, postsDatabase_1.getPostsDb)()
        .prepare(`UPDATE autoposts SET
        status = ?, scheduled_at = ?, last_sent_at = ?, last_error = NULL,
        sent_count = sent_count + 1,
        platform_message_id = COALESCE(?, platform_message_id),
        updated_at = ?
       WHERE id = ?`)
        .run(status, scheduledAt, now, opts.platformMessageId ?? null, now, id);
    logPostPublish({
        autopost_id: id,
        platform: current.platform,
        target_channel_id: current.target_channel_id,
        status: 'success',
    });
    return getAutopostById(id);
}
function markAutopostFailed(id, error) {
    const current = getAutopostById(id);
    if (!current)
        return null;
    const now = new Date().toISOString();
    (0, postsDatabase_1.getPostsDb)()
        .prepare(`UPDATE autoposts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
        .run(error.slice(0, 2000), now, id);
    logPostPublish({
        autopost_id: id,
        platform: current.platform,
        target_channel_id: current.target_channel_id,
        status: 'failed',
        message: error,
    });
    return getAutopostById(id);
}
function deleteAutopost(id) {
    const result = (0, postsDatabase_1.getPostsDb)().prepare('DELETE FROM autoposts WHERE id = ?').run(id);
    return result.changes > 0;
}
function setAutopostStatus(id, status) {
    return updateAutopost(id, { status });
}
function purgeAutopostsForChannel(channelId, platform = 'telegram') {
    const abs = String(Math.abs(Number.parseInt(channelId, 10) || 0));
    const rows = listAutoposts().filter((p) => p.platform === platform);
    let removed = 0;
    for (const row of rows) {
        const rowAbs = String(Math.abs(Number.parseInt(row.target_channel_id, 10) || 0));
        if (rowAbs === abs && abs !== '0' && deleteAutopost(row.id)) {
            removed += 1;
        }
    }
    return removed;
}
//# sourceMappingURL=autopostStore.js.map