"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAntispamStoreLoaded = ensureAntispamStoreLoaded;
exports.reloadAntispamStore = reloadAntispamStore;
exports.getAntispamEngineSync = getAntispamEngineSync;
exports.getAntispamRulesSync = getAntispamRulesSync;
exports.getGlobalStopwordsSync = getGlobalStopwordsSync;
exports.getScoredWordsSync = getScoredWordsSync;
exports.countScoredWordsSync = countScoredWordsSync;
exports.saveScoredWordsToStore = saveScoredWordsToStore;
exports.getChannelAntispamSettingsSync = getChannelAntispamSettingsSync;
exports.isAntispamRestrictedUserSync = isAntispamRestrictedUserSync;
exports.getAntispamWordsSnapshot = getAntispamWordsSnapshot;
exports.saveAntispamEngineToStore = saveAntispamEngineToStore;
exports.saveAntispamWordsToStore = saveAntispamWordsToStore;
exports.saveChannelAntispamSettings = saveChannelAntispamSettings;
exports.restrictAntispamUserInStore = restrictAntispamUserInStore;
exports.pushAntispamLogToStore = pushAntispamLogToStore;
exports.listAntispamLogFromStore = listAntispamLogFromStore;
exports.purgeAntispamChannelData = purgeAntispamChannelData;
exports.countAntispamBlocksTodayFromStore = countAntispamBlocksTodayFromStore;
const node_crypto_1 = require("node:crypto");
const antispamDatabase_1 = require("../db/antispamDatabase");
const seedAntispamScoredWords_1 = require("../db/seedAntispamScoredWords");
const DEFAULT_ENGINE = {
    soft_mode: false,
    enabled: true,
    spam_threshold: 20,
    ban_threshold: 100,
    captcha_required_score: 15,
    emoji_overuse_limit: 20,
    whitelist_user_ids: [685859062],
    blacklist_user_ids: [],
};
const DEFAULT_RULES = {
    block_links: true,
    flood_protection: true,
    caps_protection: false,
    emoji_spam: false,
};
let cache = null;
function intFromBool(v) {
    return v ? 1 : 0;
}
function parseIdList(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((id) => typeof id === 'number' && id > 0);
    }
    catch {
        return [];
    }
}
function loadEngineFromDb() {
    const row = (0, antispamDatabase_1.getAntispamDb)()
        .prepare('SELECT * FROM antispam_engine WHERE id = 1')
        .get();
    return {
        soft_mode: row.soft_mode === 1,
        enabled: row.enabled === 1,
        spam_threshold: row.spam_threshold,
        ban_threshold: row.ban_threshold,
        captcha_required_score: row.captcha_required_score,
        emoji_overuse_limit: row.emoji_overuse_limit,
        whitelist_user_ids: parseIdList(row.whitelist_user_ids_json),
        blacklist_user_ids: parseIdList(row.blacklist_user_ids_json),
    };
}
function loadRulesFromDb() {
    const row = (0, antispamDatabase_1.getAntispamDb)()
        .prepare('SELECT * FROM antispam_rules WHERE id = 1')
        .get();
    return {
        block_links: row.block_links === 1,
        flood_protection: row.flood_protection === 1,
        caps_protection: row.caps_protection === 1,
        emoji_spam: row.emoji_spam === 1,
    };
}
function loadCacheFromDb() {
    const globalRows = (0, antispamDatabase_1.getAntispamDb)()
        .prepare("SELECT word FROM antispam_stopwords WHERE scope = 'global' ORDER BY word ASC")
        .all();
    const channelWordRows = (0, antispamDatabase_1.getAntispamDb)()
        .prepare("SELECT channel_chat_id, word FROM antispam_stopwords WHERE scope = 'channel' ORDER BY channel_chat_id, word ASC")
        .all();
    const channelStopwords = new Map();
    for (const row of channelWordRows) {
        const list = channelStopwords.get(row.channel_chat_id) ?? [];
        list.push(row.word);
        channelStopwords.set(row.channel_chat_id, list);
    }
    const channelSettings = new Map();
    const settingsRows = (0, antispamDatabase_1.getAntispamDb)()
        .prepare('SELECT * FROM antispam_channel_settings')
        .all();
    for (const row of settingsRows) {
        channelSettings.set(row.channel_chat_id, {
            block_links: row.block_links === null ? null : row.block_links === 1,
            flood_protection: row.flood_protection === null ? null : row.flood_protection === 1,
            auto_mute: row.auto_mute === 1,
        });
    }
    const restrictedRows = (0, antispamDatabase_1.getAntispamDb)()
        .prepare('SELECT user_id FROM antispam_restricted_users')
        .all();
    return {
        engine: loadEngineFromDb(),
        rules: loadRulesFromDb(),
        globalStopwords: globalRows.map((r) => r.word),
        scoredWordsByScore: (0, seedAntispamScoredWords_1.loadScoredWordsFromDb)(),
        channelStopwords,
        channelSettings,
        restrictedUsers: new Set(restrictedRows.map((r) => r.user_id)),
    };
}
function ensureAntispamStoreLoaded() {
    if (!cache) {
        (0, antispamDatabase_1.getAntispamDb)();
        cache = loadCacheFromDb();
    }
}
function reloadAntispamStore() {
    (0, antispamDatabase_1.getAntispamDb)();
    cache = loadCacheFromDb();
}
function getAntispamEngineSync() {
    ensureAntispamStoreLoaded();
    return { ...cache.engine };
}
function getAntispamRulesSync() {
    ensureAntispamStoreLoaded();
    return { ...cache.rules };
}
function getGlobalStopwordsSync() {
    ensureAntispamStoreLoaded();
    return [...cache.globalStopwords];
}
function getScoredWordsSync() {
    ensureAntispamStoreLoaded();
    const src = cache.scoredWordsByScore;
    const out = {};
    for (const [score, words] of Object.entries(src)) {
        out[Number(score)] = [...words];
    }
    return out;
}
function countScoredWordsSync() {
    ensureAntispamStoreLoaded();
    let n = 0;
    for (const words of Object.values(cache.scoredWordsByScore)) {
        n += words.length;
    }
    return n;
}
function saveScoredWordsToStore(dict) {
    ensureAntispamStoreLoaded();
    (0, seedAntispamScoredWords_1.persistScoredWords)(dict);
    cache.scoredWordsByScore = (0, seedAntispamScoredWords_1.loadScoredWordsFromDb)();
    return getScoredWordsSync();
}
function getChannelAntispamSettingsSync(chatId) {
    ensureAntispamStoreLoaded();
    const settings = cache.channelSettings.get(chatId);
    return {
        stopwords: [...(cache.channelStopwords.get(chatId) ?? [])],
        block_links: settings?.block_links ?? null,
        flood_protection: settings?.flood_protection ?? null,
        auto_mute: settings?.auto_mute ?? false,
    };
}
function isAntispamRestrictedUserSync(userId) {
    ensureAntispamStoreLoaded();
    if (!Number.isInteger(userId) || userId <= 0)
        return false;
    return cache.restrictedUsers.has(userId);
}
function getAntispamWordsSnapshot() {
    ensureAntispamStoreLoaded();
    const byChannel = {};
    for (const [chatId, words] of cache.channelStopwords.entries()) {
        byChannel[String(chatId)] = [...words];
    }
    return {
        global: [...cache.globalStopwords],
        byChannel,
        rules: { ...cache.rules },
        engine: { ...cache.engine },
        restricted_users: [...cache.restrictedUsers],
        scored_words: getScoredWordsSync(),
        scored_words_total: countScoredWordsSync(),
    };
}
function saveAntispamEngineToStore(patch) {
    ensureAntispamStoreLoaded();
    const next = {
        ...cache.engine,
        ...patch,
    };
    if (patch.whitelist_user_ids) {
        next.whitelist_user_ids = patch.whitelist_user_ids.filter((id) => id > 0);
    }
    if (patch.blacklist_user_ids) {
        next.blacklist_user_ids = patch.blacklist_user_ids.filter((id) => id > 0);
    }
    const now = new Date().toISOString();
    (0, antispamDatabase_1.getAntispamDb)()
        .prepare(`UPDATE antispam_engine SET
        soft_mode = ?, enabled = ?, spam_threshold = ?, ban_threshold = ?,
        captcha_required_score = ?, emoji_overuse_limit = ?,
        whitelist_user_ids_json = ?, blacklist_user_ids_json = ?, updated_at = ?
       WHERE id = 1`)
        .run(intFromBool(next.soft_mode), intFromBool(next.enabled), next.spam_threshold, next.ban_threshold, next.captcha_required_score, next.emoji_overuse_limit, JSON.stringify(next.whitelist_user_ids), JSON.stringify(next.blacklist_user_ids), now);
    cache.engine = next;
    return { ...next };
}
function saveAntispamWordsToStore(input) {
    ensureAntispamStoreLoaded();
    const db = (0, antispamDatabase_1.getAntispamDb)();
    if (input.global) {
        const words = [...new Set(input.global.map((w) => w.trim().toLowerCase()).filter(Boolean))];
        const tx = db.transaction(() => {
            db.prepare("DELETE FROM antispam_stopwords WHERE scope = 'global'").run();
            const insert = db.prepare("INSERT INTO antispam_stopwords (scope, channel_chat_id, word) VALUES ('global', NULL, ?)");
            for (const word of words) {
                insert.run(word);
            }
        });
        tx();
        cache.globalStopwords = words;
    }
    if (input.rules) {
        const next = { ...cache.rules, ...input.rules };
        (0, antispamDatabase_1.getAntispamDb)()
            .prepare(`UPDATE antispam_rules SET
          block_links = ?, flood_protection = ?, caps_protection = ?, emoji_spam = ?, updated_at = ?
         WHERE id = 1`)
            .run(intFromBool(next.block_links), intFromBool(next.flood_protection), intFromBool(next.caps_protection), intFromBool(next.emoji_spam), new Date().toISOString());
        cache.rules = next;
    }
}
function saveChannelAntispamSettings(chatId, patch) {
    ensureAntispamStoreLoaded();
    const current = getChannelAntispamSettingsSync(chatId);
    const next = {
        stopwords: patch.stopwords
            ? [...new Set(patch.stopwords.map((w) => w.trim().toLowerCase()).filter(Boolean))]
            : current.stopwords,
        block_links: patch.block_links !== undefined ? patch.block_links : current.block_links,
        flood_protection: patch.flood_protection !== undefined ? patch.flood_protection : current.flood_protection,
        auto_mute: patch.auto_mute !== undefined ? patch.auto_mute : current.auto_mute,
    };
    const db = (0, antispamDatabase_1.getAntispamDb)();
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM antispam_stopwords WHERE scope = ? AND channel_chat_id = ?').run('channel', chatId);
        const insertWord = db.prepare("INSERT INTO antispam_stopwords (scope, channel_chat_id, word) VALUES ('channel', ?, ?)");
        for (const word of next.stopwords) {
            insertWord.run(chatId, word);
        }
        db.prepare(`INSERT INTO antispam_channel_settings (
        channel_chat_id, block_links, flood_protection, auto_mute, updated_at
      ) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(channel_chat_id) DO UPDATE SET
        block_links = excluded.block_links,
        flood_protection = excluded.flood_protection,
        auto_mute = excluded.auto_mute,
        updated_at = excluded.updated_at`).run(chatId, next.block_links === null ? null : intFromBool(next.block_links), next.flood_protection === null ? null : intFromBool(next.flood_protection), intFromBool(next.auto_mute));
    });
    tx();
    cache.channelStopwords.set(chatId, next.stopwords);
    cache.channelSettings.set(chatId, {
        block_links: next.block_links,
        flood_protection: next.flood_protection,
        auto_mute: next.auto_mute,
    });
    return next;
}
function restrictAntispamUserInStore(userId) {
    if (!Number.isInteger(userId) || userId <= 0)
        return;
    ensureAntispamStoreLoaded();
    if (cache.restrictedUsers.has(userId))
        return;
    (0, antispamDatabase_1.getAntispamDb)()
        .prepare(`INSERT INTO antispam_restricted_users (user_id, reason, restricted_at)
       VALUES (?, 'auto_mute', datetime('now'))
       ON CONFLICT(user_id) DO NOTHING`)
        .run(userId);
    cache.restrictedUsers.add(userId);
}
function pushAntispamLogToStore(entry) {
    ensureAntispamStoreLoaded();
    const row = {
        ...entry,
        id: (0, node_crypto_1.randomUUID)(),
        created_at: new Date().toISOString(),
    };
    (0, antispamDatabase_1.getAntispamDb)()
        .prepare(`INSERT INTO antispam_log (
        id, user_id, username, channel_chat_id, channel_title, reason, text,
        spam_score, action, source, categories_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.user_id, row.username, row.channel_chat_id, row.channel_title, row.reason, row.text, row.spam_score ?? null, row.action ?? null, row.source ?? null, row.categories ? JSON.stringify(row.categories) : null, row.created_at);
    (0, antispamDatabase_1.getAntispamDb)()
        .prepare(`DELETE FROM antispam_log WHERE id NOT IN (
        SELECT id FROM antispam_log ORDER BY created_at DESC LIMIT 500
      )`)
        .run();
    return row;
}
function listAntispamLogFromStore(limit) {
    ensureAntispamStoreLoaded();
    const n = Math.min(Math.max(1, limit), 200);
    const rows = (0, antispamDatabase_1.getAntispamDb)()
        .prepare('SELECT * FROM antispam_log ORDER BY created_at DESC LIMIT ?')
        .all(n);
    return rows.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        username: row.username,
        channel_chat_id: row.channel_chat_id,
        channel_title: row.channel_title,
        reason: row.reason,
        text: row.text,
        spam_score: row.spam_score ?? undefined,
        action: row.action ?? undefined,
        source: row.source ?? undefined,
        categories: row.categories_json
            ? JSON.parse(row.categories_json)
            : undefined,
        created_at: row.created_at,
    }));
}
function purgeAntispamChannelData(chatId) {
    ensureAntispamStoreLoaded();
    const targetAbs = Math.abs(chatId);
    const db = (0, antispamDatabase_1.getAntispamDb)();
    db.prepare('DELETE FROM antispam_stopwords WHERE scope = ? AND ABS(channel_chat_id) = ?').run('channel', targetAbs);
    db.prepare('DELETE FROM antispam_channel_settings WHERE ABS(channel_chat_id) = ?').run(targetAbs);
    db.prepare('DELETE FROM antispam_log WHERE ABS(channel_chat_id) = ?').run(targetAbs);
    for (const key of [...cache.channelStopwords.keys()]) {
        if (Math.abs(key) === targetAbs)
            cache.channelStopwords.delete(key);
    }
    for (const key of [...cache.channelSettings.keys()]) {
        if (Math.abs(key) === targetAbs)
            cache.channelSettings.delete(key);
    }
}
function countAntispamBlocksTodayFromStore() {
    const today = new Date().toISOString().slice(0, 10);
    const row = (0, antispamDatabase_1.getAntispamDb)()
        .prepare("SELECT COUNT(*) AS n FROM antispam_log WHERE created_at >= ?")
        .get(`${today}T00:00:00.000Z`);
    return row.n;
}
//# sourceMappingURL=antispamStore.js.map