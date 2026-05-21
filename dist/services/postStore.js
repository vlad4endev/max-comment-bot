"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.postStore = exports.MAX_MESSAGE_ATTACHMENTS = exports.PostStore = void 0;
exports.canMergeKeyboardWithMedia = canMergeKeyboardWithMedia;
exports.mediaAttachmentRequestsFromMessageBody = mediaAttachmentRequestsFromMessageBody;
exports.attachCommentButtonToChannelPost = attachCommentButtonToChannelPost;
exports.isMiniAppOpenUrlConfigured = isMiniAppOpenUrlConfigured;
exports.resolveChannelPostUrl = resolveChannelPostUrl;
exports.buildMiniAppUrl = buildMiniAppUrl;
const max_bot_api_1 = require("@maxhub/max-bot-api");
const config_1 = require("../config");
const database_1 = require("../db/database");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const startappPayload_1 = require("../utils/startappPayload");
const logger_1 = require("../utils/logger");
const maxApiRetry_1 = require("../utils/maxApiRetry");
class PostStore {
    statements = null;
    async loadFromDisk() {
        logger_1.logger.debug('postStore: SQLite backend active, loadFromDisk noop');
    }
    savePost(post) {
        try {
            this.ensureChannelRow(post.chat_id);
            const result = this.getStatements().upsert.run(post.post_id, post.chat_id, post.message_mid, post.comments_ui_message_mid ?? null, post.sender_name ?? null, post.text, post.photo_url ?? null, post.media_attachments ? JSON.stringify(post.media_attachments) : null, post.comment_count, post.timestamp, JSON.stringify(post));
            const isNew = result.changes > 0 && result.lastInsertRowid !== undefined;
            logger_1.logger.info(isNew ? 'db: пост сохранён' : 'db: пост обновлён', {
                postId: post.post_id,
                chatId: post.chat_id,
                messageMid: post.message_mid,
                pending: post.button_attach_pending ?? false,
            });
        }
        catch (err) {
            logger_1.logger.error('db: ошибка сохранения поста', {
                postId: post.post_id,
                chatId: post.chat_id,
                messageMid: post.message_mid,
                err,
            });
            throw err;
        }
    }
    /**
     * Ensures a placeholder row exists in `channels` so FK constraint never blocks post save.
     * Real channel data is managed by channelRegistry; this is a safety net only.
     */
    ensureChannelRow(chatId) {
        try {
            const r = (0, database_1.getDb)().prepare("INSERT OR IGNORE INTO channels (chat_id, title, type, date_added, active) VALUES (?, NULL, 'channel', datetime('now'), 1)").run(chatId);
            if (r.changes > 0) {
                logger_1.logger.warn('db: канал не найден при сохранении поста — создана заглушка', { chatId });
            }
        }
        catch (err) {
            // non-fatal — the main upsert will surface any real constraint error
            logger_1.logger.warn('db: ensureChannelRow failed', { chatId, err });
        }
    }
    getPost(postId) {
        const id = postId.trim();
        if (!id) {
            return null;
        }
        let row = this.getStatements().getPost.get(id);
        if (!row) {
            const lower = id.toLowerCase();
            if (lower !== id) {
                row = this.getStatements().getPost.get(lower);
            }
        }
        return row ? this.parsePost(row.data) : null;
    }
    /**
     * Resolves a post by UUID, compact UUID, `message_mid`, or `chat_id` + `message_mid`.
     */
    findPost(identifier, chatId) {
        const id = identifier.trim();
        if (!id) {
            return null;
        }
        let post = this.getPost(id);
        if (post) {
            return post;
        }
        const fromCompact = (0, startappPayload_1.compactUuidToStandard)(id);
        if (fromCompact && fromCompact !== id) {
            post = this.getPost(fromCompact);
            if (post) {
                return post;
            }
        }
        if (chatId !== undefined) {
            post = this.findPostByChannelMessage(chatId, id);
            if (post) {
                return post;
            }
            post = this.findPostByCommentsUiMessage(chatId, id);
            if (post) {
                return post;
            }
        }
        post = this.findByMessageMid(id);
        if (post) {
            return post;
        }
        post = this.findByCommentsUiMessageMid(id);
        if (post) {
            return post;
        }
        logger_1.logger.warn('findPost: not found', { identifier: id, chatId });
        return null;
    }
    findByMessageMid(messageMid) {
        const mid = messageMid.trim();
        if (!mid) {
            return null;
        }
        const row = this.getStatements().findByMid.get(mid);
        return row ? this.parsePost(row.data) : null;
    }
    findByCommentsUiMessageMid(commentsUiMid) {
        const mid = commentsUiMid.trim();
        if (!mid) {
            return null;
        }
        const row = this.getStatements().findByCommentsUiMidAnyChat.get(mid);
        return row ? this.parsePost(row.data) : null;
    }
    getPostsByChatId(chatId) {
        const rows = this.getStatements().listByChatId.all(chatId);
        return rows.map((row) => this.parsePost(row.data));
    }
    findPostByChannelMessage(chatId, messageMid) {
        const canonical = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chatId) ?? chatId;
        for (const cid of [canonical, chatId]) {
            const row = this.getStatements().findByChatAndMid.get(cid, messageMid);
            if (row) {
                return this.parsePost(row.data);
            }
        }
        const abs = Math.abs(canonical);
        const absRow = this.getStatements().findByAbsChatAndMid.get(abs, messageMid);
        return absRow ? this.parsePost(absRow.data) : null;
    }
    /** Reply-stub message id when edit on the original post failed and the bot sent a threaded keyboard. */
    findPostByCommentsUiMessage(chatId, commentsUiMid) {
        const canonical = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chatId) ?? chatId;
        for (const cid of [canonical, chatId]) {
            const row = this.getStatements().findByCommentsUiMid.get(cid, commentsUiMid);
            if (row) {
                return this.parsePost(row.data);
            }
        }
        return null;
    }
    incrementCommentCount(postId) {
        const post = this.getPost(postId);
        if (!post) {
            return null;
        }
        const next = { ...post, comment_count: post.comment_count + 1 };
        this.savePost(next);
        return next.comment_count;
    }
    decrementCommentCount(postId) {
        const post = this.getPost(postId);
        if (!post) {
            return null;
        }
        const next = { ...post, comment_count: Math.max(0, post.comment_count - 1) };
        this.savePost(next);
        return next.comment_count;
    }
    removePostsForChatId(chatId) {
        const rows = this.getStatements().selectIdsByChatId.all(chatId);
        if (rows.length === 0) {
            return [];
        }
        this.getStatements().deleteByChatId.run(chatId);
        logger_1.logger.info('db: посты канала удалены', { chatId, count: rows.length });
        return rows.map((row) => row.post_id);
    }
    clearAllPosts() {
        this.getStatements().deleteAll.run();
        logger_1.logger.warn('postStore: clearAllPosts');
    }
    /** Removes a single post row (rollback after failed TG→MAX comment gate). */
    deletePostById(postId) {
        const id = postId.trim();
        if (!id) {
            return;
        }
        const r = (0, database_1.getDb)().prepare('DELETE FROM posts WHERE post_id = ?').run(id);
        if (r.changes > 0) {
            logger_1.logger.info('db: пост удалён', { postId: id });
        }
    }
    getTotalPostCount() {
        const row = this.getStatements().countAll.get();
        return Number(row.n) || 0;
    }
    /**
     * Updates the channel message inline keyboard to show the current comment count.
     */
    async updateButtonCaption(bot, post) {
        if (!isMiniAppOpenUrlConfigured()) {
            logger_1.logger.warn('postStore.updateButtonCaption: BOT_NICKNAME / MINI_APP_URL not usable for links');
            return false;
        }
        const url = buildMiniAppUrl(post.post_id, post.chat_id, undefined, post.message_mid);
        const startParam = (() => {
            try {
                return new URL(url).searchParams.get('startapp');
            }
            catch {
                return null;
            }
        })();
        logger_1.logger.info('commentButton: creating button', {
            postId: post.post_id,
            chatId: post.chat_id,
            messageMid: post.message_mid,
            buttonUrl: url,
        });
        logger_1.logger.info('commentButton: button payload', {
            buttonUrl: url,
            startParam,
            postId: post.post_id,
            chatId: post.chat_id,
            messageMid: post.message_mid,
        });
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
        if (!usesReplyUi && media.length > 0 && !canMergeKeyboardWithMedia(media.length)) {
            logger_1.logger.info('postStore.updateButtonCaption: много медиа — обновляем только клавиатуру', {
                postId: post.post_id,
                targetMid,
                mediaCount: media.length,
            });
            try {
                await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.editMessage(targetMid, { text, attachments: [kb] }));
                return true;
            }
            catch (err) {
                logger_1.logger.warn('postStore.updateButtonCaption: keyboard-only edit failed', {
                    postId: post.post_id,
                    targetMid,
                    err,
                });
                return false;
            }
        }
        const attachments = usesReplyUi || media.length === 0 ? [kb] : [...media, kb];
        try {
            await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.editMessage(targetMid, { text, attachments }));
            return true;
        }
        catch (err) {
            logger_1.logger.warn('postStore.updateButtonCaption: editMessage failed', {
                postId: post.post_id,
                targetMid,
                err,
            });
            return false;
        }
    }
    parsePost(raw) {
        return JSON.parse(raw);
    }
    getStatements() {
        if (this.statements) {
            return this.statements;
        }
        const db = (0, database_1.getDb)();
        this.statements = {
            getPost: db.prepare('SELECT data FROM posts WHERE post_id = ?'),
            listByChatId: db.prepare('SELECT data FROM posts WHERE chat_id = ? ORDER BY timestamp ASC, post_id ASC'),
            findByChatAndMid: db.prepare('SELECT data FROM posts WHERE chat_id = ? AND message_mid = ?'),
            findByAbsChatAndMid: db.prepare('SELECT data FROM posts WHERE ABS(chat_id) = ? AND message_mid = ? LIMIT 1'),
            findByCommentsUiMid: db.prepare('SELECT data FROM posts WHERE chat_id = ? AND comments_ui_message_mid = ? LIMIT 1'),
            findByMid: db.prepare('SELECT data FROM posts WHERE message_mid = ? ORDER BY timestamp DESC, post_id DESC LIMIT 1'),
            findByCommentsUiMidAnyChat: db.prepare('SELECT data FROM posts WHERE comments_ui_message_mid = ? ORDER BY timestamp DESC, post_id DESC LIMIT 1'),
            upsert: db.prepare(`INSERT INTO posts (
          post_id, chat_id, message_mid, comments_ui_message_mid, sender_name, text,
          photo_url, media_attachments, comment_count, timestamp, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, message_mid) DO UPDATE SET
          comments_ui_message_mid = excluded.comments_ui_message_mid,
          sender_name             = excluded.sender_name,
          text                    = excluded.text,
          photo_url               = excluded.photo_url,
          media_attachments       = excluded.media_attachments,
          comment_count           = excluded.comment_count,
          data                    = json_set(
            json_set(
              json_set(excluded.data, '$.post_id', posts.post_id),
              '$.chat_id',
              posts.chat_id
            ),
            '$.message_mid',
            posts.message_mid
          )`),
            selectIdsByChatId: db.prepare('SELECT post_id FROM posts WHERE chat_id = ?'),
            deleteByChatId: db.prepare('DELETE FROM posts WHERE chat_id = ?'),
            deleteAll: db.prepare('DELETE FROM posts'),
            countAll: db.prepare('SELECT COUNT(*) AS n FROM posts'),
        };
        return this.statements;
    }
}
exports.PostStore = PostStore;
/** MAX rejects edits when attachments exceed this count (observed: 5 photos + keyboard fails). */
exports.MAX_MESSAGE_ATTACHMENTS = 5;
/** Min gap between consecutive MAX API writes (edit/reply) to the same channel to avoid 429. */
const ATTACH_THROTTLE_MS = 1_200;
const lastAttachAt = new Map();
async function throttleChannelAttach(chatId) {
    const now = Date.now();
    const last = lastAttachAt.get(chatId) ?? 0;
    const wait = ATTACH_THROTTLE_MS - (now - last);
    if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
    }
    lastAttachAt.set(chatId, Date.now());
}
/** True when original media plus an inline keyboard fit in one {@link Bot.api.editMessage}. */
function canMergeKeyboardWithMedia(mediaCount) {
    return mediaCount + 1 <= exports.MAX_MESSAGE_ATTACHMENTS;
}
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
async function attachCommentButtonToChannelPost(bot, post, editText, keyboard, logCtx) {
    const apiStartedAt = performance.now();
    const logBase = {
        source: logCtx?.source ?? 'unknown',
        phase: logCtx?.phase,
        postId: post.post_id,
        chatId: post.chat_id,
        messageMid: post.message_mid,
    };
    const { media, warnMissingSnapshot } = await resolveChannelPostMediaForEdit(bot, post);
    const mergeMediaInEdit = canMergeKeyboardWithMedia(media.length);
    if (warnMissingSnapshot) {
        logger_1.logger.warn('commentButton: нет снимка вложений поста — edit только с клавиатурой (медиа может пропасть)', logBase);
    }
    if (media.length > 0 && !mergeMediaInEdit) {
        logger_1.logger.info('commentButton: слишком много медиа для edit — кнопка через reply под постом', {
            ...logBase,
            mediaCount: media.length,
            maxAttachments: exports.MAX_MESSAGE_ATTACHMENTS,
        });
        if (logCtx?.inlineOnly) {
            logger_1.logger.info('commentButton: inline-only mode, skip reply fallback', {
                ...logBase,
                mediaCount: media.length,
            });
            return false;
        }
    }
    const apiDuration = () => {
        const apiDurationMs = Math.round(performance.now() - apiStartedAt);
        const apiDuration = apiDurationMs >= 1000 ? `${(apiDurationMs / 1000).toFixed(2)} с` : `${apiDurationMs} мс`;
        return { apiDurationMs, apiDuration };
    };
    await throttleChannelAttach(post.chat_id);
    const existingUiMid = post.comments_ui_message_mid?.trim();
    if (existingUiMid) {
        logger_1.logger.info('commentButton: обновляем существующее reply-сообщение с кнопкой', {
            ...logBase,
            commentsUiMessageMid: existingUiMid,
        });
        try {
            const editStartedAt = performance.now();
            await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.editMessage(existingUiMid, { text: '\u00a0', attachments: [keyboard] }));
            const editMs = Math.round(performance.now() - editStartedAt);
            const timing = apiDuration();
            logger_1.logger.info(`commentButton: кнопка обновлена в reply UI (${timing.apiDuration})`, {
                ...logBase,
                method: 'edit_ui',
                commentsUiMessageMid: existingUiMid,
                editMs,
                ...timing,
            });
            return true;
        }
        catch (err) {
            logger_1.logger.warn('commentButton: edit reply UI не удался — не создаём дубликат reply', {
                ...logBase,
                commentsUiMessageMid: existingUiMid,
                ...apiDuration(),
                err,
            });
            return false;
        }
    }
    if (mergeMediaInEdit) {
        const attachments = media.length > 0 ? [...media, keyboard] : [keyboard];
        logger_1.logger.info('commentButton: пробуем editMessage на посте канала', {
            ...logBase,
            attachmentCount: attachments.length,
        });
        try {
            const editStartedAt = performance.now();
            await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.editMessage(post.message_mid, { text: editText, attachments }));
            const editMs = Math.round(performance.now() - editStartedAt);
            const timing = apiDuration();
            logger_1.logger.info(`commentButton: кнопка добавлена через edit поста (${timing.apiDuration})`, {
                ...logBase,
                method: 'edit',
                editMs,
                ...timing,
            });
            return true;
        }
        catch (err) {
            logger_1.logger.warn('commentButton: editMessage не удался — пробуем reply с кнопкой', {
                ...logBase,
                attachmentCount: attachments.length,
                ...apiDuration(),
                err,
            });
            if (logCtx?.inlineOnly) {
                logger_1.logger.info('commentButton: inline-only mode, skip reply fallback after edit failure', {
                    ...logBase,
                });
                return false;
            }
        }
    }
    else if (media.length > 0) {
        logger_1.logger.info('commentButton: много медиа — пробуем edit только с клавиатурой', {
            ...logBase,
            mediaCount: media.length,
        });
        try {
            const editStartedAt = performance.now();
            await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.editMessage(post.message_mid, { text: editText, attachments: [keyboard] }));
            const editMs = Math.round(performance.now() - editStartedAt);
            const timing = apiDuration();
            logger_1.logger.info(`commentButton: кнопка добавлена через edit (только клавиатура) (${timing.apiDuration})`, {
                ...logBase,
                method: 'edit_keyboard_only',
                editMs,
                ...timing,
            });
            return true;
        }
        catch (err) {
            logger_1.logger.warn('commentButton: edit только с клавиатурой не удался — пробуем reply', {
                ...logBase,
                mediaCount: media.length,
                ...apiDuration(),
                err,
            });
            if (logCtx?.inlineOnly) {
                return false;
            }
        }
    }
    try {
        const replyStartedAt = performance.now();
        const replyStub = '\u00a0';
        const sent = await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.sendMessageToChat(post.chat_id, replyStub, {
            attachments: [keyboard],
            link: { type: 'reply', mid: post.message_mid },
        }));
        const replyMs = Math.round(performance.now() - replyStartedAt);
        const uiMid = sent.body.mid;
        exports.postStore.savePost({ ...post, comments_ui_message_mid: uiMid });
        const timing = apiDuration();
        logger_1.logger.info(`commentButton: кнопка добавлена через reply под постом (${timing.apiDuration})`, {
            ...logBase,
            method: 'reply',
            commentsUiMessageMid: uiMid,
            replyMs,
            ...timing,
        });
        return true;
    }
    catch (err) {
        logger_1.logger.error(`commentButton: reply с кнопкой тоже не удался (${apiDuration().apiDuration})`, {
            ...logBase,
            ...apiDuration(),
            err,
        });
        return false;
    }
}
function maxStartappPayload(postId, chatId, messageMid, extra) {
    const compactId = postId.replace(/-/g, '');
    const suffix = extra?.admin === '1' ? '_admin' : '';
    const midPart = messageMid && messageMid.trim() !== ''
        ? `_mid_${(0, startappPayload_1.encodeMessageMidForStartapp)(messageMid.trim())}`
        : '';
    return `pid_${compactId}_cid_${Math.abs(chatId)}${midPart}${suffix}`;
}
/** True if we can build a link that opens the Mini App (MAX deep link or legacy MINI_APP_URL). */
function isMiniAppOpenUrlConfigured() {
    return config_1.config.botNickname.trim() !== '' || Boolean(config_1.config.miniAppUrl);
}
/**
 * MAX Mini App: `https://max.ru/<bot>?startapp=<payload>` (payload: A–Z, a–z, 0–9, _, -).
 * Fallback: legacy {@link config.miniAppUrl} with `post_id` / `chat_id` query params.
 */
