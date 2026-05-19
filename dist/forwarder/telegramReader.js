"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTgUpdates = getTgUpdates;
exports.getTgFileUrl = getTgFileUrl;
exports.getTelegramUpdatesWithIds = getTelegramUpdatesWithIds;
const axios_1 = __importDefault(require("axios"));
const TG_API = 'https://api.telegram.org/bot';
async function getTgUpdates(token, offset = 0) {
    const url = `${TG_API}${token}/getUpdates?offset=${offset}&timeout=10&allowed_updates=["channel_post"]`;
    const res = await axios_1.default.get(url);
    const updates = res.data?.result || [];
    return updates
        .filter((u) => u.channel_post)
        .map((u) => u.channel_post);
}
async function getTgFileUrl(token, fileId) {
    try {
        const res = await axios_1.default.get(`${TG_API}${token}/getFile`, {
            params: { file_id: fileId },
        });
        const path = res.data?.result?.file_path;
        if (!path)
            return null;
        return `https://api.telegram.org/file/bot${token}/${path}`;
    }
    catch {
        return null;
    }
}
/** Сырые апдейты с `update_id` — для корректного offset при опросе. */
async function getTelegramUpdatesWithIds(token, offset, timeoutSec = 0) {
    const res = await axios_1.default.get(`${TG_API}${token}/getUpdates`, {
        params: {
            offset,
            timeout: timeoutSec,
            allowed_updates: JSON.stringify(['channel_post']),
        },
    });
    const updates = res.data?.result || [];
    return updates
        .filter((u) => u.channel_post && typeof u.update_id === 'number')
        .map((u) => ({ update_id: u.update_id, channel_post: u.channel_post }));
}
//# sourceMappingURL=telegramReader.js.map