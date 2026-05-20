"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendAutopostToTelegram = sendAutopostToTelegram;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
const logger_1 = require("../utils/logger");
const TG_API = 'https://api.telegram.org';
function buildInlineKeyboard(button) {
    return {
        inline_keyboard: [[{ text: button.text.slice(0, 64), url: button.url }]],
    };
}
async function tgPost(token, method, body) {
    const url = `${TG_API}/bot${token}/${method}`;
    const isForm = body instanceof form_data_1.default;
    const { data } = await axios_1.default.post(url, body, {
        timeout: 120_000,
        headers: isForm ? body.getHeaders() : { 'Content-Type': 'application/json' },
    });
    if (!data.ok) {
        throw new Error(data.description ?? `Telegram ${method} failed`);
    }
    return data.result;
}
async function sendText(token, chatId, text, button) {
    const payload = {
        chat_id: chatId,
        text: text.slice(0, 4096) || '\u00a0',
    };
    if (button) {
        payload.reply_markup = JSON.stringify(buildInlineKeyboard(button));
    }
    await tgPost(token, 'sendMessage', payload);
}
async function sendSingleMedia(token, chatId, item, caption, button) {
    const method = item.type === 'video' ? 'sendVideo' : 'sendPhoto';
    const field = item.type === 'video' ? 'video' : 'photo';
    const form = new form_data_1.default();
    form.append('chat_id', chatId);
    if (caption.trim()) {
        form.append('caption', caption.slice(0, 1024));
    }
    if (button) {
        form.append('reply_markup', JSON.stringify(buildInlineKeyboard(button)));
    }
    form.append(field, node_fs_1.default.createReadStream(item.path), {
        filename: node_path_1.default.basename(item.path),
    });
    await tgPost(token, method, form);
}
async function sendMediaGroup(token, chatId, media, caption) {
    const form = new form_data_1.default();
    form.append('chat_id', chatId);
    const items = media.map((m, index) => {
        const entry = {
            type: m.type === 'video' ? 'video' : 'photo',
            media: `attach://${m.type}_${index}`,
        };
        if (index === 0 && caption.trim()) {
            entry.caption = caption.slice(0, 1024);
        }
        return entry;
    });
    form.append('media', JSON.stringify(items));
    for (let i = 0; i < media.length; i += 1) {
        const m = media[i];
        const field = `${m.type}_${i}`;
        form.append(field, node_fs_1.default.createReadStream(m.path), { filename: node_path_1.default.basename(m.path) });
    }
    await tgPost(token, 'sendMediaGroup', form);
}
/**
 * Публикует автопост в Telegram-канал.
 * sendMediaGroup не поддерживает inline-кнопки — при альбоме кнопка уходит отдельным сообщением.
 */
async function sendAutopostToTelegram(token, post) {
    const chatId = post.target_channel_id;
    const text = post.text.trim();
    const media = post.media.filter((m) => node_fs_1.default.existsSync(m.path));
    const button = post.inline_button;
    if (media.length === 0) {
        await sendText(token, chatId, text, button);
        return { ok: true };
    }
    if (media.length === 1) {
        await sendSingleMedia(token, chatId, media[0], text, button);
        return { ok: true };
    }
    await sendMediaGroup(token, chatId, media, text);
    if (!button) {
        return { ok: true };
    }
    const warning = 'Инлайн-кнопка не поддерживается в альбоме Telegram — отправлено отдельным сообщением';
    try {
        await sendText(token, chatId, button.text, button);
        return { ok: true, buttonSentSeparately: true, warning };
    }
    catch (err) {
        logger_1.logger.warn('autopost: album sent, separate button message failed', err);
        return { ok: true, buttonSentSeparately: false, warning };
    }
}
//# sourceMappingURL=autopostTelegramSender.js.map