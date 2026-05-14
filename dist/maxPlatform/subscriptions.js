"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOT_WEBHOOK_UPDATE_TYPES = void 0;
exports.setWebhookSubscription = setWebhookSubscription;
exports.deleteWebhookSubscription = deleteWebhookSubscription;
const PLATFORM_API = 'https://platform-api.max.ru';
/**
 * Типы апдейтов для webhook и long polling: базовые + события участия бота в чатах.
 */
exports.BOT_WEBHOOK_UPDATE_TYPES = [
    'bot_started',
    'message_created',
    'message_callback',
    'bot_added',
    'bot_removed',
    'user_added',
    'user_removed',
];
const DEFAULT_UPDATE_TYPES = exports.BOT_WEBHOOK_UPDATE_TYPES;
async function setWebhookSubscription(options) {
    const body = {
        url: options.url,
        update_types: options.updateTypes ?? [...DEFAULT_UPDATE_TYPES],
    };
    if (options.secret) {
        body.secret = options.secret;
    }
    const res = await fetch(`${PLATFORM_API}/subscriptions`, {
        method: 'POST',
        headers: {
            Authorization: options.token,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
        throw new Error(`POST /subscriptions: HTTP ${res.status} — ${raw}`);
    }
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        throw new Error(`POST /subscriptions: невалидный JSON в ответе — ${raw}`);
    }
    if (data.success === false) {
        throw new Error(data.message ?? 'POST /subscriptions: success=false');
    }
}
async function deleteWebhookSubscription(token, webhookUrl) {
    const u = new URL(`${PLATFORM_API}/subscriptions`);
    u.searchParams.set('url', webhookUrl);
    const res = await fetch(u.href, {
        method: 'DELETE',
        headers: { Authorization: token },
    });
    const raw = await res.text();
    if (!res.ok) {
        throw new Error(`DELETE /subscriptions: HTTP ${res.status} — ${raw}`);
    }
    if (raw.trim() === '') {
        return;
    }
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        throw new Error(`DELETE /subscriptions: невалидный JSON в ответе — ${raw}`);
    }
    if (data.success === false) {
        throw new Error(data.message ?? 'DELETE /subscriptions: success=false');
    }
}
//# sourceMappingURL=subscriptions.js.map