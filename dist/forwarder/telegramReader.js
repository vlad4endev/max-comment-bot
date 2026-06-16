"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramGetUpdatesConflictError = void 0;
exports.getTgUpdates = getTgUpdates;
exports.getTgFileUrl = getTgFileUrl;
exports.getTelegramUpdatesWithIds = getTelegramUpdatesWithIds;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../utils/logger");
const TG_API = 'https://api.telegram.org/bot';
class TelegramGetUpdatesConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TelegramGetUpdatesConflictError';
    }
}
exports.TelegramGetUpdatesConflictError = TelegramGetUpdatesConflictError;
async function getTgUpdates(token, offset = 0) {
    const url = `${TG_API}${token}/getUpdates?offset=${offset}&timeout=10&allowed_updates=["channel_post"]`;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const res = await axios_1.default.get(url);
            const updates = res.data?.result || [];
            return updates
                .filter((u) => u.channel_post)
                .map((u) => u.channel_post);
        }
        catch (err) {
            if (axios_1.default.isAxiosError(err) && err.response?.status === 409) {
                logger_1.logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s', {
                    offset,
                    attempt,
                });
                await new Promise((r) => setTimeout(r, 10_000));
                continue;
            }
            throw err;
        }
    }
    throw new TelegramGetUpdatesConflictError('telegram getUpdates conflict (409)');
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
async function getTelegramUpdatesWithIds(token, offset, timeoutSec = 0, options) {
    const allowed = ['channel_post', 'edited_channel_post', 'edited_message'];
    if (options?.includeMiniappBotUpdates) {
        allowed.push('message', 'my_chat_member', 'callback_query');
    }
    else if (options?.includeDiscussionMessages) {
        allowed.push('message');
    }
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const res = await axios_1.default.get(`${TG_API}${token}/getUpdates`, {
                params: {
                    offset,
                    timeout: timeoutSec,
                    allowed_updates: JSON.stringify(allowed),
                },
            });
            const updates = res.data?.result || [];
            return updates
                .filter((u) => typeof u.update_id === 'number')
                .map((u) => ({
                update_id: u.update_id,
                channel_post: u.channel_post,
                edited_channel_post: u.edited_channel_post,
                edited_message: u.edited_message,
                message: u.message,
                my_chat_member: u.my_chat_member,
                callback_query: u.callback_query,
                raw: u,
            }));
        }
        catch (err) {
            if (axios_1.default.isAxiosError(err) && err.response?.status === 409) {
                logger_1.logger.warn('[tgChain] 409 conflict — another instance may be running, waiting 10s', {
                    offset,
                    attempt,
                });
                await new Promise((r) => setTimeout(r, 10_000));
                continue;
            }
            throw err;
        }
    }
    throw new TelegramGetUpdatesConflictError('telegram getUpdates conflict (409)');
}
//# sourceMappingURL=telegramReader.js.map