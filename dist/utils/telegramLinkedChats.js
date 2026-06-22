"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeTelegramLinkedChatsForApi = normalizeTelegramLinkedChatsForApi;
/** Безопасное приведение linkedChats к ответу API (защита от битых данных в integrations.json). */
function normalizeTelegramLinkedChatsForApi(linkedChats) {
    const list = Array.isArray(linkedChats) ? linkedChats : [];
    const out = [];
    for (const chat of list) {
        const record = typeof chat === 'object' && chat !== null ? chat : null;
        const id = String(record?.id ?? '').trim();
        if (!id) {
            continue;
        }
        out.push({
            id,
            title: String(record?.title ?? 'Без названия'),
            username: typeof record?.username === 'string' ? record.username : null,
            type: typeof record?.type === 'string' ? record.type : 'channel',
            botIsAdmin: record?.botIsAdmin === true,
        });
    }
    return out;
}
//# sourceMappingURL=telegramLinkedChats.js.map