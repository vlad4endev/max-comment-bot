"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendAutopostToMax = sendAutopostToMax;
exports.resolveMaxToken = resolveMaxToken;
const node_fs_1 = __importDefault(require("node:fs"));
const config_1 = require("../config");
const maxPublisher_1 = require("../forwarder/maxPublisher");
function resolveKeyboard(post) {
    if (post.inline_buttons?.length)
        return post.inline_buttons;
    if (post.inline_button)
        return [[post.inline_button]];
    return null;
}
function existingMedia(media) {
    return media.filter((m) => node_fs_1.default.existsSync(m.path));
}
/**
 * Публикует автопост в MAX-канал (HTML + медиа + инлайн-кнопки).
 */
async function sendAutopostToMax(token, post) {
    const chatId = post.target_channel_id;
    const text = post.text.trim();
    const media = existingMedia(post.media);
    const sendOpts = { keyboard: resolveKeyboard(post) };
    if (media.length === 0) {
        await (0, maxPublisher_1.sendTextToMax)(token, chatId, text, sendOpts);
        return { ok: true };
    }
    if (media.length === 1) {
        const item = media[0];
        if (item.type === 'video') {
            await (0, maxPublisher_1.sendVideoFileToMax)(token, chatId, item.path, text, sendOpts);
        }
        else {
            await (0, maxPublisher_1.sendPhotoFileToMax)(token, chatId, item.path, text, sendOpts);
        }
        return { ok: true };
    }
    await (0, maxPublisher_1.sendMediaAlbumFilesToMax)(token, chatId, text, media.map((m) => ({
        type: m.type === 'video' ? 'video' : 'image',
        filePath: m.path,
    })), sendOpts);
    return { ok: true };
}
function resolveMaxToken() {
    const token = config_1.config.BOT_TOKEN.trim();
    return token || null;
}
//# sourceMappingURL=autopostMaxSender.js.map