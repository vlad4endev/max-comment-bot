"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateFromJson = migrateFromJson;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const database_1 = require("./database");
const DATA_DIR = node_path_1.default.resolve(__dirname, '../../data');
function parseJsonFile(filePath) {
    if (!node_fs_1.default.existsSync(filePath)) {
        return null;
    }
    try {
        const raw = node_fs_1.default.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    }
    catch (error) {
        console.error(`migrate: не удалось прочитать ${node_path_1.default.basename(filePath)}`, error);
        return null;
    }
}
function asArray(value, key) {
    if (Array.isArray(value)) {
        return value;
    }
    if (value && typeof value === 'object' && key in value) {
        const nested = value[key];
        if (Array.isArray(nested)) {
            return nested;
        }
    }
    if (value && typeof value === 'object') {
        return Object.values(value);
    }
    return [];
}
function parseIntId(value) {
    if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number.parseInt(value, 10);
        if (Number.isInteger(n)) {
            return n;
        }
    }
    return null;
}
function parseChatType(value) {
    if (value === 'dialog' || value === 'chat' || value === 'channel') {
        return value;
    }
    return 'channel';
}
function normalizeChannel(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const o = raw;
    const chatId = parseIntId(o.chat_id ?? o.chatId ?? o.id);
    if (chatId === null) {
        return null;
    }
    const dateAddedRaw = o.date_added ?? o.dateAdded;
    return {
        chat_id: chatId,
        title: typeof o.title === 'string' ? o.title : null,
        type: parseChatType(o.type),
        date_added: typeof dateAddedRaw === 'string' && dateAddedRaw.trim() !== ''
            ? dateAddedRaw
            : new Date().toISOString(),
    };
}
function normalizePost(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const o = raw;
    if (typeof o.post_id !== 'string' || typeof o.message_mid !== 'string' || typeof o.text !== 'string') {
        return null;
    }
    const chatId = parseIntId(o.chat_id);
    if (chatId === null) {
        return null;
    }
    const commentCount = typeof o.comment_count === 'number' && Number.isInteger(o.comment_count) && o.comment_count >= 0
        ? o.comment_count
        : 0;
    const timestamp = typeof o.timestamp === 'string' && o.timestamp.trim() !== ''
        ? o.timestamp
        : new Date().toISOString();
    const post = {
        post_id: o.post_id,
        chat_id: chatId,
        message_mid: o.message_mid,
        text: o.text,
        comment_count: commentCount,
        timestamp,
    };
    if (typeof o.comments_ui_message_mid === 'string') {
        post.comments_ui_message_mid = o.comments_ui_message_mid;
    }
    if (typeof o.sender_name === 'string') {
        post.sender_name = o.sender_name;
    }
    if (typeof o.photo_url === 'string') {
        post.photo_url = o.photo_url;
    }
    if (typeof o.channel_post_url === 'string' && o.channel_post_url.trim() !== '') {
        post.channel_post_url = o.channel_post_url.trim();
    }
    if (Array.isArray(o.media_attachments)) {
        post.media_attachments = o.media_attachments;
    }
    return post;
}
function normalizeReply(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const o = raw;
    if (typeof o.text !== 'string' || typeof o.timestamp !== 'string') {
        return undefined;
    }
    const reply = { text: o.text, timestamp: o.timestamp };
    if (typeof o.admin_name === 'string') {
        reply.admin_name = o.admin_name;
    }
    return reply;
}
function normalizeNotificationMids(raw) {
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const list = [];
    for (const item of raw) {
        if (typeof item !== 'object' || item === null) {
            continue;
        }
        const o = item;
        const adminId = parseIntId(o.admin_id);
        if (adminId === null || typeof o.message_mid !== 'string') {
            continue;
        }
        list.push({ admin_id: adminId, message_mid: o.message_mid });
    }
    return list;
}
function normalizeComment(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const o = raw;
    const userId = parseIntId(o.user_id ?? o.userId);
    if (typeof o.comment_id !== 'string' ||
        typeof o.post_id !== 'string' ||
        userId === null ||
        typeof o.username !== 'string' ||
        typeof o.text !== 'string') {
        return null;
    }
    const timestamp = typeof o.timestamp === 'string' && o.timestamp.trim() !== ''
        ? o.timestamp
        : new Date().toISOString();
    const comment = {
        comment_id: o.comment_id,
        post_id: o.post_id,
        user_id: userId,
        username: o.username,
        text: o.text,
        timestamp,
    };
    const reply = normalizeReply(o.reply);
    if (reply) {
        comment.reply = reply;
    }
    if (typeof o.notification_text === 'string') {
        comment.notification_text = o.notification_text;
    }
    const mids = normalizeNotificationMids(o.notification_mids);
    if (mids && mids.length > 0) {
        comment.notification_mids = mids;
    }
    return comment;
}
function migrateFromJson() {
    const db = (0, database_1.getDb)();
    const channelCount = Number(db.prepare('SELECT COUNT(*) AS n FROM channels').get().n ?? 0);
    const postCount = Number(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n ?? 0);
    const commentCount = Number(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n ?? 0);
    const subscriberCount = Number(db.prepare('SELECT COUNT(*) AS n FROM subscribers').get().n ?? 0);
    if (channelCount + postCount + commentCount + subscriberCount > 0) {
        console.log('migrate: SQLite уже содержит данные, пропускаем');
        return;
    }
    console.log('migrate: начинаем перенос JSON → SQLite...');
    const channelsRaw = parseJsonFile(node_path_1.default.join(DATA_DIR, 'channels.json'));
    const channels = asArray(channelsRaw, 'channels')
        .map(normalizeChannel)
        .filter((v) => v !== null);
    if (channels.length > 0) {
        const insert = db.prepare('INSERT OR IGNORE INTO channels (chat_id, title, type, date_added, active, settings) VALUES (?, ?, ?, ?, ?, ?)');
        const run = db.transaction((items) => {
            for (const item of items) {
                insert.run(item.chat_id, item.title, item.type, item.date_added, 1, JSON.stringify(item));
            }
        });
        run(channels);
    }
    console.log(`migrate: перенесено ${channels.length} каналов`);
    const postsRaw = parseJsonFile(node_path_1.default.join(DATA_DIR, 'posts.json'));
    const posts = asArray(postsRaw, 'posts')
        .map(normalizePost)
        .filter((v) => v !== null);
    if (posts.length > 0) {
        const insert = db.prepare(`INSERT OR IGNORE INTO posts (
        post_id, chat_id, message_mid, comments_ui_message_mid, sender_name, text,
        photo_url, media_attachments, comment_count, timestamp, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const run = db.transaction((items) => {
            for (const item of items) {
                insert.run(item.post_id, item.chat_id, item.message_mid, item.comments_ui_message_mid ?? null, item.sender_name ?? null, item.text, item.photo_url ?? null, item.media_attachments ? JSON.stringify(item.media_attachments) : null, item.comment_count, item.timestamp, JSON.stringify(item));
            }
        });
        run(posts);
    }
    console.log(`migrate: перенесено ${posts.length} постов`);
    const commentsRaw = parseJsonFile(node_path_1.default.join(DATA_DIR, 'comments.json'));
    const comments = asArray(commentsRaw, 'comments')
        .map(normalizeComment)
        .filter((v) => v !== null);
    if (comments.length > 0) {
        const insert = db.prepare(`INSERT OR IGNORE INTO comments (
        comment_id, post_id, user_id, username, text, timestamp, reply, notification_text, notification_mids, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const run = db.transaction((items) => {
            for (const item of items) {
                insert.run(item.comment_id, item.post_id, item.user_id, item.username, item.text, item.timestamp, item.reply ? JSON.stringify(item.reply) : null, item.notification_text ?? null, item.notification_mids ? JSON.stringify(item.notification_mids) : null, JSON.stringify(item));
            }
        });
        run(comments);
    }
    console.log(`migrate: перенесено ${comments.length} комментариев`);
    const subscribersRaw = parseJsonFile(node_path_1.default.join(DATA_DIR, 'subscribers.json'));
    const subscribers = asArray(subscribersRaw, 'subscribers')
        .map(parseIntId)
        .filter((v) => v !== null && v > 0);
    if (subscribers.length > 0) {
        const insert = db.prepare('INSERT OR IGNORE INTO subscribers (user_id, data) VALUES (?, ?)');
        const run = db.transaction((items) => {
            for (const item of items) {
                insert.run(item, JSON.stringify({ user_id: item }));
            }
        });
        run(subscribers);
    }
    console.log(`migrate: перенесено ${subscribers.length} подписчиков`);
    console.log('migrate: ✅ миграция завершена');
}
//# sourceMappingURL=migrate.js.map