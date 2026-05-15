"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.postStore = exports.PostStore = void 0;
exports.mediaAttachmentRequestsFromMessageBody = mediaAttachmentRequestsFromMessageBody;
exports.attachCommentButtonToChannelPost = attachCommentButtonToChannelPost;
exports.isMiniAppOpenUrlConfigured = isMiniAppOpenUrlConfigured;
exports.buildMiniAppUrl = buildMiniAppUrl;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const max_bot_api_1 = require("@maxhub/max-bot-api");
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const DEFAULT_POSTS_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'posts.json');
function isPost(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const o = value;
    return (typeof o.post_id === 'string' &&
        typeof o.chat_id === 'number' &&
        Number.isInteger(o.chat_id) &&
        typeof o.message_mid === 'string' &&
        (o.comments_ui_message_mid === undefined || typeof o.comments_ui_message_mid === 'string') &&
        (o.sender_name === undefined || typeof o.sender_name === 'string') &&
        typeof o.text === 'string' &&
        (o.photo_url === undefined || typeof o.photo_url === 'string') &&
        (o.media_attachments === undefined ||
            (Array.isArray(o.media_attachments) &&
                o.media_attachments.every((x) => typeof x === 'object' &&
                    x !== null &&
                    'type' in x &&
                    typeof x.type === 'string'))) &&
        typeof o.comment_count === 'number' &&
        Number.isInteger(o.comment_count) &&
        o.comment_count >= 0 &&
        typeof o.timestamp === 'string');
}
/**
 * JSON-backed map of posts by `post_id`, with async persistence under `data/posts.json`.
 */
