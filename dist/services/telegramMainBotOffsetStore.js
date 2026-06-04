"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTelegramBotUpdatesOffset = getTelegramBotUpdatesOffset;
exports.setTelegramBotUpdatesOffset = setTelegramBotUpdatesOffset;
const node_crypto_1 = require("node:crypto");
const database_1 = require("../db/database");
function tokenKey(token) {
    return (0, node_crypto_1.createHash)('sha256').update(token.trim()).digest('hex').slice(0, 16);
}
/** Единый offset getUpdates для основного TG-бота (связки + mini app + discovery). */
function getTelegramBotUpdatesOffset(token) {
    const row = (0, database_1.getDb)()
        .prepare('SELECT scan_next_offset FROM tg_chain_reader_offsets WHERE token_key = ?')
        .get(tokenKey(token));
    return row?.scan_next_offset ?? 0;
}
function setTelegramBotUpdatesOffset(token, offset) {
    (0, database_1.getDb)()
        .prepare(`INSERT INTO tg_chain_reader_offsets (token_key, scan_next_offset) VALUES (?, ?)
       ON CONFLICT(token_key) DO UPDATE SET scan_next_offset = excluded.scan_next_offset`)
        .run(tokenKey(token), offset);
}
//# sourceMappingURL=telegramMainBotOffsetStore.js.map