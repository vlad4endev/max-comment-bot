"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveMessageChatId = resolveMessageChatId;
exports.isLikelyChannelPost = isLikelyChannelPost;
exports.isUserChannelAdmin = isUserChannelAdmin;
exports.tryAttachCommentsToChannelPost = tryAttachCommentsToChannelPost;
const max_bot_api_1 = require("@maxhub/max-bot-api");
const uuid_1 = require("uuid");
const logger_1 = require("../utils/logger");
const postStore_1 = require("./postStore");
/**
 * Resolves chat id for a message (channel/group/dialog). Falls back to sender id for 1:1.
 */
function resolveMessageChatId(message, fallbackUserId) {
    const rid = message.recipient.chat_id;
    if (typeof rid === 'number' && Number.isFinite(rid)) {
        return rid;
    }
    return fallbackUserId;
}
/**
 * Channel posts usually have `recipient.chat_type === 'channel'`; otherwise confirm via getChat.
 */
async function isLikelyChannelPost(bot, message) {
    if (message.recipient.chat_type === 'channel') {
        return true;
    }
    const rid = message.recipient.chat_id;
    if (typeof rid !== 'number' || !Number.isFinite(rid)) {
        return false;
    }
    try {
        const chat = await bot.api.getChat(rid);
        return chat.type === 'channel';
    }
    catch (err) {
        logger_1.logger.debug('isLikelyChannelPost: getChat failed', { rid, err });
        return false;
    }
}
function firstImageUrlFromMessage(message) {
    const list = message.body.attachments;
    if (!list || list.length === 0) {
        return undefined;
    }
    for (const att of list) {
        if (att.type === 'image' && typeof att.payload.url === 'string' && att.payload.url.length > 0) {
            return att.payload.url;
        }
    }
    return undefined;
}
/** True if the user is a non-bot admin or owner of the channel. */
async function isUserChannelAdmin(bot, channelChatId, userId) {
    try {
        const { members } = await bot.api.getChatMembers(channelChatId, { user_ids: [userId] });
        const m = members[0];
        if (!m) {
            return false;
        }
        return !m.is_bot && (m.is_admin || m.is_owner);
    }
    catch (err) {
        logger_1.logger.warn('isUserChannelAdmin: API error', { channelChatId, userId, err });
        return false;
    }
}
/**
 * Creates a {@link Post}, saves it, and attaches the Mini App inline button (edit or reply fallback).
 *
 * @param options.skipAuthorAdminCheck — when the invoker was already verified (e.g. `/addbutton`).
 * @param options.channelChatIdOverride — e.g. poller passes registered channel id when recipient metadata is thin.
 */
async function tryAttachCommentsToChannelPost(bot, message, options = {}) {
    const user = message.sender ?? undefined;
    const override = options.channelChatIdOverride;
    const overrideOk = typeof override === 'number' && Number.isFinite(override) ? override : undefined;
    const rid = message.recipient?.chat_id;
    const recipientChatId = typeof rid === 'number' && Number.isFinite(rid) ? rid : undefined;
    const chatId = overrideOk ?? recipientChatId ?? null;
    if (chatId === null) {
        return { ok: false, reason: 'no_chat_id' };
    }
    const botUid = options.botUserId ?? bot.botInfo?.user_id;
    if (user && botUid !== undefined && user.user_id === botUid) {
        return { ok: false, reason: 'skip_bot' };
    }
    if (!(0, postStore_1.isMiniAppOpenUrlConfigured)()) {
        logger_1.logger.debug('tryAttachCommentsToChannelPost: BOT_NICKNAME / MINI_APP_URL not set for Mini App links');
        return { ok: false, reason: 'no_miniapp' };
    }
    const mid = message.body?.mid;
    if (typeof mid !== 'string' || mid.trim() === '') {
        return { ok: false, reason: 'no_mid' };
    }
    if (postStore_1.postStore.findPostByChannelMessage(chatId, mid)) {
        return { ok: false, reason: 'already_exists' };
    }
    const needsAdminCheck = Boolean(user) && !options.skipAuthorAdminCheck;
    if (needsAdminCheck && user) {
        const adminOk = await isUserChannelAdmin(bot, chatId, user.user_id);
        if (!adminOk) {
            logger_1.logger.debug('tryAttachCommentsToChannelPost: skip (sender not channel admin)', {
                chatId,
                userId: user.user_id,
            });
            return { ok: false, reason: 'not_admin' };
        }
    }
    logger_1.logger.info('tryAttachCommentsToChannelPost: attaching', {
        chatId,
        senderId: user?.user_id,
        messageMid: mid,
        recipientChatType: message.recipient.chat_type,
    });
    const postId = (0, uuid_1.v4)();
    const text = message.body.text?.trim() ?? '';
    const photoUrl = firstImageUrlFromMessage(message);
    const post = {
        post_id: postId,
        chat_id: chatId,
        message_mid: mid,
        sender_name: user?.name ?? 'Канал',
        text,
        photo_url: photoUrl,
        comment_count: 0,
        timestamp: new Date().toISOString(),
    };
    postStore_1.postStore.savePost(post);
    const openUrl = (0, postStore_1.buildMiniAppUrl)(postId, chatId);
    const kb = max_bot_api_1.Keyboard.inlineKeyboard([[max_bot_api_1.Keyboard.button.link('💬 Комментарии (0)', openUrl)]]);
    const editText = text === '' ? '\u00a0' : text;
    await (0, postStore_1.attachCommentButtonToChannelPost)(bot, post, editText, kb);
    return { ok: true };
}
//# sourceMappingURL=channelPostActions.js.map