"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.allocatePostIdForChannelMessage = allocatePostIdForChannelMessage;
const uuid_1 = require("uuid");
const postStore_1 = require("./postStore");
/** Stable `post_id` for `(chat_id, message_mid)`; reuses row id or a free `preferredPostId` from the button link. */
function allocatePostIdForChannelMessage(chatId, messageMid, preferredPostId) {
    const existing = postStore_1.postStore.findPostByChannelMessage(chatId, messageMid);
    if (existing) {
        return existing.post_id;
    }
    const preferred = preferredPostId?.trim();
    if (preferred && !postStore_1.postStore.getPost(preferred)) {
        return preferred;
    }
    return (0, uuid_1.v4)();
}
//# sourceMappingURL=postIdAllocation.js.map