"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.postStore = exports.PostStore = void 0;
exports.attachCommentButtonToChannelPost = attachCommentButtonToChannelPost;
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
        typeof o.text === 'string' &&
        (o.photo_url === undefined || typeof o.photo_url === 'string') &&
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
     * Updates the channel message inline keyboard to show the current comment count.
     */
    async updateButtonCaption(bot, post) {
        const base = config_1.config.miniAppUrl;
        if (!base) {
            logger_1.logger.warn('postStore.updateButtonCaption: MINI_APP_URL not set');
            return;
        }
        const url = buildMiniAppUrl(base, post.post_id, post.chat_id);
        const kb = max_bot_api_1.Keyboard.inlineKeyboard([
            [max_bot_api_1.Keyboard.button.link(`💬 Комментарии (${post.comment_count})`, url)],
        ]);
        const targetMid = post.comments_ui_message_mid ?? post.message_mid;
        const text = post.comments_ui_message_mid !== undefined
            ? '\u00a0'
            : post.text.trim() === ''
                ? '\u00a0'
                : post.text;
        try {
            await bot.api.editMessage(targetMid, {
                text,
                attachments: [kb],
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
 * Option A: {@link Bot.api.editMessage} on the original post (`message_id` + body with `attachments`).
 * Option B (fallback): {@link Bot.api.sendMessageToChat} with `link: { type: 'reply', mid }` — bot-owned message with the keyboard, because channel admins' posts are often not editable by the bot.
 */
async function attachCommentButtonToChannelPost(bot, post, editText, keyboard) {
    try {
        await bot.api.editMessage(post.message_mid, {
            text: editText,
            attachments: [keyboard],
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
/**
 * Builds Mini App open URL with required query params (URL-encoded).
 */
function buildMiniAppUrl(miniAppBase, postId, chatId, extra) {
    const u = new URL(miniAppBase.replace(/\/+$/, ''));
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