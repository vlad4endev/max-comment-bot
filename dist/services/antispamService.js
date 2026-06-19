"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateComment = evaluateComment;
const detectSpam_1 = require("../antispam/detectSpam");
const adminPanelState_1 = require("../api/adminPanelState");
const channelRegistry_1 = require("./channelRegistry");
const logger_1 = require("../utils/logger");
const FLOOD_WINDOW_MS = 30_000;
const FLOOD_MAX_COMMENTS = 5;
const floodBuckets = new Map();
function floodKey(userId, channelChatId) {
    return `${channelChatId}:${userId}`;
}
function checkFlood(userId, channelChatId) {
    const key = floodKey(userId, channelChatId);
    const now = Date.now();
    const prev = (floodBuckets.get(key) ?? []).filter((ts) => now - ts < FLOOD_WINDOW_MS);
    prev.push(now);
    floodBuckets.set(key, prev);
    if (floodBuckets.size > 10_000) {
        const oldest = floodBuckets.keys().next().value;
        if (oldest) {
            floodBuckets.delete(oldest);
        }
    }
    return prev.length > FLOOD_MAX_COMMENTS;
}
function buildDetectConfig(channelChatId) {
    const engine = (0, adminPanelState_1.getAntispamEngineSync)();
    const rules = (0, adminPanelState_1.getAntispamRulesSync)();
    const extras = (0, adminPanelState_1.getChannelExtrasSync)(channelChatId);
    const globalWords = (0, adminPanelState_1.getGlobalStopwordsSync)();
    const channelWords = extras.stopwords ?? [];
    const extraStopWords = [...new Set([...globalWords, ...channelWords])];
    const blockLinks = extras.block_links !== false && rules.block_links !== false;
    return {
        softMode: engine.soft_mode,
        enabled: engine.enabled,
        spamThreshold: engine.spam_threshold,
        banThreshold: engine.ban_threshold,
        captchaRequiredScore: engine.captcha_required_score,
        emojiOveruseLimit: engine.emoji_overuse_limit,
        pureEmojiMaxTextLength: 5,
        minDistinctCategories: 2,
        blockLinks,
        emojiSpam: rules.emoji_spam,
        extraStopWordWeight: 90,
        extraStopWords,
    };
}
function mapActionToOutcome(action, softMode) {
    if (softMode) {
        return { outcome: 'soft_log', allowed: true };
    }
    switch (action) {
        case 'leave':
            return { outcome: 'allow', allowed: true };
        case 'captcha':
            return {
                outcome: 'block',
                allowed: false,
                userMessage: 'Сообщение выглядит подозрительно. Переформулируйте без ссылок и рекламы.',
            };
        case 'delete':
            return {
                outcome: 'block',
                allowed: false,
                userMessage: 'Комментарий не прошёл проверку на спам.',
            };
        case 'delete_and_ban':
            return {
                outcome: 'ban',
                allowed: false,
                userMessage: 'Комментирование ограничено из-за нарушений.',
            };
        default:
            return { outcome: 'allow', allowed: true };
    }
}
function formatReason(action, categories, spamScore) {
    const cat = categories.length ? categories.join(',') : '—';
    return `${action} (score=${spamScore}, cat=${cat})`;
}
function logBlock(input, action, spamScore, categories, reason) {
    const channelTitle = channelRegistry_1.channelRegistry.getChannel(input.channelChatId)?.title ?? null;
    void (0, adminPanelState_1.pushAntispamLog)({
        user_id: input.userId,
        username: input.username,
        channel_chat_id: input.channelChatId,
        channel_title: channelTitle,
        reason,
        text: input.text.slice(0, 500),
        spam_score: spamScore,
        action,
        source: input.source,
        categories,
    }).catch((err) => {
        logger_1.logger.warn('[antispam] pushAntispamLog failed', { err });
    });
}
/**
 * Единая точка антиспама для MAX, Telegram и VK.
 * Порт логики antispam_v16 из n8n.
 */
function evaluateComment(input) {
    const engine = (0, adminPanelState_1.getAntispamEngineSync)();
    const extras = (0, adminPanelState_1.getChannelExtrasSync)(input.channelChatId);
    const { userId, channelChatId, isChannelAdmin, text } = input;
    if (!engine.enabled) {
        return {
            allowed: true,
            outcome: 'allow',
            action: 'leave',
            spamScore: 0,
            categories: [],
            reason: 'disabled',
        };
    }
    if (isChannelAdmin) {
        return {
            allowed: true,
            outcome: 'allow',
            action: 'whitelist',
            spamScore: 0,
            categories: [],
            reason: 'channel_admin',
        };
    }
    if (engine.whitelist_user_ids.includes(userId)) {
        return {
            allowed: true,
            outcome: 'allow',
            action: 'whitelist',
            spamScore: 0,
            categories: [],
            reason: 'whitelist',
        };
    }
    if (engine.blacklist_user_ids.includes(userId) || (0, adminPanelState_1.isAntispamRestrictedUserSync)(userId)) {
        const reason = (0, adminPanelState_1.isAntispamRestrictedUserSync)(userId) ? 'restricted' : 'blacklist';
        logBlock(input, reason, 999, ['blacklist'], reason);
        return {
            allowed: engine.soft_mode,
            outcome: engine.soft_mode ? 'soft_log' : 'ban',
            action: reason,
            spamScore: 999,
            categories: ['blacklist'],
            reason,
            userMessage: 'Комментирование ограничено.',
        };
    }
    const trimmed = text.trim();
    if (!trimmed) {
        return {
            allowed: true,
            outcome: 'allow',
            action: 'leave',
            spamScore: 0,
            categories: [],
            reason: 'empty_text',
        };
    }
    if (extras.flood_protection && checkFlood(userId, channelChatId)) {
        logBlock(input, 'flood', 80, ['flood'], 'flood');
        return {
            allowed: engine.soft_mode,
            outcome: engine.soft_mode ? 'soft_log' : 'block',
            action: 'delete',
            spamScore: 80,
            categories: ['flood'],
            reason: 'flood',
            userMessage: 'Слишком много комментариев. Подождите немного.',
        };
    }
    const det = (0, detectSpam_1.detectSpam)(trimmed, buildDetectConfig(channelChatId));
    const mapped = mapActionToOutcome(det.action, engine.soft_mode);
    if (det.action !== 'leave' || engine.soft_mode) {
        logBlock(input, det.action, det.spamScore, det.categories, formatReason(det.action, det.categories, det.spamScore));
    }
    if (!mapped.allowed && det.action === 'delete_and_ban' && extras.auto_mute) {
        void (0, adminPanelState_1.restrictAntispamUser)(userId).catch((err) => {
            logger_1.logger.warn('[antispam] auto_mute failed', { userId, err });
        });
    }
    return {
        allowed: mapped.allowed,
        outcome: mapped.outcome,
        action: det.action,
        spamScore: det.spamScore,
        categories: det.categories,
        reason: formatReason(det.action, det.categories, det.spamScore),
        userMessage: mapped.userMessage,
    };
}
//# sourceMappingURL=antispamService.js.map