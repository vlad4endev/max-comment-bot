"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runForwarderOnce = runForwarderOnce;
exports.startForwarderLoop = startForwarderLoop;
const database_1 = require("../db/database");
const telegramReader_1 = require("./telegramReader");
const maxPublisher_1 = require("./maxPublisher");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isAlreadySent(tgChannel, messageId) {
    const row = (0, database_1.getDb)()
        .prepare('SELECT id FROM forwarded_posts WHERE tg_channel = ? AND tg_message_id = ?')
        .get(tgChannel, messageId);
    return !!row;
}
function markSent(tgChannel, messageId) {
    (0, database_1.getDb)()
        .prepare('INSERT OR IGNORE INTO forwarded_posts (tg_channel, tg_message_id) VALUES (?, ?)')
        .run(tgChannel, messageId);
}
function getLastOffset(tgChannel) {
    const row = (0, database_1.getDb)()
        .prepare('SELECT last_message_id FROM forwarding_configs WHERE tg_channel = ? AND is_active = 1')
        .get(tgChannel);
    return row?.last_message_id || 0;
}
function saveOffset(tgChannel, offset) {
    (0, database_1.getDb)()
        .prepare('UPDATE forwarding_configs SET last_message_id = ? WHERE tg_channel = ?')
        .run(offset, tgChannel);
}
async function processMessage(msg, tgToken, maxToken, maxChannelId) {
    const text = msg.text || msg.caption || '';
    if (msg.photo && msg.photo.length > 0) {
        const largest = msg.photo[msg.photo.length - 1];
        const photoUrl = await (0, telegramReader_1.getTgFileUrl)(tgToken, largest.file_id);
        if (photoUrl) {
            await (0, maxPublisher_1.sendPhotoToMax)(maxToken, maxChannelId, photoUrl, text);
            return;
        }
    }
    if (text) {
        await (0, maxPublisher_1.sendTextToMax)(maxToken, maxChannelId, text);
    }
}
async function runForwarderOnce(tgToken, maxToken) {
    const configs = (0, database_1.getDb)()
        .prepare('SELECT * FROM forwarding_configs WHERE is_active = 1')
        .all();
    for (const config of configs) {
        try {
            const offset = getLastOffset(config.tg_channel);
            const messages = await (0, telegramReader_1.getTgUpdates)(tgToken, offset);
            const channelMessages = messages.filter((m) => {
                const chatUsername = m.chat.username ? `@${m.chat.username}` : String(m.chat.id);
                return chatUsername === config.tg_channel || String(m.chat.id) === config.tg_channel;
            });
            for (const msg of channelMessages) {
                if (isAlreadySent(config.tg_channel, msg.message_id))
                    continue;
                await processMessage(msg, tgToken, maxToken, config.max_channel_id);
                markSent(config.tg_channel, msg.message_id);
                saveOffset(config.tg_channel, msg.message_id + 1);
                await sleep(2000 + Math.random() * 3000);
            }
        }
        catch (err) {
            console.error(`[Forwarder] Error processing config ${config.id}:`, err);
        }
    }
}
function startForwarderLoop(tgToken, maxToken) {
    if (!tgToken) {
        console.log('[Forwarder] TG_READER_BOT_TOKEN not set, forwarding disabled');
        return;
    }
    console.log('[Forwarder] ✅ Started');
    const loop = async () => {
        while (true) {
            try {
                await runForwarderOnce(tgToken, maxToken);
            }
            catch (err) {
                console.error('[Forwarder] Loop error:', err);
            }
            await sleep(30_000);
        }
    };
    void loop();
}
//# sourceMappingURL=forwarderService.js.map