/**
 * Типы апдейтов для webhook и long polling: базовые + события участия бота в чатах.
 */
export declare const BOT_WEBHOOK_UPDATE_TYPES: readonly ["bot_started", "message_created", "message_callback", "bot_added", "bot_removed", "user_added", "user_removed"];
export interface SetWebhookOptions {
    token: string;
    url: string;
    secret?: string;
    updateTypes?: readonly string[];
}
export declare function setWebhookSubscription(options: SetWebhookOptions): Promise<void>;
export declare function deleteWebhookSubscription(token: string, webhookUrl: string): Promise<void>;
