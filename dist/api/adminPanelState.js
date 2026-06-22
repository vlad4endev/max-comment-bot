"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminPanelState = getAdminPanelState;
exports.getAntispamWords = getAntispamWords;
exports.getAntispamEngineSync = getAntispamEngineSync;
exports.getAntispamRulesSync = getAntispamRulesSync;
exports.getGlobalStopwordsSync = getGlobalStopwordsSync;
exports.getScoredWordsSync = getScoredWordsSync;
exports.saveScoredWords = saveScoredWords;
exports.getChannelExtrasSync = getChannelExtrasSync;
exports.isAntispamRestrictedUserSync = isAntispamRestrictedUserSync;
exports.saveAntispamEngine = saveAntispamEngine;
exports.restrictAntispamUser = restrictAntispamUser;
exports.saveAntispamWords = saveAntispamWords;
exports.getAntispamLog = getAntispamLog;
exports.pushAntispamLog = pushAntispamLog;
exports.getChannelExtras = getChannelExtras;
exports.saveChannelExtras = saveChannelExtras;
exports.buildTgChainHealth = buildTgChainHealth;
exports.listTgChains = listTgChains;
exports.listTgChainsSync = listTgChainsSync;
exports.ensureAdminPanelStateLoaded = ensureAdminPanelStateLoaded;
exports.createTgChain = createTgChain;
exports.updateTgChain = updateTgChain;
exports.deleteTgChain = deleteTgChain;
exports.listVkChains = listVkChains;
exports.listVkChainsSync = listVkChainsSync;
exports.createVkChain = createVkChain;
exports.updateVkChain = updateVkChain;
exports.deleteVkChain = deleteVkChain;
exports.listAutoposts = listAutoposts;
exports.createAutopost = createAutopost;
exports.deleteAutopost = deleteAutopost;
exports.countAntispamBlocksToday = countAntispamBlocksToday;
exports.purgeChannelFromAdminState = purgeChannelFromAdminState;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const logger_1 = require("../utils/logger");
const postCommentMappingStore_1 = require("../services/postCommentMappingStore");
const antispamStore_1 = require("../services/antispamStore");
const STATE_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'admin-panel-state.json');
const DEFAULT_ENGINE_CONFIG = {
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
const DEFAULT_CHANNEL_EXTRAS = {
    button_text: '💬 Комментарии',
    welcome_message: '',
    notify_admin: true,
    show_reactions: true,
    moderation_mode: false,
    stopwords: [],
    block_links: true,
    flood_protection: true,
    auto_mute: false,
};
function normalizeChatId(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const str = String(value).trim();
    return str === '' ? null : str;
}
function normalizeTgChainDiscussionIds(chains) {
    let needsPersist = false;
    for (const chain of chains) {
        const raw = chain.tg_discussion_chat_id;
        if (typeof raw === 'number') {
            chain.tg_discussion_chat_id = String(raw);
            needsPersist = true;
            continue;
        }
        if (raw !== undefined && raw !== null && raw !== chain.tg_discussion_chat_id) {
            const normalized = normalizeChatId(raw);
            if (normalized !== chain.tg_discussion_chat_id) {
                chain.tg_discussion_chat_id = normalized;
                needsPersist = true;
            }
        }
    }
    return needsPersist;
}
function defaultState() {
    return {
        global_stopwords: [],
        antispam_rules: { ...DEFAULT_RULES },
        antispam_engine: { ...DEFAULT_ENGINE_CONFIG },
        antispam_restricted_users: [],
        antispam_log: [],
        channel_extras: {},
        tg_chains: [],
        vk_chains: [],
        autoposts: [],
    };
}
function parseEngineConfig(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return { ...DEFAULT_ENGINE_CONFIG };
    }
    const o = raw;
    const whitelist = Array.isArray(o.whitelist_user_ids)
        ? o.whitelist_user_ids.filter((id) => typeof id === 'number' && id > 0)
        : DEFAULT_ENGINE_CONFIG.whitelist_user_ids;
    const blacklist = Array.isArray(o.blacklist_user_ids)
        ? o.blacklist_user_ids.filter((id) => typeof id === 'number' && id > 0)
        : [];
    return {
        soft_mode: typeof o.soft_mode === 'boolean' ? o.soft_mode : DEFAULT_ENGINE_CONFIG.soft_mode,
        enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_ENGINE_CONFIG.enabled,
        spam_threshold: typeof o.spam_threshold === 'number' ? o.spam_threshold : DEFAULT_ENGINE_CONFIG.spam_threshold,
        ban_threshold: typeof o.ban_threshold === 'number' ? o.ban_threshold : DEFAULT_ENGINE_CONFIG.ban_threshold,
        captcha_required_score: typeof o.captcha_required_score === 'number'
            ? o.captcha_required_score
            : DEFAULT_ENGINE_CONFIG.captcha_required_score,
        emoji_overuse_limit: typeof o.emoji_overuse_limit === 'number'
            ? o.emoji_overuse_limit
            : DEFAULT_ENGINE_CONFIG.emoji_overuse_limit,
        whitelist_user_ids: whitelist,
        blacklist_user_ids: blacklist,
    };
}
let cache = null;
let loadPromise = null;
async function loadState() {
    if (cache) {
        return cache;
    }
    if (loadPromise) {
        return loadPromise;
    }
    loadPromise = (async () => {
        try {
            const raw = await (0, promises_1.readFile)(STATE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            cache = {
                ...defaultState(),
                ...parsed,
                antispam_rules: { ...DEFAULT_RULES, ...(parsed.antispam_rules ?? {}) },
                antispam_engine: parseEngineConfig(parsed.antispam_engine),
                antispam_restricted_users: Array.isArray(parsed.antispam_restricted_users)
                    ? parsed.antispam_restricted_users.filter((id) => typeof id === 'number' && id > 0)
                    : [],
                global_stopwords: Array.isArray(parsed.global_stopwords) ? parsed.global_stopwords : [],
                antispam_log: Array.isArray(parsed.antispam_log) ? parsed.antispam_log : [],
                channel_extras: typeof parsed.channel_extras === 'object' && parsed.channel_extras !== null
                    ? parsed.channel_extras
                    : {},
                tg_chains: Array.isArray(parsed.tg_chains) ? parsed.tg_chains : [],
                vk_chains: Array.isArray(parsed.vk_chains) ? parsed.vk_chains : [],
                autoposts: Array.isArray(parsed.autoposts) ? parsed.autoposts : [],
            };
            const needsPersist = normalizeTgChainDiscussionIds(cache.tg_chains);
            if (needsPersist) {
                await persist();
            }
        }
        catch (e) {
            const err = e;
            if (err.code !== 'ENOENT') {
                logger_1.logger.warn('adminPanelState: read failed, using defaults', e);
            }
            cache = defaultState();
        }
        return cache;
    })();
    return loadPromise;
}
async function persist() {
    if (!cache) {
        return;
    }
    await (0, promises_1.mkdir)((0, node_path_1.dirname)(STATE_PATH), { recursive: true });
    await (0, promises_1.writeFile)(STATE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}
async function getAdminPanelState() {
    return loadState();
}
async function getAntispamWords() {
    await loadState();
    return (0, antispamStore_1.getAntispamWordsSnapshot)();
}
function getAntispamEngineSync() {
    (0, antispamStore_1.ensureAntispamStoreLoaded)();
    return (0, antispamStore_1.getAntispamEngineSync)();
}
function getAntispamRulesSync() {
    (0, antispamStore_1.ensureAntispamStoreLoaded)();
    return (0, antispamStore_1.getAntispamRulesSync)();
}
function getGlobalStopwordsSync() {
    (0, antispamStore_1.ensureAntispamStoreLoaded)();
    return (0, antispamStore_1.getGlobalStopwordsSync)();
}
function getScoredWordsSync() {
    (0, antispamStore_1.ensureAntispamStoreLoaded)();
    return (0, antispamStore_1.getScoredWordsSync)();
}
async function saveScoredWords(dict) {
    await loadState();
    return (0, antispamStore_1.saveScoredWordsToStore)(dict);
}
function getChannelExtrasSync(chatId) {
    if (!cache) {
        (0, antispamStore_1.ensureAntispamStoreLoaded)();
        const antispam = (0, antispamStore_1.getChannelAntispamSettingsSync)(chatId);
        return {
            ...DEFAULT_CHANNEL_EXTRAS,
            stopwords: antispam.stopwords,
            block_links: antispam.block_links ?? DEFAULT_CHANNEL_EXTRAS.block_links,
            flood_protection: antispam.flood_protection ?? DEFAULT_CHANNEL_EXTRAS.flood_protection,
            auto_mute: antispam.auto_mute,
        };
    }
    const row = cache.channel_extras[String(chatId)];
    const antispam = (0, antispamStore_1.getChannelAntispamSettingsSync)(chatId);
    const base = row ? { ...DEFAULT_CHANNEL_EXTRAS, ...row } : { ...DEFAULT_CHANNEL_EXTRAS };
    return {
        ...base,
        stopwords: antispam.stopwords,
        block_links: antispam.block_links ?? base.block_links,
        flood_protection: antispam.flood_protection ?? base.flood_protection,
        auto_mute: antispam.auto_mute,
    };
}
function isAntispamRestrictedUserSync(userId) {
    (0, antispamStore_1.ensureAntispamStoreLoaded)();
    return (0, antispamStore_1.isAntispamRestrictedUserSync)(userId);
}
async function saveAntispamEngine(patch) {
    await loadState();
    const saved = (0, antispamStore_1.saveAntispamEngineToStore)(patch);
    if (cache) {
        cache.antispam_engine = { ...saved };
    }
    return saved;
}
async function restrictAntispamUser(userId) {
    await loadState();
    (0, antispamStore_1.restrictAntispamUserInStore)(userId);
    if (cache && !cache.antispam_restricted_users.includes(userId)) {
        cache.antispam_restricted_users.push(userId);
    }
}
async function saveAntispamWords(input) {
    await loadState();
    (0, antispamStore_1.saveAntispamWordsToStore)(input);
    if (cache) {
        if (input.global) {
            cache.global_stopwords = input.global.map((w) => w.trim().toLowerCase()).filter(Boolean);
        }
        if (input.rules) {
            cache.antispam_rules = { ...cache.antispam_rules, ...input.rules };
        }
    }
}
async function getAntispamLog(limit) {
    await loadState();
    return (0, antispamStore_1.listAntispamLogFromStore)(limit);
}
async function pushAntispamLog(entry) {
    await loadState();
    const row = (0, antispamStore_1.pushAntispamLogToStore)(entry);
    if (cache) {
        cache.antispam_log.unshift(row);
        if (cache.antispam_log.length > 500) {
            cache.antispam_log.length = 500;
        }
    }
}
async function getChannelExtras(chatId) {
    await loadState();
    return getChannelExtrasSync(chatId);
}
async function saveChannelExtras(chatId, patch) {
    const s = await loadState();
    const key = String(chatId);
    const antispamPatch = {};
    if (patch.stopwords) {
        antispamPatch.stopwords = patch.stopwords;
    }
    if (patch.block_links !== undefined) {
        antispamPatch.block_links = patch.block_links;
    }
    if (patch.flood_protection !== undefined) {
        antispamPatch.flood_protection = patch.flood_protection;
    }
    if (patch.auto_mute !== undefined) {
        antispamPatch.auto_mute = patch.auto_mute;
    }
    if (Object.keys(antispamPatch).length > 0) {
        (0, antispamStore_1.saveChannelAntispamSettings)(chatId, antispamPatch);
    }
    const current = s.channel_extras[key] ?? { ...DEFAULT_CHANNEL_EXTRAS };
    const { stopwords: _sw, block_links: _bl, flood_protection: _fp, auto_mute: _am, ...uiPatch } = patch;
    const nextUi = { ...DEFAULT_CHANNEL_EXTRAS, ...current, ...uiPatch };
    s.channel_extras[key] = nextUi;
    await persist();
    return getChannelExtrasSync(chatId);
}
function buildTgChainHealth(chain, lastForwardedAt) {
    const sinceTooFresh = chain.forward_posts &&
        chain.forwarded_today === 0 &&
        chain.forward_posts_since?.trim() &&
        Date.now() - new Date(chain.forward_posts_since).getTime() < 3600_000
        ? 'forward_posts_since выставлен менее часа назад — посты до этого времени пропускаются'
        : null;
    return {
        last_forwarded_at: lastForwardedAt,
        errors_today: chain.errors_today ?? 0,
        since_too_fresh: sinceTooFresh,
    };
}
async function listTgChains() {
    const s = await loadState();
    return [...s.tg_chains];
}
/** In-memory snapshot for hot paths (poller, webhook); call {@link ensureAdminPanelStateLoaded} at startup. */
function listTgChainsSync() {
    if (!cache) {
        return [];
    }
    return [...cache.tg_chains];
}
async function ensureAdminPanelStateLoaded() {
    await loadState();
}
async function createTgChain(input) {
    const s = await loadState();
    const nowIso = new Date().toISOString();
    const normalizedInput = {
        ...input,
        tg_discussion_chat_id: input.tg_discussion_chat_id !== undefined
            ? normalizeChatId(input.tg_discussion_chat_id)
            : input.tg_discussion_chat_id,
    };
    const previousChains = s.tg_chains.filter((c) => {
        if (c.max_chat_id !== normalizedInput.max_chat_id) {
            return false;
        }
        const nextTgId = normalizedInput.tg_channel_id?.trim();
        const prevTgId = c.tg_channel_id?.trim();
        if (nextTgId && prevTgId) {
            return nextTgId === prevTgId;
        }
        const nextUname = normalizedInput.tg_username.trim().replace(/^@/, '').toLowerCase();
        const prevUname = c.tg_username.trim().replace(/^@/, '').toLowerCase();
        return nextUname !== '' && nextUname === prevUname;
    });
    let inheritedForwardSince = normalizedInput.forward_posts_since?.trim() || null;
    for (const prev of previousChains) {
        const since = prev.forward_posts_since?.trim();
        if (since && (!inheritedForwardSince || since < inheritedForwardSince)) {
            inheritedForwardSince = since;
        }
    }
    const row = {
        ...normalizedInput,
        id: (0, node_crypto_1.randomUUID)(),
        created_at: nowIso,
        forward_posts_since: normalizedInput.forward_posts !== false
            ? inheritedForwardSince || nowIso
            : (normalizedInput.forward_posts_since ?? null),
        forwarded_today: 0,
        errors_today: 0,
    };
    s.tg_chains.push(row);
    const oldChains = s.tg_chains.filter((c) => c.tg_channel_id === row.tg_channel_id &&
        String(c.max_chat_id) === String(row.max_chat_id) &&
        c.id !== row.id);
    if (oldChains.length > 0) {
        let totalTransferred = 0;
        for (const old of oldChains) {
            totalTransferred += (0, postCommentMappingStore_1.transferPostCommentMappingsChainId)(old.id, row.id);
        }
        const earliestSince = oldChains
            .map((c) => c.forward_posts_since)
            .filter(Boolean)
            .sort()[0];
        if (earliestSince && !row.forward_posts_since) {
            row.forward_posts_since = earliestSince;
        }
        logger_1.logger.info('[createTgChain] inherited from old chains', {
            newId: row.id,
            oldIds: oldChains.map((c) => c.id),
            transferred: totalTransferred,
            inheritedSince: row.forward_posts_since,
        });
    }
    else {
        for (const prev of previousChains) {
            const transferred = (0, postCommentMappingStore_1.transferPostCommentMappingsChainId)(prev.id, row.id);
            if (transferred > 0) {
                logger_1.logger.info('[tgChains] transferred mappings from old chain', {
                    oldChainId: prev.id,
                    newChainId: row.id,
                    transferred,
                });
            }
        }
    }
    await persist();
    return row;
}
async function updateTgChain(id, patch) {
    const s = await loadState();
    const idx = s.tg_chains.findIndex((c) => c.id === id);
    if (idx < 0) {
        return null;
    }
    const prev = s.tg_chains[idx];
    const nextPatch = { ...patch };
    if (patch.tg_discussion_chat_id !== undefined) {
        nextPatch.tg_discussion_chat_id = normalizeChatId(patch.tg_discussion_chat_id);
    }
    if (patch.forward_posts === true && !prev.forward_posts) {
        // Сбрасываем since ТОЛЬКО если его не было совсем
        if (!prev.forward_posts_since?.trim() && patch.forward_posts_since === undefined) {
            nextPatch.forward_posts_since = new Date().toISOString();
        }
    }
    s.tg_chains[idx] = { ...prev, ...nextPatch, id };
    await persist();
    return s.tg_chains[idx];
}
async function deleteTgChain(id) {
    const s = await loadState();
    const before = s.tg_chains.length;
    s.tg_chains = s.tg_chains.filter((c) => c.id !== id);
    if (s.tg_chains.length === before) {
        return false;
    }
    await persist();
    return true;
}
// ── VK chains ────────────────────────────────────────────────────────────────
async function listVkChains() {
    const s = await loadState();
    return [...s.vk_chains];
}
/** Synchronous snapshot for hot paths — call {@link ensureAdminPanelStateLoaded} at startup. */
function listVkChainsSync() {
    if (!cache) {
        return [];
    }
    return [...cache.vk_chains];
}
async function createVkChain(input) {
    const s = await loadState();
    const row = {
        ...input,
        id: (0, node_crypto_1.randomUUID)(),
        created_at: new Date().toISOString(),
        forwarded_today: 0,
        errors_today: 0,
    };
    s.vk_chains.push(row);
    await persist();
    return row;
}
async function updateVkChain(id, patch) {
    const s = await loadState();
    const idx = s.vk_chains.findIndex((c) => c.id === id);
    if (idx < 0) {
        return null;
    }
    s.vk_chains[idx] = { ...s.vk_chains[idx], ...patch, id };
    await persist();
    return s.vk_chains[idx];
}
async function deleteVkChain(id) {
    const s = await loadState();
    const before = s.vk_chains.length;
    s.vk_chains = s.vk_chains.filter((c) => c.id !== id);
    if (s.vk_chains.length === before) {
        return false;
    }
    await persist();
    return true;
}
async function listAutoposts() {
    const s = await loadState();
    return [...s.autoposts].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
}
async function createAutopost(input) {
    const s = await loadState();
    const row = {
        ...input,
        id: (0, node_crypto_1.randomUUID)(),
        status: 'scheduled',
        created_at: new Date().toISOString(),
    };
    s.autoposts.push(row);
    await persist();
    return row;
}
async function deleteAutopost(id) {
    const s = await loadState();
    const before = s.autoposts.length;
    s.autoposts = s.autoposts.filter((p) => p.id !== id);
    if (s.autoposts.length === before) {
        return false;
    }
    await persist();
    return true;
}
function countAntispamBlocksToday(_log) {
    (0, antispamStore_1.ensureAntispamStoreLoaded)();
    return (0, antispamStore_1.countAntispamBlocksTodayFromStore)();
}
/** Удаляет все настройки админки, привязанные к каналу. */
async function purgeChannelFromAdminState(chatId) {
    const s = await loadState();
    const targetAbs = Math.abs(chatId);
    for (const key of Object.keys(s.channel_extras)) {
        const id = Number.parseInt(key, 10);
        if (Number.isInteger(id) && Math.abs(id) === targetAbs) {
            delete s.channel_extras[key];
        }
    }
    s.tg_chains = s.tg_chains.filter((c) => Math.abs(c.max_chat_id) !== targetAbs);
    s.vk_chains = s.vk_chains.filter((c) => Math.abs(c.max_chat_id) !== targetAbs);
    s.autoposts = s.autoposts.filter((p) => Math.abs(p.chat_id) !== targetAbs);
    (0, antispamStore_1.purgeAntispamChannelData)(chatId);
    await persist();
}
//# sourceMappingURL=adminPanelState.js.map