/** Returns shareable channel post URL; fetches from MAX API and persists when missing in DB. */
async function resolveChannelPostUrl(bot, post) {
    const stored = post.channel_post_url?.trim();
    if (stored) {
        return stored;
    }
    let message;
    try {
        message = await bot.api.getMessage(post.message_mid);
    }
    catch {
        try {
            const { messages } = await bot.api.getMessages(post.chat_id, {
                message_ids: [post.message_mid],
            });
            message = messages[0];
        }
        catch (err) {
            logger_1.logger.warn('resolveChannelPostUrl: could not load message', {
                postId: post.post_id,
                messageMid: post.message_mid,
                err,
            });
            return null;
        }
    }
    const url = message?.url?.trim();
    if (!url) {
        return null;
    }
    exports.postStore.savePost({ ...post, channel_post_url: url });
    return url;
}
function buildMiniAppUrl(postId, chatId, extra, messageMid) {
    if ((!extra || extra.admin !== '1') && (!messageMid || messageMid.trim() === '')) {
        logger_1.logger.warn('buildMiniAppUrl: message_mid missing for post link', {
            postId,
            chatId,
            extra,
        });
    }
    const payload = maxStartappPayload(postId, chatId, messageMid, extra);
    const nick = config_1.config.botNickname.trim();
    let buttonUrl;
    if (nick) {
        buttonUrl = `https://max.ru/${nick}?startapp=${payload}`;
    }
    else {
        const base = config_1.config.miniAppUrl;
        if (!base) {
            throw new Error('buildMiniAppUrl: задайте BOT_NICKNAME или MINI_APP_URL');
        }
        const u = new URL(base.replace(/\/+$/, ''));
        u.searchParams.set('post_id', postId);
        u.searchParams.set('chat_id', String(chatId));
        if (messageMid && messageMid.trim() !== '') {
            u.searchParams.set('message_mid', messageMid.trim());
        }
        if (extra) {
            for (const [k, v] of Object.entries(extra)) {
                u.searchParams.set(k, v);
            }
        }
        buttonUrl = u.toString();
    }
    return buttonUrl;
}
exports.postStore = new PostStore();
//# sourceMappingURL=postStore.js.map