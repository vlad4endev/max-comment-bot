"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminPanelState = getAdminPanelState;
exports.getAntispamWords = getAntispamWords;
exports.saveAntispamWords = saveAntispamWords;
exports.getAntispamLog = getAntispamLog;
exports.pushAntispamLog = pushAntispamLog;
exports.getChannelExtras = getChannelExtras;
exports.saveChannelExtras = saveChannelExtras;
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
const STATE_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'admin-panel-state.json');
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
function defaultState() {
    return {
        global_stopwords: [],
        antispam_rules: { ...DEFAULT_RULES },
        antispam_log: [],
        channel_extras: {},
        tg_chains: [],
        vk_chains: [],
        autoposts: [],
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
                global_stopwords: Array.isArray(parsed.global_stopwords) ? parsed.global_stopwords : [],
                antispam_log: Array.isArray(parsed.antispam_log) ? parsed.antispam_log : [],
                channel_extras: typeof parsed.channel_extras === 'object' && parsed.channel_extras !== null
                    ? parsed.channel_extras
                    : {},
                tg_chains: Array.isArray(parsed.tg_chains) ? parsed.tg_chains : [],
                vk_chains: Array.isArray(parsed.vk_chains) ? parsed.vk_chains : [],
                autoposts: Array.isArray(parsed.autoposts) ? parsed.autoposts : [],
            };
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
    const s = await loadState();
    const byChannel = {};
    for (const [k, v] of Object.entries(s.channel_extras)) {
        byChannel[k] = [...(v.stopwords ?? [])];
    }
    return { global: [...s.global_stopwords], byChannel, rules: { ...s.antispam_rules } };
}
async function saveAntispamWords(input) {
    const s = await loadState();
    if (input.global) {
        s.global_stopwords = input.global.map((w) => w.trim().toLowerCase()).filter(Boolean);
    }
    if (input.rules) {
        s.antispam_rules = { ...s.antispam_rules, ...input.rules };
    }
    await persist();
}
async function getAntispamLog(limit) {
    const s = await loadState();
    const n = Math.min(Math.max(1, limit), 200);
    return s.antispam_log.slice(0, n);
}
async function pushAntispamLog(entry) {
    const s = await loadState();
    s.antispam_log.unshift({
        ...entry,
        id: (0, node_crypto_1.randomUUID)(),
        created_at: new Date().toISOString(),
    });
    if (s.antispam_log.length > 500) {
        s.antispam_log.length = 500;
    }
    await persist();
}
async function getChannelExtras(chatId) {
    const s = await loadState();
    const row = s.channel_extras[String(chatId)];
    if (!row) {
        return { ...DEFAULT_CHANNEL_EXTRAS };
    }
    return {
        ...DEFAULT_CHANNEL_EXTRAS,
        ...row,
        stopwords: [...(row.stopwords ?? [])],
    };
}
async function saveChannelExtras(chatId, patch) {
    const s = await loadState();
    const key = String(chatId);
    const current = await getChannelExtras(chatId);
    const next = { ...current, ...patch };
    if (patch.stopwords) {
        next.stopwords = patch.stopwords.map((w) => w.trim().toLowerCase()).filter(Boolean);
    }
    s.channel_extras[key] = next;
    await persist();
    return next;
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
    const row = {
        ...input,
        id: (0, node_crypto_1.randomUUID)(),
        created_at: new Date().toISOString(),
        forwarded_today: 0,
        errors_today: 0,
    };
    s.tg_chains.push(row);
    await persist();
    return row;
}
async function updateTgChain(id, patch) {
    const s = await loadState();
    const idx = s.tg_chains.findIndex((c) => c.id === id);
    if (idx < 0) {
        return null;
    }
    s.tg_chains[idx] = { ...s.tg_chains[idx], ...patch, id };
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
function countAntispamBlocksToday(log) {
    const today = new Date().toISOString().slice(0, 10);
    return log.filter((e) => e.created_at.slice(0, 10) === today).length;
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
    s.antispam_log = s.antispam_log.filter((e) => Math.abs(e.channel_chat_id) !== targetAbs);
    await persist();
}
//# sourceMappingURL=adminPanelState.js.map