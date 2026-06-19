"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_COMMENT_TG_PREFIX = exports.MAX_REPLY_TG_PREFIX = exports.MAX_BOOKED_IN_TG_CALLBACK = exports.TG_BOOKED_IN_MAX_MARKER = exports.MAX_ANSWERED_IN_TELEGRAM_LABEL = exports.LEGACY_ANSWERED_IN_MAX_MARKER = exports.MAX_ANSWERED_IN_MAX_MARKER = void 0;
exports.normalizeCommentSyncMatchMode = normalizeCommentSyncMatchMode;
exports.normalizeCommentSyncKeywords = normalizeCommentSyncKeywords;
exports.parseCommentSyncKeyword = parseCommentSyncKeyword;
exports.matchesCommentSyncPattern = matchesCommentSyncPattern;
exports.matchesCommentSyncKeyword = matchesCommentSyncKeyword;
exports.isTgCommentFromAdmin = isTgCommentFromAdmin;
exports.resolveThreadRootMessage = resolveThreadRootMessage;
exports.resolveDiscussionThreadRootMsgId = resolveDiscussionThreadRootMsgId;
exports.resolveChannelMsgIdFromThreadRoot = resolveChannelMsgIdFromThreadRoot;
exports.resolveTgCommentAuthor = resolveTgCommentAuthor;
exports.isTelegramOriginComment = isTelegramOriginComment;
exports.formatMaxBookedInTgButtonLabel = formatMaxBookedInTgButtonLabel;
exports.isTelegramCommentMarkedAnsweredInMax = isTelegramCommentMarkedAnsweredInMax;
exports.isMaxAdminReplyInTelegram = isMaxAdminReplyInTelegram;
exports.isMaxCommentInTelegram = isMaxCommentInTelegram;
exports.formatMaxCommentForTelegram = formatMaxCommentForTelegram;
exports.shouldSyncTgCommentToMax = shouldSyncTgCommentToMax;
const integrationPlatformClient_1 = require("../services/integrationPlatformClient");
const COMMENT_SYNC_MATCH_MODES = [
    'contains',
    'equals',
    'word',
    'starts_with',
    'ends_with',
];
const KEYWORD_PREFIX_MODES = {
    '~': 'contains',
    '=': 'equals',
    '#': 'word',
    '^': 'starts_with',
    $: 'ends_with',
};
function normalizeCommentSyncMatchMode(mode) {
    if (mode && COMMENT_SYNC_MATCH_MODES.includes(mode)) {
        return mode;
    }
    return 'contains';
}
function normalizeCommentSyncKeywords(words) {
    return (words ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Разбирает тег: префикс `= ^ $ # ~` переопределяет режим для одного слова. */
function parseCommentSyncKeyword(raw, defaultMode) {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) {
        return null;
    }
    const prefix = trimmed[0];
    const modeFromPrefix = prefix ? KEYWORD_PREFIX_MODES[prefix] : undefined;
    if (modeFromPrefix && trimmed.length > 1) {
        const pattern = trimmed.slice(1).trim();
        return pattern ? { pattern, mode: modeFromPrefix } : null;
    }
    return { pattern: trimmed, mode: defaultMode };
}
function matchesCommentSyncPattern(text, pattern, mode) {
    const hay = text.trim().toLowerCase();
    const needle = pattern.trim().toLowerCase();
    if (!hay || !needle) {
        return false;
    }
    switch (mode) {
        case 'equals':
            return hay === needle;
        case 'starts_with':
            return hay.startsWith(needle);
        case 'ends_with':
            return hay.endsWith(needle);
        case 'word': {
            if (hay === needle) {
                return true;
            }
            const re = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}(?:[^\\p{L}\\p{N}_]|$)`, 'iu');
            return re.test(hay);
        }
        case 'contains':
        default:
            return hay.includes(needle);
    }
}
function matchesCommentSyncKeyword(text, keywords, defaultMode = 'contains') {
    if (keywords.length === 0) {
        return false;
    }
    const mode = normalizeCommentSyncMatchMode(defaultMode);
    return keywords.some((kw) => {
        const parsed = parseCommentSyncKeyword(kw, mode);
        return parsed ? matchesCommentSyncPattern(text, parsed.pattern, parsed.mode) : false;
    });
}
const adminUserCache = new Map();
const ADMIN_CACHE_TTL_MS = 5 * 60_000;
async function getTelegramAdminUserIds(token, chatId) {
    const key = `${chatId}:${token.slice(-8)}`;
    const cached = adminUserCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.userIds;
    }
    const admins = await (0, integrationPlatformClient_1.listTelegramChatAdministrators)(token, chatId);
    const userIds = new Set(admins.map((a) => a.userId));
    adminUserCache.set(key, { userIds, expiresAt: Date.now() + ADMIN_CACHE_TTL_MS });
    return userIds;
}
function channelChatNumericId(chain) {
    const raw = chain.tg_channel_id?.trim();
    if (!raw || !/^-?\d+$/.test(raw)) {
        return null;
    }
    return Number(raw);
}
function isChannelSignedComment(message, chain) {
    const channelId = channelChatNumericId(chain);
    if (channelId == null) {
        return false;
    }
    return message.sender_chat?.id === channelId;
}
async function isTgCommentFromAdmin(message, token, chain, discussionChatId) {
    if (isChannelSignedComment(message, chain)) {
        return true;
    }
    const userId = message.from?.id;
    if (typeof userId !== 'number' || userId <= 0) {
        return false;
    }
    const discussionAdmins = await getTelegramAdminUserIds(token, String(discussionChatId));
    if (discussionAdmins.has(userId)) {
        return true;
    }
    const channelKey = chain.tg_channel_id?.trim();
    if (channelKey) {
        const channelAdmins = await getTelegramAdminUserIds(token, channelKey);
        if (channelAdmins.has(userId)) {
            return true;
        }
    }
    return false;
}
/** Поднимается по цепочке reply_to_message к корню треда (авто-репост канала). */
function resolveThreadRootMessage(message) {
    let reply = message.reply_to_message;
    if (!reply) {
        return null;
    }
    let depth = 0;
    while (reply.reply_to_message && depth < 24) {
        reply = reply.reply_to_message;
        depth += 1;
    }
    return reply;
}
function resolveDiscussionThreadRootMsgId(message) {
    const root = resolveThreadRootMessage(message);
    return typeof root?.message_id === 'number' ? root.message_id : null;
}
/** ID поста в TG-канале из авто-репоста в discussion group. */
function resolveChannelMsgIdFromThreadRoot(root) {
    const fromOrigin = root.forward_origin?.message_id;
    if (typeof fromOrigin === 'number' && fromOrigin > 0) {
        return fromOrigin;
    }
    const fromForward = root.forward_from_message_id;
    if (typeof fromForward === 'number' && fromForward > 0) {
        return fromForward;
    }
    return null;
}
function resolveTgCommentAuthor(message, chain, discussionChatId) {
    const from = message.from;
    const fromId = typeof from?.id === 'number' && from.id > 0 ? from.id : 0;
    const fullName = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim();
    const rawUsername = from?.username?.trim().replace(/^@/, '');
    const atUsername = rawUsername ? `@${rawUsername}` : '';
    if (fullName) {
        return { userId: fromId || 1, username: fullName };
    }
    if (atUsername) {
        return { userId: fromId || 1, username: atUsername };
    }
    const senderChat = message.sender_chat;
    if (senderChat) {
        const channelId = channelChatNumericId(chain);
        if (channelId != null && senderChat.id === channelId) {
            const channelLabel = senderChat.title?.trim() ||
                (senderChat.username ? `@${senderChat.username.replace(/^@/, '')}` : '') ||
                'Канал';
            return { userId: fromId || 1, username: channelLabel };
        }
        if (senderChat.id !== discussionChatId) {
            const chatLabel = senderChat.title?.trim() ||
                (senderChat.username ? `@${senderChat.username.replace(/^@/, '')}` : '');
            if (chatLabel) {
                return { userId: fromId || 1, username: chatLabel };
            }
        }
    }
    return { userId: fromId || 1, username: 'Аноним' };
}
/** Комментарий из TG-треда (не создан в MAX miniapp). */
function isTelegramOriginComment(comment) {
    return comment.source !== 'max';
}
/** Маркер на исходном комментарии в TG после ответа админа в MAX (без нового сообщения в треде). */
exports.MAX_ANSWERED_IN_MAX_MARKER = '🔒 Забронирован в MAX';
/** Старый маркер — учитываем при проверке уже помеченных сообщений. */
exports.LEGACY_ANSWERED_IN_MAX_MARKER = '✅ Отвечено в MAX';
/** Подпись в miniapp: на комментарий ответили в Telegram. */
exports.MAX_ANSWERED_IN_TELEGRAM_LABEL = '✅ Отвечено в Telegram';
/** Служебное сообщение в TG-треде: пост забронирован первым комментарием из MAX. */
exports.TG_BOOKED_IN_MAX_MARKER = '🔒 Забронировано в МАКСе';
/** MAX inline callback для неактивной кнопки «Забронировано в ТГ». */
exports.MAX_BOOKED_IN_TG_CALLBACK = 'max:booked_tg';
function formatMaxBookedInTgButtonLabel(commentCount) {
    const n = Math.max(0, commentCount);
    return `🔒 Забронировано в ТГ (${n})`;
}
function isTelegramCommentMarkedAnsweredInMax(text) {
    return (text.includes(exports.MAX_ANSWERED_IN_MAX_MARKER) ||
        text.includes(exports.LEGACY_ANSWERED_IN_MAX_MARKER));
}
/** Префикс ответа админа из MAX в TG-треде (не синхронизировать обратно в miniapp). */
exports.MAX_REPLY_TG_PREFIX = 'MAX ответ:';
/** Префикс пользовательского комментария из MAX в TG-треде. */
exports.MAX_COMMENT_TG_PREFIX = 'MAX ·';
/** Старый префикс — игнорируем при обратной синхронизации. */
const LEGACY_ADMIN_REPLY_TG_PREFIX = '👤 Администратор:';
function isMaxAdminReplyInTelegram(text) {
    const trimmed = text.trim();
    return (trimmed.startsWith(exports.MAX_REPLY_TG_PREFIX) || trimmed.startsWith(LEGACY_ADMIN_REPLY_TG_PREFIX));
}
function isMaxCommentInTelegram(text) {
    return text.trim().startsWith(exports.MAX_COMMENT_TG_PREFIX);
}
/** Текст сообщения в TG-треде: имя автора и комментарий из MAX miniapp. */
function formatMaxCommentForTelegram(username, text) {
    const name = username.trim() || 'Пользователь';
    const body = text.trim();
    if (body) {
        return `${exports.MAX_COMMENT_TG_PREFIX} ${name}: ${body}`;
    }
    return `${exports.MAX_COMMENT_TG_PREFIX} ${name}`;
}
async function shouldSyncTgCommentToMax(params) {
    if (params.commentsBookedBy === 'max') {
        return false;
    }
    const text = (params.message.text || params.message.caption || '').trim();
    if (!text ||
        isMaxAdminReplyInTelegram(text) ||
        isMaxCommentInTelegram(text) ||
        isTelegramCommentMarkedAnsweredInMax(text) ||
        text.includes(exports.TG_BOOKED_IN_MAX_MARKER)) {
        return false;
    }
    const keywords = normalizeCommentSyncKeywords(params.chain.comment_sync_keywords);
    const isAdmin = await isTgCommentFromAdmin(params.message, params.token, params.chain, params.discussionChatId);
    if (isAdmin) {
        const directReplyId = params.message.reply_to_message?.message_id;
        if (directReplyId == null) {
            return false;
        }
        if (directReplyId !== params.threadRootMsgId) {
            return true;
        }
        if (params.postCommentCount === 0) {
            return true;
        }
        return false;
    }
    const matchMode = normalizeCommentSyncMatchMode(params.chain.comment_sync_match_mode);
    return matchesCommentSyncKeyword(text, keywords, matchMode);
}
//# sourceMappingURL=commentSyncFilter.js.map