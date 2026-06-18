"use strict";
/**
 * commentSyncGuard.ts
 *
 * Защита от бесконечного цикла синхронизации комментариев.
 * Когда мы сами отправляем комментарий из TG в Max (или наоборот),
 * помечаем его ID здесь — чтобы обратный watcher не создал дубль.
 *
 * TTL 60 секунд достаточно: polling/webhook работает быстрее.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.markCommentSynced = markCommentSynced;
exports.isCommentSynced = isCommentSynced;
const synced = new Map();
const TTL_MS = 60_000;
function markCommentSynced(id) {
    synced.set(id, Date.now());
    setTimeout(() => synced.delete(id), TTL_MS);
}
function isCommentSynced(id) {
    return synced.has(id);
}
//# sourceMappingURL=commentSyncGuard.js.map