class PostStore {
    byId = new Map();
    filePath;
    persistChain = Promise.resolve();
    constructor(filePath = DEFAULT_POSTS_PATH) {
        this.filePath = filePath;
    }
    /**
     * Loads posts from disk into memory (replaces cache).
     */
    async loadFromDisk() {
        try {
            const raw = await (0, promises_1.readFile)(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || !('posts' in parsed)) {
                logger_1.logger.warn('postStore: invalid posts.json shape, starting empty');
                this.byId.clear();
                return;
            }
            const list = parsed.posts;
            if (!Array.isArray(list)) {
                this.byId.clear();
                return;
            }
            this.byId.clear();
            for (const item of list) {
                if (isPost(item)) {
                    this.byId.set(item.post_id, item);
                }
            }
            logger_1.logger.info(`postStore: loaded ${this.byId.size} post(s)`);
        }
        catch (e) {
            const err = e;
            if (err.code === 'ENOENT') {
                logger_1.logger.debug('postStore: posts.json missing, empty store');
                return;
            }
            logger_1.logger.error('postStore: failed to read posts.json', e);
        }
    }
    /**
     * Persists or replaces a post in memory and queues disk write.
     */
    savePost(post) {
        this.byId.set(post.post_id, post);
        this.queuePersist();
    }
    /**
     * Returns a post by id or `null`.
     */
    getPost(postId) {
        return this.byId.get(postId) ?? null;
    }
    /**
     * All posts in a channel (for /status counts).
     */
    getPostsByChatId(chatId) {
        return [...this.byId.values()].filter((p) => p.chat_id === chatId);
    }
    /**
     * Whether we already track this channel message (same {@link Post.message_mid}).
     */
    findPostByChannelMessage(chatId, messageMid) {
        for (const p of this.byId.values()) {
            if (p.chat_id === chatId && p.message_mid === messageMid) {
                return p;
            }
        }
        return null;
    }
    /**
     * Increments {@link Post.comment_count} and persists. Returns new count or `null` if unknown post.
     */
    incrementCommentCount(postId) {
        const p = this.byId.get(postId);
        if (!p) {
            return null;
        }
        const next = { ...p, comment_count: p.comment_count + 1 };
        this.byId.set(postId, next);
        this.queuePersist();
        return next.comment_count;
    }
    /**
     * Decrements {@link Post.comment_count} (floored at 0). Returns new count or `null` if unknown post.
     */
    decrementCommentCount(postId) {
        const p = this.byId.get(postId);
        if (!p) {
            return null;
        }
        const next = { ...p, comment_count: Math.max(0, p.comment_count - 1) };
        this.byId.set(postId, next);
        this.queuePersist();
        return next.comment_count;
    }
    /**
     * Удаляет все посты канала, возвращает затронутые post_id (для чистки комментариев).
     */
    removePostsForChatId(chatId) {
        const removedIds = [];
        for (const [id, p] of this.byId) {
            if (p.chat_id === chatId) {
                removedIds.push(id);
            }
        }
        if (removedIds.length === 0) {
            return [];
        }
        for (const id of removedIds) {
            this.byId.delete(id);
        }
        this.queuePersist();
        return removedIds;
    }
    clearAllPosts() {
        if (this.byId.size === 0) {
            return;
        }
        this.byId.clear();
        this.queuePersist();
        logger_1.logger.warn('postStore: clearAllPosts');
    }
    getTotalPostCount() {
        return this.byId.size;
    }
    /**
     * Updates the channel message inline keyboard to show the current comment count.
     */
    async updateButtonCaption(bot, post) {
        if (!isMiniAppOpenUrlConfigured()) {
            logger_1.logger.warn('postStore.updateButtonCaption: BOT_NICKNAME / MINI_APP_URL not usable for links');
            return;
        }
        const url = buildMiniAppUrl(post.post_id, post.chat_id);
        const kb = max_bot_api_1.Keyboard.inlineKeyboard([
            [max_bot_api_1.Keyboard.button.link(`💬 Комментарии (${post.comment_count})`, url)],
        ]);
        const targetMid = post.comments_ui_message_mid ?? post.message_mid;
        const text = post.comments_ui_message_mid !== undefined
            ? '\u00a0'
            : post.text.trim() === ''
                ? '\u00a0'
                : post.text;
        const usesReplyUi = post.comments_ui_message_mid !== undefined;
        const { media } = usesReplyUi ? { media: [] } : await resolveChannelPostMediaForEdit(bot, post);
        const attachments = usesReplyUi || media.length === 0 ? [kb] : [...media, kb];
        try {
            await bot.api.editMessage(targetMid, {
                text,
                attachments,
            });
        }
        catch (err) {
            logger_1.logger.warn('postStore.updateButtonCaption: editMessage failed', {
                postId: post.post_id,
                targetMid,
                err,
            });
        }
    }
    queuePersist() {
        this.persistChain = this.persistChain
            .then(() => this.persist())
            .catch((e) => {
            logger_1.logger.error('postStore: persist error', e);
        });
    }
    async persist() {
        const dir = (0, node_path_1.dirname)(this.filePath);
        await (0, promises_1.mkdir)(dir, { recursive: true });
        const body = {
            posts: [...this.byId.values()].sort((a, b) => a.post_id.localeCompare(b.post_id)),
        };
        await (0, promises_1.writeFile)(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    }
}
exports.PostStore = PostStore;
/**
 * Non-keyboard parts of {@link Message.body.attachments} for merging into {@link Bot.api.editMessage}.
 * Incoming {@link Attachment} shapes (e.g. image `payload.url` / `token` / `photo_id`) are accepted by the edit API as {@link AttachmentRequest}.
 */
function mediaAttachmentRequestsFromMessageBody(attachments) {
    if (!attachments?.length) {
        return [];
    }
    return attachments
        .filter((att) => att.type !== 'inline_keyboard')
        .map((a) => a);
}
/**
 * Resolves media to send with `editMessage` on the original channel post: prefers {@link Post.media_attachments},
 * otherwise loads the message via {@link Bot.api.getMessage} or {@link Bot.api.getMessages}.
 *
 * @returns `warnMissingSnapshot` true when the post had no cached media and the API did not yield a usable attachment list (fetch failure or empty `body.attachments`).
 */
async function resolveChannelPostMediaForEdit(bot, post) {
    if (post.media_attachments !== undefined) {
        return { media: [...post.media_attachments], warnMissingSnapshot: false };
    }
    let original;
    try {
        original = await bot.api.getMessage(post.message_mid);
    }
    catch {
        try {
            const { messages } = await bot.api.getMessages(post.chat_id, {
                message_ids: [post.message_mid],
            });
            original = messages[0];
        }
        catch {
            return { media: [], warnMissingSnapshot: true };
        }
    }
    if (!original) {
        return { media: [], warnMissingSnapshot: true };
    }
    const raw = original.body.attachments;
    if (!raw || raw.length === 0) {
        return { media: [], warnMissingSnapshot: true };
    }
    return { media: mediaAttachmentRequestsFromMessageBody(raw), warnMissingSnapshot: false };
}
/**
 * Option A: {@link Bot.api.editMessage} on the original post (`message_id` + body with `attachments`).
 * Option B (fallback): {@link Bot.api.sendMessageToChat} with `link: { type: 'reply', mid }` — bot-owned message with the keyboard, because channel admins' posts are often not editable by the bot.
 */
async function attachCommentButtonToChannelPost(bot, post, editText, keyboard) {
    const { media, warnMissingSnapshot } = await resolveChannelPostMediaForEdit(bot, post);
    const attachments = media.length > 0 ? [...media, keyboard] : [keyboard];
    if (warnMissingSnapshot) {
        logger_1.logger.warn('attachCommentButton: could not load original message attachments; editing with keyboard only (media may be dropped if present)', { postId: post.post_id, messageMid: post.message_mid, chatId: post.chat_id });
    }
    try {
        await bot.api.editMessage(post.message_mid, {
            text: editText,
            attachments,
        });
        logger_1.logger.info('attachCommentButton: edited original channel post', {
            postId: post.post_id,
            messageMid: post.message_mid,
        });
        return;
    }
    catch (err) {
        logger_1.logger.warn('attachCommentButton: editMessage failed, trying reply fallback', {
            postId: post.post_id,
            chatId: post.chat_id,
            messageMid: post.message_mid,
            err,
        });
    }
    try {
        const replyStub = '\u00a0';
        const sent = await bot.api.sendMessageToChat(post.chat_id, replyStub, {
            attachments: [keyboard],
            link: { type: 'reply', mid: post.message_mid },
        });
        const uiMid = sent.body.mid;
        exports.postStore.savePost({ ...post, comments_ui_message_mid: uiMid });
        logger_1.logger.info('attachCommentButton: sent reply message with keyboard', {
            postId: post.post_id,
            commentsUiMessageMid: uiMid,
            replyToMid: post.message_mid,
        });
    }
    catch (err) {
        logger_1.logger.error('attachCommentButton: reply fallback failed', {
            postId: post.post_id,
            chatId: post.chat_id,
            err,
        });
    }
}
function maxStartappPayload(postId, chatId, extra) {
    const compactId = postId.replace(/-/g, '');
    const suffix = extra?.admin === '1' ? '_admin' : '';
    return `pid_${compactId}_cid_${Math.abs(chatId)}${suffix}`;
}
/** True if we can build a link that opens the Mini App (MAX deep link or legacy MINI_APP_URL). */
function isMiniAppOpenUrlConfigured() {
    return config_1.config.botNickname.trim() !== '' || Boolean(config_1.config.miniAppUrl);
}
/**
 * MAX Mini App: `https://max.ru/<bot>?startapp=<payload>` (payload: A–Z, a–z, 0–9, _, -).
 * Fallback: legacy {@link config.miniAppUrl} with `post_id` / `chat_id` query params.
 */
function buildMiniAppUrl(postId, chatId, extra) {
    const payload = maxStartappPayload(postId, chatId, extra);
    const nick = config_1.config.botNickname.trim();
    if (nick) {
        return `https://max.ru/${nick}?startapp=${payload}`;
    }
    const base = config_1.config.miniAppUrl;
    if (!base) {
        throw new Error('buildMiniAppUrl: задайте BOT_NICKNAME или MINI_APP_URL');
    }
    const u = new URL(base.replace(/\/+$/, ''));
    u.searchParams.set('post_id', postId);
    u.searchParams.set('chat_id', String(chatId));
    if (extra) {
        for (const [k, v] of Object.entries(extra)) {
            u.searchParams.set(k, v);
        }
    }
    return u.toString();
}
exports.postStore = new PostStore();
//# sourceMappingURL=postStore.js.map